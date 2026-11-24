import request from "supertest";
import { describe, expect, it } from "vitest";
import { computeSplit } from "../src/money";
import { acct, assertBalanced } from "../src/services/ledger";
import { auth, createPaidOrder, makeHarness, makeWorld } from "./helpers";

describe("full multi-role lifecycle", () => {
  it("customer orders, pays, vendor processes, courier delivers with OTP, ledger settles exactly", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w, 3);
    const v = auth(w.vendor.token), c = auth(w.courier.token), cu = auth(w.customer.token);

    expect(order.subtotalKobo).toBe(3 * 120000);
    expect(order.totalKobo).toBe(3 * 120000 + 100000);

    // Couriers see the order only once it is ready.
    expect((await request(h.app).get("/api/me/orders").set(c).expect(200)).body.orders).toHaveLength(0);
    await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(v).expect(200);
    await request(h.app).post(`/api/vendor/orders/${order.id}/start`).set(v).expect(200);
    await request(h.app).post(`/api/vendor/orders/${order.id}/ready`).set(v).expect(200);
    expect((await request(h.app).get("/api/me/orders").set(c).expect(200)).body.orders).toHaveLength(1);

    await request(h.app).post(`/api/courier/orders/${order.id}/claim`).set(c).expect(200);
    await request(h.app).post(`/api/courier/orders/${order.id}/pickup`).set(c).expect(200);
    const code = (await request(h.app).get(`/api/orders/${order.id}/delivery-code`).set(cu).expect(200)).body.code;
    await request(h.app).post(`/api/courier/orders/${order.id}/deliver`).set(c).send({ otp: code }).expect(200);

    const split = computeSplit(order.subtotalKobo, 100000, {
      platformFeeBps: h.config.platformFeeBps, gatewayBps: h.config.gatewayBps, gatewayFlatKobo: h.config.gatewayFlatKobo,
      gatewayFlatThresholdKobo: h.config.gatewayFlatThresholdKobo, gatewayCapKobo: h.config.gatewayCapKobo,
    });
    expect(await h.store.accountBalance(acct.vendor(w.vendor.vendorId!))).toBe(BigInt(split.vendorEarningsKobo));
    expect(await h.store.accountBalance(acct.courier(w.courier.id))).toBe(BigInt(split.courierFeeKobo));
    expect(await h.store.accountBalance(acct.revenue)).toBe(BigInt(split.platformFeeKobo));
    expect(await h.store.accountBalance(acct.escrow(order.id))).toBe(0n);
    expect(await h.store.accountBalance(acct.gatewayPayable)).toBe(BigInt(split.gatewayFeeKobo));
    const tb = await h.store.trialBalance();
    expect(tb.debits).toBe(tb.credits);
    expect(tb.debits > 0n).toBe(true);

    // Admin views.
    const ledger = await request(h.app).get(`/api/admin/ledger?orderId=${order.id}`).set(auth(w.admin.token)).expect(200);
    expect(ledger.body.trialBalance.balanced).toBe(true);
    const types = new Set(ledger.body.entries.map((e: { type: string }) => e.type));
    for (const t of ["ORDER_PAYMENT", "PLATFORM_FEE", "VENDOR_EARNINGS", "COURIER_FEE", "GATEWAY_FEE"]) expect(types.has(t)).toBe(true);
    const sys = await request(h.app).get("/api/admin/system").set(auth(w.admin.token)).expect(200);
    expect(sys.body.ledger.balanced).toBe(true);
    expect(sys.body.counts.ordersByStatus.DELIVERED).toBe(1);

    // Payout cannot exceed the payable balance, and is a balanced PAYOUT posting.
    await request(h.app).post("/api/admin/payouts").set(auth(w.admin.token))
      .send({ kind: "VENDOR", ownerId: w.vendor.vendorId, amountKobo: split.vendorEarningsKobo + 1 }).expect(409);
    await request(h.app).post("/api/admin/payouts").set(auth(w.admin.token))
      .send({ kind: "VENDOR", ownerId: w.vendor.vendorId, amountKobo: split.vendorEarningsKobo }).expect(201);
    expect(await h.store.accountBalance(acct.vendor(w.vendor.vendorId!))).toBe(0n);
  });

  it("rejects illegal state transitions", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    const v = auth(w.vendor.token);
    await request(h.app).post(`/api/vendor/orders/${order.id}/ready`).set(v).expect(409); // skipped accept/start
    await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(v).expect(200);
    await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(v).expect(409);
    await request(h.app).post(`/api/courier/orders/${order.id}/claim`).set(auth(w.courier.token)).expect(409);
  });

  it("only one of two racing couriers wins the claim", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { register } = await import("./helpers");
    const second = await register(h, "COURIER");
    await request(h.app).post(`/api/admin/couriers/${second.courierId}/approve`).set(auth(w.admin.token)).expect(200);
    const { order } = await createPaidOrder(h, w);
    const v = auth(w.vendor.token);
    for (const a of ["accept", "start", "ready"]) await request(h.app).post(`/api/vendor/orders/${order.id}/${a}`).set(v).expect(200);
    const results = await Promise.all([
      request(h.app).post(`/api/courier/orders/${order.id}/claim`).set(auth(w.courier.token)),
      request(h.app).post(`/api/courier/orders/${order.id}/claim`).set(auth(second.token)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("vendor rejection refunds the full payment", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    await request(h.app).post(`/api/vendor/orders/${order.id}/reject`).set(auth(w.vendor.token)).send({ reason: "closed today" }).expect(200);
    expect((await h.store.getOrder(order.id))?.status).toBe("REFUNDED");
    expect(await h.store.accountBalance(acct.escrow(order.id))).toBe(0n);
    expect(await h.store.accountBalance(acct.refunds)).toBe(BigInt(order.totalKobo));
  });

  it("admin refund requires operator confirmation, writes an audit log and refuses delivered orders", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    const a = auth(w.admin.token);
    await request(h.app).post(`/api/admin/orders/${order.id}/refund`).set(a).send({ reason: "customer request" }).expect(400);
    await request(h.app).post(`/api/admin/orders/${order.id}/refund`).set(a).send({ confirm: "yes", reason: "customer request" }).expect(400);
    expect((await h.store.getOrder(order.id))?.status).toBe("AWAITING_VENDOR");
    await request(h.app).post(`/api/admin/orders/${order.id}/refund`).set(a).send({ confirm: order.id, reason: "customer request" }).expect(200);
    expect((await h.store.getOrder(order.id))?.status).toBe("REFUNDED");
    const audit = await h.store.listAudit(10);
    const entry = audit.find((x) => x.action === "order.refund.admin");
    expect(entry?.actorId).toBe(w.admin.id);
    expect(entry?.metadata.reason).toBe("customer request");
    expect(h.gateway.refunds).toEqual([{ reference: expect.any(String), amountKobo: order.totalKobo }]);
    await request(h.app).post(`/api/admin/orders/${order.id}/refund`).set(a).send({ confirm: order.id, reason: "second try" }).expect(409);
  });

  it("a failed gateway refund submission keeps the ledger entry and marks the refund FAILED", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.gateway.failRefunds = true;
    await request(h.app).post(`/api/admin/orders/${order.id}/refund`).set(auth(w.admin.token)).send({ confirm: order.id, reason: "customer request" }).expect(200);
    expect((await h.store.getRefundByOrder(order.id))?.status).toBe("FAILED");
    expect(await h.store.accountBalance(acct.refunds)).toBe(BigInt(order.totalKobo));
  });

  it("courier location updates are throttled and only broadcast to the order's rooms", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    const v = auth(w.vendor.token), c = auth(w.courier.token);
    for (const a of ["accept", "start", "ready"]) await request(h.app).post(`/api/vendor/orders/${order.id}/${a}`).set(v).expect(200);
    await request(h.app).post(`/api/courier/orders/${order.id}/claim`).set(c).expect(200);
    h.messages.length = 0;
    await request(h.app).post("/api/courier/location").set(c).send({ lat: 9.0, lng: 7.6 }).expect(200);
    await request(h.app).post("/api/courier/location").set(c).send({ lat: 9.1, lng: 7.6 }).expect(202);
    expect(h.messages.filter((m) => m.event === "courier:location")).toHaveLength(1);
    h.clock.advance(5001);
    await request(h.app).post("/api/courier/location").set(c).send({ lat: 9.1, lng: 7.6 }).expect(200);
    await request(h.app).post("/api/courier/location").set(c).send({ lat: 200, lng: 7.6 }).expect(400);
  });

  it("reconnect sync endpoints return current state", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    const sync = await request(h.app).get(`/api/orders/${order.id}/sync`).set(auth(w.customer.token)).expect(200);
    expect(sync.body.order.status).toBe("AWAITING_VENDOR");
    expect(sync.body.order.version).toBeGreaterThan(1);
    expect(sync.body.payment.status).toBe("PAID");
    expect(typeof sync.body.serverTime).toBe("string");
    const mine = await request(h.app).get("/api/me/orders").set(auth(w.customer.token)).expect(200);
    expect(mine.body.orders.map((o: { id: string }) => o.id)).toEqual([order.id]);
  });
});

describe("ledger invariants", () => {
  it("rejects unbalanced or non-positive postings", () => {
    expect(() => assertBalanced([
      { account: "a", direction: "DEBIT", amountKobo: 100, type: "PAYOUT", memo: "" },
      { account: "b", direction: "CREDIT", amountKobo: 99, type: "PAYOUT", memo: "" },
    ])).toThrow(/unbalanced/);
    expect(() => assertBalanced([
      { account: "a", direction: "DEBIT", amountKobo: 0, type: "PAYOUT", memo: "" },
      { account: "b", direction: "CREDIT", amountKobo: 0, type: "PAYOUT", memo: "" },
    ])).toThrow();
    expect(() => assertBalanced([
      { account: "a", direction: "DEBIT", amountKobo: 1.5, type: "PAYOUT", memo: "" },
      { account: "b", direction: "CREDIT", amountKobo: 1.5, type: "PAYOUT", memo: "" },
    ])).toThrow();
  });

  it("the memory store exposes no ledger update or delete", async () => {
    const { MemoryStore } = await import("../src/store/memory");
    const s = new MemoryStore() as unknown as Record<string, unknown>;
    expect(Object.keys(Object.getOwnPropertyNames(Object.getPrototypeOf(s)).filter((n) => /ledger/i.test(n)))).toHaveLength(2);
    expect(s.updateLedger).toBeUndefined();
    expect(s.deleteLedger).toBeUndefined();
  });
});
