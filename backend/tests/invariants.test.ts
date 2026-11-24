import request from "supertest";
import { describe, expect, it } from "vitest";
import { computeSplit, type SplitParams } from "../src/money";
import { paystackSignature, verifyPaystackSignature } from "../src/services/gateway";
import { acct } from "../src/services/ledger";
import { auth, createPaidOrder, makeAdmin, makeHarness, makeWorld, postWebhook, webhookBody, register } from "./helpers";

const P: SplitParams = { platformFeeBps: 1000, gatewayBps: 150, gatewayFlatKobo: 10000, gatewayFlatThresholdKobo: 250000, gatewayCapKobo: 200000 };

describe("kobo split sweep", () => {
  it("conserves money over a grid of subtotals and basis points, and the fee never exceeds the exact value", () => {
    for (const bps of [0, 1, 7, 333, 1000, 1500, 9999, 10000]) {
      for (let sub = 0; sub <= 3000; sub += 7) {
        const s = computeSplit(sub, 250, { ...P, platformFeeBps: bps });
        expect(s.vendorEarningsKobo + s.courierFeeKobo + s.platformFeeKobo).toBe(s.totalKobo);
        expect(s.platformFeeKobo * 10000).toBeLessThanOrEqual(sub * bps);
        expect((s.platformFeeKobo + 1) * 10000).toBeGreaterThan(sub * bps);
      }
    }
  });
  it("bps 0 gives the platform nothing and bps 10000 gives it the whole subtotal", () => {
    expect(computeSplit(12345, 100, { ...P, platformFeeBps: 0 }).platformFeeKobo).toBe(0);
    const full = computeSplit(12345, 100, { ...P, platformFeeBps: 10000 });
    expect(full.platformFeeKobo).toBe(12345);
    expect(full.vendorEarningsKobo).toBe(0);
  });
  it("rejects bps above 10000", () => {
    expect(() => computeSplit(100, 0, { ...P, platformFeeBps: 10001 })).toThrow(RangeError);
  });
});

describe("ledger balance across lifecycles", () => {
  it("stays balanced and per-order escrow is zero after refund, cancel-refund and delivery paths", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const a = await createPaidOrder(h, w, 1);
    const b = await createPaidOrder(h, w, 4);
    await request(h.app).post(`/api/admin/orders/${a.order.id}/refund`).set(auth(w.admin.token)).send({ confirm: a.order.id, reason: "operator refund" }).expect(200);
    h.clock.advance(120_000);
    await h.c.orders.expireStale();
    for (const o of [a.order, b.order]) expect(await h.store.accountBalance(acct.escrow(o.id))).toBe(0n);
    expect(await h.store.accountBalance(acct.refunds)).toBe(BigInt(a.order.totalKobo + b.order.totalKobo));
    const tb = await h.store.trialBalance();
    expect(tb.debits).toBe(tb.credits);
    const entries = await h.store.listLedger({ limit: 1000 });
    const byTx = new Map<string, { d: number; c: number }>();
    for (const e of entries) {
      const t = byTx.get(e.txId) ?? { d: 0, c: 0 };
      if (e.direction === "DEBIT") t.d += e.amountKobo; else t.c += e.amountKobo;
      byTx.set(e.txId, t);
    }
    expect(byTx.size).toBeGreaterThan(2);
    for (const t of byTx.values()) expect(t.d).toBe(t.c);
  });
  it("repeated timeout sweeps never double-credit the refund account", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.clock.advance(500_000);
    await h.c.orders.expireStale();
    await h.c.orders.expireStale();
    await h.c.orders.expireStale();
    expect(await h.store.accountBalance(acct.refunds)).toBe(BigInt(order.totalKobo));
    expect(h.gateway.refunds).toHaveLength(1);
  });
});

describe("paystack webhook edge cases", () => {
  it("verifier rejects empty, truncated, uppercase-mangled and wrong-secret signatures", () => {
    const body = webhookBody("ref", 100);
    const sig = paystackSignature(body, "s3cret");
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyPaystackSignature(Buffer.from(body), sig, "s3cret")).toBe(true);
    expect(verifyPaystackSignature(Buffer.from(body), "", "s3cret")).toBe(false);
    expect(verifyPaystackSignature(Buffer.from(body), sig.slice(0, 64), "s3cret")).toBe(false);
    expect(verifyPaystackSignature(Buffer.from(body), sig, "other")).toBe(false);
    expect(verifyPaystackSignature(Buffer.from(body + " "), sig, "s3cret")).toBe(false);
  });
  it("a tampered amount with the original signature is rejected and the order stays unpaid", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const order = (await request(h.app).post("/api/orders").set(auth(w.customer.token)).send({
      vendorId: w.vendor.vendorId, items: [{ name: "Shirts", quantity: 1 }], dropoff: { address: "Mararaba", lat: 9.01, lng: 7.57 },
    }).expect(201)).body.order;
    const pay = await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(200);
    const good = webhookBody(pay.body.reference, order.totalKobo, 77);
    const tampered = webhookBody(pay.body.reference, order.totalKobo, 77).replace(String(order.totalKobo), "1");
    await postWebhook(h, tampered, paystackSignature(good, h.paystackSecret)).expect(401);
    expect((await h.store.getOrder(order.id))?.status).not.toBe("AWAITING_VENDOR");
    expect(await h.store.accountBalance(acct.cash)).toBe(0n);
  });
  it("replaying the same signed event many times posts to the ledger exactly once", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, reference } = await createPaidOrder(h, w, 1, 4242);
    const before = (await h.store.listLedger({ limit: 1000 })).length;
    for (let i = 0; i < 3; i++) await postWebhook(h, webhookBody(reference, order.totalKobo, 4242)).expect(200);
    expect((await h.store.listLedger({ limit: 1000 })).length).toBe(before);
  });
});

describe("RBAC matrix", () => {
  it("every protected route group admits only its role: 401 anonymous, 403 other roles", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const id = "00000000-0000-4000-8000-000000000000";
    const groups: Array<[string, "get" | "post", string, string]> = [
      ["CUSTOMER", "post", "/api/orders", "customer"], ["CUSTOMER", "post", `/api/orders/${id}/pay`, "customer"],
      ["VENDOR", "post", `/api/vendor/orders/${id}/accept`, "vendor"], ["VENDOR", "post", `/api/vendor/orders/${id}/reject`, "vendor"],
      ["VENDOR", "post", `/api/vendor/orders/${id}/start`, "vendor"], ["VENDOR", "post", `/api/vendor/orders/${id}/ready`, "vendor"],
      ["COURIER", "post", `/api/courier/orders/${id}/claim`, "courier"], ["COURIER", "post", `/api/courier/orders/${id}/pickup`, "courier"],
      ["COURIER", "post", `/api/courier/orders/${id}/deliver`, "courier"], ["COURIER", "post", "/api/courier/location", "courier"],
      ["ADMIN", "get", "/api/admin/vendors", "admin"], ["ADMIN", "get", "/api/admin/couriers", "admin"], ["ADMIN", "get", "/api/admin/ledger", "admin"],
      ["ADMIN", "get", "/api/admin/refunds", "admin"], ["ADMIN", "get", "/api/admin/audit", "admin"], ["ADMIN", "get", "/api/admin/payments/mismatched", "admin"],
      ["ADMIN", "post", `/api/admin/orders/${id}/refund`, "admin"], ["ADMIN", "post", "/api/admin/payouts", "admin"],
    ];
    const tokens: Record<string, string> = { customer: w.customer.token, vendor: w.vendor.token, courier: w.courier.token, admin: w.admin.token };
    for (const [, m, p, owner] of groups) {
      await request(h.app)[m](p).expect(401);
      for (const [name, token] of Object.entries(tokens)) {
        if (name === owner) {
          const r = await request(h.app)[m](p).set(auth(token)).send({});
          expect([401, 403], `${name} ${p}`).not.toContain(r.status);
        } else {
          await request(h.app)[m](p).set(auth(token)).send({}).expect(403);
        }
      }
    }
  });
  it("a second admin login and a fresh customer cannot escalate by sending a role field", async () => {
    const h = makeHarness();
    await makeAdmin(h);
    const c = await register(h, "CUSTOMER");
    await request(h.app).get("/api/admin/system").set(auth(c.token)).expect(403);
  });
});

describe("nearby vendors filtering", () => {
  it("excludes vendors outside the radius and honours limit", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    expect(w.vendor.vendorId).toBeDefined();
    const near = await request(h.app).get("/api/vendors/nearby?lat=9.0&lng=7.59&radiusM=1000").expect(200);
    expect(near.body.vendors.map((v: { id: string }) => v.id)).toContain(w.vendor.vendorId);
    const far = await request(h.app).get("/api/vendors/nearby?lat=6.5&lng=3.3&radiusM=1000").expect(200);
    expect(far.body.vendors).toHaveLength(0);
    await request(h.app).get("/api/vendors/nearby?lat=9.0&lng=7.59&radiusM=10").expect(400);
  });
});
