import request from "supertest";
import { describe, expect, it } from "vitest";
import { acct } from "../src/services/ledger";
import { auth, createPaidOrder, makeHarness, makeWorld } from "./helpers";

describe("vendor acceptance timeout (2 minutes)", () => {
  it("does not expire before the deadline", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.clock.advance(119_999);
    expect(await h.c.orders.expireStale()).toBe(0);
    expect((await h.store.getOrder(order.id))?.status).toBe("AWAITING_VENDOR");
  });

  it("expires exactly at the deadline, refunds in the ledger and submits the gateway refund", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, reference } = await createPaidOrder(h, w);
    h.clock.advance(120_000);
    expect(await h.c.orders.expireStale()).toBe(1);
    const stored = await h.store.getOrder(order.id);
    expect(stored?.status).toBe("REFUNDED");
    expect(await h.store.accountBalance(acct.escrow(order.id))).toBe(0n);
    expect(await h.store.accountBalance(acct.refunds)).toBe(BigInt(order.totalKobo));
    const refund = await h.store.getRefundByOrder(order.id);
    expect(refund).toMatchObject({ kind: "AUTO_TIMEOUT", amountKobo: order.totalKobo, status: "SUBMITTED" });
    expect(h.gateway.refunds).toEqual([{ reference, amountKobo: order.totalKobo }]);
    const tb = await h.store.trialBalance();
    expect(tb.debits).toBe(tb.credits);
  });

  it("is idempotent: a second sweep refunds nothing more", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    await createPaidOrder(h, w);
    h.clock.advance(120_001);
    expect(await h.c.orders.expireStale()).toBe(1);
    expect(await h.c.orders.expireStale()).toBe(0);
    expect(h.gateway.refunds).toHaveLength(1);
    expect(await h.store.accountBalance(acct.refunds)).toBeGreaterThan(0n);
  });

  it("an accepted order is never expired", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.clock.advance(60_000);
    await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(auth(w.vendor.token)).expect(200);
    h.clock.advance(10 * 60_000);
    expect(await h.c.orders.expireStale()).toBe(0);
    expect((await h.store.getOrder(order.id))?.status).toBe("ACCEPTED");
  });

  it("a late accept after the deadline refunds instead of accepting", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.clock.advance(120_000);
    const res = await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(auth(w.vendor.token)).expect(409);
    expect(res.body.error).toBe("accept_window_expired");
    expect((await h.store.getOrder(order.id))?.status).toBe("REFUNDED");
  });

  it("publishes realtime updates to the customer, vendor and admin rooms on expiry", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    h.messages.length = 0;
    h.clock.advance(120_000);
    await h.c.orders.expireStale();
    const m = h.messages.find((x) => x.event === "order:update");
    expect(m?.rooms).toEqual(expect.arrayContaining([`order:${order.id}`, `customer:${w.customer.id}`, `vendor:${w.vendor.vendorId}`, "admin"]));
  });
});
