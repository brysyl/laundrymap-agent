import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { ZodError, z } from "zod";
import type { Container } from "../container";
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from "../errors";
import { acct, payoutLines, post } from "../services/ledger";
import type { Role, User } from "../types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res).catch(next);
};

const uuid = z.string().uuid();
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const idParam = (req: Request) => uuid.parse(req.params.id);
const publicUser = (u: User) => ({ id: u.id, email: u.email, phone: u.phone, name: u.name, role: u.role, status: u.status });

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(120),
  phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, "invalid phone"),
  password: z.string().min(10).max(128),
  role: z.enum(["CUSTOMER", "VENDOR", "COURIER"]),
  vendor: z.object({
    name: z.string().trim().min(2).max(100),
    address: z.string().trim().min(3).max(200),
    lat, lng,
    unitPriceKobo: z.number().int().positive().max(100_000_000),
  }).optional(),
});
const loginSchema = z.object({ identifier: z.string().min(3).max(120), password: z.string().min(1).max(128) });
const createOrderSchema = z.object({
  vendorId: uuid,
  items: z.array(z.object({ name: z.string().trim().min(1).max(80), quantity: z.number().int().min(1).max(100) })).min(1).max(30),
  dropoff: z.object({ address: z.string().trim().min(3).max(200), lat, lng }),
});
const nearbySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(100).max(50_000).default(5000),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function createApp(c: Container): express.Express {
  const app = express();
  const { config, logger } = c;
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(pinoHttp({ logger, genReqId: () => randomUUID(), autoLogging: { ignore: (r) => r.url === "/health" } }));
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin) ? true : false),
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/health", (_req, res) => { res.json({ status: "ok" }); });
  app.get("/ready", wrap(async (_req, res) => {
    try {
      await Promise.all([c.store.ping(), c.cache.ping()]);
      res.json({ status: "ready" });
    } catch (err) {
      logger.error({ err }, "readiness check failed");
      res.status(503).json({ status: "unavailable" });
    }
  }));

  // Webhook needs the raw bytes for HMAC verification, so it is mounted before express.json().
  app.post("/api/webhooks/paystack", express.raw({ type: "*/*", limit: "256kb" }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw badRequest("invalid_body");
    const outcome = await c.payments.handleWebhook(req.body, req.header("x-paystack-signature"));
    res.status(200).json({ received: true, outcome });
  }));

  app.use(express.json({ limit: "50kb" }));
  app.use(rateLimit({ windowMs: 60_000, limit: config.rateLimitMax, standardHeaders: true, legacyHeaders: false }));
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: config.authRateLimitMax, standardHeaders: true, legacyHeaders: false });

  const authenticate: RequestHandler = (req, _res, next) => {
    const h = req.header("authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m || !m[1]) return next(unauthorized());
    c.auth.authenticate(m[1]).then((u) => { req.user = u; next(); }, next);
  };
  const requireRole = (...roles: Role[]): RequestHandler => (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden("Insufficient role"));
    next();
  };
  const me = (req: Request): User => {
    if (!req.user) throw unauthorized();
    return req.user;
  };

  // ---------- auth ----------
  app.post("/api/auth/register", authLimiter, wrap(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const r = await c.auth.register(input);
    res.status(201).json({ user: publicUser(r.user), token: c.auth.signToken(r.user), vendor: r.vendor, courier: r.courier });
  }));
  app.post("/api/auth/login", authLimiter, wrap(async (req, res) => {
    const { identifier, password } = loginSchema.parse(req.body);
    const { user, token } = await c.auth.login(identifier, password);
    res.json({ user: publicUser(user), token });
  }));
  app.get("/api/me", authenticate, wrap(async (req, res) => {
    const u = me(req);
    const vendor = u.role === "VENDOR" ? await c.store.getVendorByOwner(u.id) : null;
    const courier = u.role === "COURIER" ? await c.store.getCourierByUser(u.id) : null;
    res.json({ user: publicUser(u), vendor, courier });
  }));

  // ---------- public discovery ----------
  app.get("/api/vendors/nearby", wrap(async (req, res) => {
    const q = nearbySchema.parse(req.query);
    const vendors = await c.store.nearbyVendors(q.lat, q.lng, q.radiusM, q.limit);
    res.json({ vendors: vendors.map((v) => ({
      id: v.id, name: v.name, address: v.address, lat: v.lat, lng: v.lng, unitPriceKobo: v.unitPriceKobo, distanceM: Math.round(v.distanceM),
    })) });
  }));

  // ---------- orders (all roles, ownership enforced in the service) ----------
  app.get("/api/me/orders", authenticate, wrap(async (req, res) => {
    res.json({ orders: await c.orders.listFor(me(req)), serverTime: c.clock.now().toISOString() });
  }));
  app.post("/api/orders", authenticate, requireRole("CUSTOMER"), wrap(async (req, res) => {
    const order = await c.orders.create(me(req), createOrderSchema.parse(req.body));
    res.status(201).json({ order });
  }));
  app.get("/api/orders/:id", authenticate, wrap(async (req, res) => {
    res.json({ order: await c.orders.getFor(me(req), idParam(req)) });
  }));
  app.get("/api/orders/:id/sync", authenticate, wrap(async (req, res) => {
    res.json(await c.orders.sync(me(req), idParam(req)));
  }));
  app.post("/api/orders/:id/pay", authenticate, requireRole("CUSTOMER"), wrap(async (req, res) => {
    res.json(await c.orders.initializePayment(me(req), idParam(req)));
  }));
  app.post("/api/orders/:id/cancel", authenticate, requireRole("CUSTOMER"), wrap(async (req, res) => {
    res.json({ order: await c.orders.cancel(me(req), idParam(req)) });
  }));
  app.get("/api/orders/:id/delivery-code", authenticate, requireRole("CUSTOMER"), wrap(async (req, res) => {
    res.json({ code: await c.orders.deliveryCodeFor(me(req), idParam(req)) });
  }));

  // ---------- vendor ----------
  const vendorOnly = [authenticate, requireRole("VENDOR")];
  app.post("/api/vendor/orders/:id/accept", ...vendorOnly, wrap(async (req, res) => { res.json({ order: await c.orders.vendorAccept(me(req), idParam(req)) }); }));
  app.post("/api/vendor/orders/:id/reject", ...vendorOnly, wrap(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(2).max(200).default("vendor unavailable") }).parse(req.body ?? {});
    res.json({ order: await c.orders.vendorReject(me(req), idParam(req), reason) });
  }));
  app.post("/api/vendor/orders/:id/start", ...vendorOnly, wrap(async (req, res) => { res.json({ order: await c.orders.vendorStart(me(req), idParam(req)) }); }));
  app.post("/api/vendor/orders/:id/ready", ...vendorOnly, wrap(async (req, res) => { res.json({ order: await c.orders.vendorReady(me(req), idParam(req)) }); }));

  // ---------- courier ----------
  const courierOnly = [authenticate, requireRole("COURIER")];
  app.post("/api/courier/orders/:id/claim", ...courierOnly, wrap(async (req, res) => { res.json({ order: await c.orders.courierClaim(me(req), idParam(req)) }); }));
  app.post("/api/courier/orders/:id/pickup", ...courierOnly, wrap(async (req, res) => { res.json({ order: await c.orders.courierPickup(me(req), idParam(req)) }); }));
  app.post("/api/courier/orders/:id/deliver", ...courierOnly, wrap(async (req, res) => {
    const { otp } = z.object({ otp: z.string().regex(/^[0-9]{6}$/) }).parse(req.body);
    res.json({ order: await c.orders.courierDeliver(me(req), idParam(req), otp) });
  }));
  app.post("/api/courier/location", ...courierOnly, wrap(async (req, res) => {
    const b = z.object({ lat, lng }).parse(req.body);
    const r = await c.orders.courierLocation(me(req), b.lat, b.lng);
    res.status(r.accepted ? 200 : 202).json(r);
  }));

  // ---------- admin ----------
  const adminOnly = [authenticate, requireRole("ADMIN")];
  const audit = (actor: User, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) =>
    c.store.addAudit({ id: randomUUID(), actorId: actor.id, action, entityType, entityId, metadata, createdAt: c.clock.now() });
  const statusParam = z.enum(["PENDING", "APPROVED", "SUSPENDED"]).optional();

  app.get("/api/admin/vendors", ...adminOnly, wrap(async (req, res) => {
    res.json({ vendors: await c.store.listVendors(statusParam.parse(req.query.status)) });
  }));
  app.get("/api/admin/couriers", ...adminOnly, wrap(async (req, res) => {
    res.json({ couriers: await c.store.listCouriers(statusParam.parse(req.query.status)) });
  }));
  for (const [action, status] of [["approve", "APPROVED"], ["suspend", "SUSPENDED"]] as const) {
    app.post(`/api/admin/vendors/:id/${action}`, ...adminOnly, wrap(async (req, res) => {
      const v = await c.store.setVendorStatus(idParam(req), status);
      if (!v) throw notFound("Vendor");
      await audit(me(req), `vendor.${action}`, "vendor", v.id);
      res.json({ vendor: v });
    }));
    app.post(`/api/admin/couriers/:id/${action}`, ...adminOnly, wrap(async (req, res) => {
      const co = await c.store.setCourierStatus(idParam(req), status);
      if (!co) throw notFound("Courier");
      await audit(me(req), `courier.${action}`, "courier", co.id);
      res.json({ courier: co });
    }));
  }
  app.post("/api/admin/orders/:id/refund", ...adminOnly, wrap(async (req, res) => {
    const b = z.object({ confirm: z.string(), reason: z.string().trim().min(5).max(300) }).parse(req.body);
    res.json({ order: await c.orders.adminRefund(me(req), idParam(req), b) });
  }));
  app.get("/api/admin/ledger", ...adminOnly, wrap(async (req, res) => {
    const q = z.object({ orderId: uuid.optional(), account: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    const tb = await c.store.trialBalance();
    res.json({ entries: await c.store.listLedger(q), trialBalance: { debitsKobo: tb.debits.toString(), creditsKobo: tb.credits.toString(), balanced: tb.debits === tb.credits } });
  }));
  app.get("/api/admin/refunds", ...adminOnly, wrap(async (_req, res) => { res.json({ refunds: await c.store.listRefunds(200) }); }));
  app.get("/api/admin/audit", ...adminOnly, wrap(async (_req, res) => { res.json({ audit: await c.store.listAudit(200) }); }));
  app.get("/api/admin/system", ...adminOnly, wrap(async (_req, res) => {
    const tb = await c.store.trialBalance();
    res.json({
      env: config.env,
      counts: await c.store.counts(),
      ledger: { debitsKobo: tb.debits.toString(), creditsKobo: tb.credits.toString(), balanced: tb.debits === tb.credits },
      revenueKobo: (await c.store.accountBalance(acct.revenue)).toString(),
      config: { platformFeeBps: config.platformFeeBps, deliveryFeeKobo: config.deliveryFeeKobo, vendorAcceptTimeoutMs: config.vendorAcceptTimeoutMs },
      serverTime: c.clock.now().toISOString(),
    });
  }));
  app.post("/api/admin/payouts", ...adminOnly, wrap(async (req, res) => {
    const b = z.object({ kind: z.enum(["VENDOR", "COURIER"]), ownerId: uuid, amountKobo: z.number().int().positive() }).parse(req.body);
    const account = b.kind === "VENDOR" ? acct.vendor(b.ownerId) : acct.courier(b.ownerId);
    const admin = me(req);
    await c.store.tx(async (s) => {
      const balance = await s.accountBalance(account);
      if (balance < BigInt(b.amountKobo)) throw conflict("insufficient_balance", "Payable balance is lower than the payout amount");
      await post(s, null, payoutLines(account, b.amountKobo), c.clock.now());
      await s.addAudit({ id: randomUUID(), actorId: admin.id, action: "payout.create", entityType: b.kind.toLowerCase(), entityId: b.ownerId, metadata: { amountKobo: b.amountKobo }, createdAt: c.clock.now() });
    });
    res.status(201).json({ ok: true });
  }));

  app.use((_req, _res, next) => next(notFound("Route")));
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation_error", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e.type === "entity.parse.failed") { res.status(400).json({ error: "invalid_json" }); return; }
    if (e.type === "entity.too.large") { res.status(413).json({ error: "payload_too_large" }); return; }
    req.log.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal_error" });
  });
  return app;
}
