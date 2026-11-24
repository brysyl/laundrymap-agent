import type { AddressInfo } from "node:net";
import { createServer, type Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { io as connect, type Socket } from "socket.io-client";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCache } from "../src/cache/cache";
import { buildContainer } from "../src/container";
import { createApp } from "../src/http/app";
import { createLogger } from "../src/logger";
import { createRealtime } from "../src/realtime/socket";
import { acct, post } from "../src/services/ledger";
import { startWorker } from "../src/worker";
import { auth, createOrder, createPaidOrder, makeHarness, makeWorld, postWebhook, webhookBody, type Harness, type World } from "./helpers";

const sockets: Socket[] = [];
let server: HttpServer | undefined;
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function boot(): Promise<{ h: Harness; w: World; url: string }> {
  const base = makeHarness();
  const rt = createRealtime();
  const c = buildContainer({ ...base.c, publish: rt.publish, cache: new MemoryCache(base.clock), logger: createLogger("silent") });
  const h: Harness = { ...base, c, app: createApp(c) };
  server = createServer(h.app);
  rt.attach(server, c);
  await new Promise<void>((r) => server!.listen(0, r));
  return { h, w: await makeWorld(h), url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` };
}
function open(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(url, { auth: { token }, transports: ["websocket"], reconnection: false });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}
const disconnected = (s: Socket, ms = 3000) =>
  new Promise<string | null>((r) => { s.once("disconnect", (reason) => r(reason)); setTimeout(() => r(null), ms); });
const quiet = (s: Socket, event: string, ms = 200) => new Promise<boolean>((r) => { let got = false; s.on(event, () => { got = true; }); setTimeout(() => r(!got), ms); });

describe("refund retry", () => {
  it("re-submits a FAILED refund once the gateway recovers and the minimum age has passed", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, reference } = await createPaidOrder(h, w);
    h.gateway.failRefunds = true;
    h.clock.advance(120_000);
    await h.c.orders.expireStale();
    expect((await h.store.getRefundByOrder(order.id))?.status).toBe("FAILED");

    h.gateway.failRefunds = false;
    expect(await h.c.orders.retryRefunds()).toBe(0); // too young
    h.clock.advance(h.config.refundRetryMinAgeMs);
    expect(await h.c.orders.retryRefunds()).toBe(1);
    expect(await h.store.getRefundByOrder(order.id)).toMatchObject({ status: "SUBMITTED", gatewayRef: `rf_${reference}` });
    expect(h.gateway.refunds).toEqual([{ reference, amountKobo: order.totalKobo }]);
    expect(await h.c.orders.retryRefunds()).toBe(0); // nothing left to do
  });

  it("recovers a refund stuck in RECORDED after a crash between commit and the gateway call", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.clock.advance(120_000);
    await h.c.orders.expireStale();
    const refund = (await h.store.getRefundByOrder(order.id))!;
    await h.store.updateRefund(refund.id, { status: "RECORDED", gatewayRef: null });
    h.gateway.refunds.length = 0;
    h.clock.advance(h.config.refundRetryMinAgeMs);
    expect(await h.c.orders.retryRefunds()).toBe(1);
    expect(h.gateway.refunds).toHaveLength(1);
  });

  it("keeps a refund FAILED while the gateway is still down", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.gateway.failRefunds = true;
    h.clock.advance(120_000);
    await h.c.orders.expireStale();
    h.clock.advance(h.config.refundRetryMinAgeMs);
    expect(await h.c.orders.retryRefunds()).toBe(0);
    expect((await h.store.getRefundByOrder(order.id))?.status).toBe("FAILED");
  });

  it("is driven by the worker timer", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.gateway.failRefunds = true;
    h.clock.advance(120_000);
    await h.c.orders.expireStale();
    h.gateway.failRefunds = false;
    h.clock.advance(h.config.refundRetryMinAgeMs);
    const stop = startWorker(h.c.orders, createLogger("silent"), 10);
    try {
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      stop();
    }
    expect((await h.store.getRefundByOrder(order.id))?.status).toBe("SUBMITTED");
  });

  it("admin can retry one refund; non-admins cannot; a submitted refund cannot be retried", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.gateway.failRefunds = true;
    h.clock.advance(120_000);
    await h.c.orders.expireStale();
    h.gateway.failRefunds = false;
    const refund = (await h.store.getRefundByOrder(order.id))!;
    await request(h.app).post(`/api/admin/refunds/${refund.id}/retry`).set(auth(w.vendor.token)).expect(403);
    const res = await request(h.app).post(`/api/admin/refunds/${refund.id}/retry`).set(auth(w.admin.token)).expect(200);
    expect(res.body.refund.status).toBe("SUBMITTED");
    await request(h.app).post(`/api/admin/refunds/${refund.id}/retry`).set(auth(w.admin.token)).expect(409);
    expect((await h.store.listAudit(10)).some((a) => a.action === "refund.retry")).toBe(true);
  });
});

describe("payout serialization", () => {
  async function fund(h: Harness, w: World, amount: number) {
    await post(h.store, null, [
      { account: acct.cash, direction: "DEBIT", amountKobo: amount, type: "ORDER_PAYMENT", memo: "seed" },
      { account: acct.vendor(w.vendor.vendorId!), direction: "CREDIT", amountKobo: amount, type: "VENDOR_EARNINGS", memo: "seed" },
    ], h.clock.now());
  }

  it("takes the account lock before reading the balance", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    await fund(h, w, 10_000);
    const calls: string[] = [];
    const orig = h.store.lockAccount.bind(h.store);
    const origBal = h.store.accountBalance.bind(h.store);
    h.store.lockAccount = async (a) => { calls.push(`lock:${a}`); return orig(a); };
    h.store.accountBalance = async (a) => { calls.push(`balance:${a}`); return origBal(a); };
    await request(h.app).post("/api/admin/payouts").set(auth(w.admin.token))
      .send({ kind: "VENDOR", ownerId: w.vendor.vendorId, amountKobo: 1000 }).expect(201);
    const account = acct.vendor(w.vendor.vendorId!);
    expect(calls).toEqual([`lock:${account}`, `balance:${account}`]);
  });

  it("concurrent payouts cannot overdraw the account", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    await fund(h, w, 10_000);
    const send = () => request(h.app).post("/api/admin/payouts").set(auth(w.admin.token))
      .send({ kind: "VENDOR", ownerId: w.vendor.vendorId, amountKobo: 6000 });
    const statuses = (await Promise.all([send(), send(), send()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    expect(await h.store.accountBalance(acct.vendor(w.vendor.vendorId!))).toBe(4000n);
  });
});

describe("amount mismatch visibility", () => {
  it("lists mismatched payments for admins only and leaves the order unpaid", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const order = await createOrder(h, w);
    const pay = await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(200);
    const res = await postWebhook(h, webhookBody(pay.body.reference, order.totalKobo - 1, 777)).expect(200);
    expect(res.body.outcome).toBe("amount_mismatch");
    expect((await h.store.getOrder(order.id))?.status).toBe("PENDING_PAYMENT");

    const list = await request(h.app).get("/api/admin/payments/mismatched").set(auth(w.admin.token)).expect(200);
    expect(list.body.payments).toHaveLength(1);
    expect(list.body.payments[0]).toMatchObject({ reference: pay.body.reference, status: "MISMATCH", orderId: order.id });
    await request(h.app).get("/api/admin/payments/mismatched").set(auth(w.customer.token)).expect(403);
  });
});

describe("one pending payment per order", () => {
  it("the store rejects a second PENDING payment for the same order", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const order = await createOrder(h, w);
    await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(200);
    const dup = { id: "00000000-0000-4000-8000-0000000000aa", orderId: order.id, reference: "dup", amountKobo: order.totalKobo, status: "PENDING" as const,
      authorizationUrl: "u", gatewayTransactionId: null, paidAt: null, createdAt: h.clock.now() };
    await expect(h.store.createPayment(dup)).rejects.toMatchObject({ status: 409, code: "payment_pending" });
  });

  it("concurrent pay calls converge on one reference", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const order = await createOrder(h, w);
    const send = () => request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token));
    const rs = await Promise.all([send(), send(), send()]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(rs.map((r) => r.body.reference)).size).toBe(1);
    expect(await h.store.listPaymentsByStatus("PENDING", 10)).toHaveLength(1);
  });

  it("refunds target the PAID payment, not the newest row", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, reference } = await createPaidOrder(h, w);
    // A later non-paid row must not hijack the refund.
    await h.store.createPayment({ id: "00000000-0000-4000-8000-0000000000bb", orderId: order.id, reference: "later", amountKobo: order.totalKobo,
      status: "FAILED", authorizationUrl: null, gatewayTransactionId: null, paidAt: null, createdAt: new Date(h.clock.now().getTime() + 1000) });
    h.clock.advance(120_000);
    await h.c.orders.expireStale();
    expect(h.gateway.refunds).toEqual([{ reference, amountKobo: order.totalKobo }]);
  });
});

describe("socket authorization lifetime", () => {
  it("suspending a vendor disconnects its live sockets and stops room events", async () => {
    const { url, w, h } = await boot();
    const vendor = await open(url, w.vendor.token);
    const gone = disconnected(vendor);
    await request(h.app).post(`/api/admin/vendors/${w.vendor.vendorId}/suspend`).set(auth(w.admin.token)).expect(200);
    expect(await gone).toBe("io server disconnect");
    await expect(open(url, w.vendor.token)).resolves.toBeDefined(); // user account is active; REST and room joins still check approval
  });

  it("suspending a courier disconnects its sockets", async () => {
    const { url, w, h } = await boot();
    const courier = await open(url, w.courier.token);
    const gone = disconnected(courier);
    await request(h.app).post(`/api/admin/couriers/${w.courier.courierId}/suspend`).set(auth(w.admin.token)).expect(200);
    expect(await gone).toBe("io server disconnect");
  });

  it("approving a vendor does not disconnect anyone", async () => {
    const { url, w, h } = await boot();
    const vendor = await open(url, w.vendor.token);
    const stays = quiet(vendor, "disconnect", 300);
    await request(h.app).post(`/api/admin/vendors/${w.vendor.vendorId}/approve`).set(auth(w.admin.token)).expect(200);
    expect(await stays).toBe(true);
    expect(vendor.connected).toBe(true);
  });

  it("a suspended or pending vendor does not join the vendor room on connect", async () => {
    const { url, w, h } = await boot();
    const order = await createOrder(h, w);
    const pay = await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(200);
    await request(h.app).post(`/api/admin/vendors/${w.vendor.vendorId}/suspend`).set(auth(w.admin.token)).expect(200);
    const vendor = await open(url, w.vendor.token);
    const silent = quiet(vendor, "order:new");
    await postWebhook(h, webhookBody(pay.body.reference, order.totalKobo, 4242)).expect(200);
    expect(await silent).toBe(true);
  });

  it("disconnects the socket when its token expires", async () => {
    const { url, w, h } = await boot();
    const short = jwt.sign({ role: "CUSTOMER" }, h.config.jwtSecret, { algorithm: "HS256", subject: w.customer.id, expiresIn: 1, issuer: "laundrymap" });
    const s = await open(url, short);
    expect(await disconnected(s, 4000)).toBe("io server disconnect");
  });
});
