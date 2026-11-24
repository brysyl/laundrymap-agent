import request from "supertest";
import { describe, expect, it } from "vitest";
import { acct } from "../src/services/ledger";
import { auth, createOrder, createPaidOrder, makeHarness, makeWorld, postWebhook, webhookBody, type Harness, type World } from "./helpers";

/** Pays an order, lets the vendor window lapse with the gateway down, and returns the FAILED refund. */
async function failedRefund(h: Harness, w: World) {
  const { order, reference } = await createPaidOrder(h, w);
  h.gateway.failRefunds = true;
  h.clock.advance(120_000);
  await h.c.orders.expireStale();
  const refund = (await h.store.getRefundByOrder(order.id))!;
  return { order, reference, refund };
}

describe("refund backoff and attempt cap", () => {
  it("does not resend a failing refund on every tick and backs off exponentially", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { refund } = await failedRefund(h, w);
    const base = h.config.refundRetryMinAgeMs;
    expect(await h.store.getRefund(refund.id)).toMatchObject({ status: "FAILED", attempts: 1 });

    let calls = 0;
    const gw = h.gateway;
    const orig = gw.refund.bind(gw);
    gw.refund = async (i) => { calls++; return orig(i); };

    // Many ticks inside the backoff window make no gateway calls.
    for (let i = 0; i < 10; i++) { h.clock.advance(base / 20); await h.c.orders.retryRefunds(); }
    expect(calls).toBe(0);

    h.clock.advance(base); // past first backoff (base)
    await h.c.orders.retryRefunds();
    expect(calls).toBe(1);
    const second = (await h.store.getRefund(refund.id))!;
    expect(second.attempts).toBe(2);
    expect(second.nextAttemptAt!.getTime() - h.clock.now().getTime()).toBe(base * 2); // doubled

    h.clock.advance(base * 2 - 1);
    await h.c.orders.retryRefunds();
    expect(calls).toBe(1);
    h.clock.advance(1);
    await h.c.orders.retryRefunds();
    expect(calls).toBe(2);
  });

  it("caps the delay at REFUND_BACKOFF_MAX_MS", async () => {
    const h = makeHarness({ REFUND_BACKOFF_MAX_MS: "90000", REFUND_MAX_ATTEMPTS: "20" });
    const w = await makeWorld(h);
    const { refund } = await failedRefund(h, w);
    for (let i = 0; i < 4; i++) { h.clock.advance(90_000); await h.c.orders.retryRefunds(); }
    const r = (await h.store.getRefund(refund.id))!;
    expect(r.nextAttemptAt!.getTime() - h.clock.now().getTime()).toBe(90_000);
  });

  it("stops at the attempt cap, marks EXHAUSTED, audits it and stops calling the gateway", async () => {
    const h = makeHarness({ REFUND_MAX_ATTEMPTS: "3" });
    const w = await makeWorld(h);
    const { refund } = await failedRefund(h, w);
    for (let i = 0; i < 5; i++) { h.clock.advance(h.config.refundBackoffMaxMs); await h.c.orders.retryRefunds(); }
    const r = (await h.store.getRefund(refund.id))!;
    expect(r).toMatchObject({ status: "EXHAUSTED", attempts: 3, nextAttemptAt: null, lastError: "gateway down" });
    expect((await h.store.listAudit(20)).filter((a) => a.action === "refund.exhausted")).toHaveLength(1);
    expect(h.gateway.refunds).toHaveLength(0);
    // Further sweeps leave it alone even once the gateway recovers.
    h.gateway.failRefunds = false;
    h.clock.advance(h.config.refundBackoffMaxMs);
    expect(await h.c.orders.retryRefunds()).toBe(0);
    expect(h.gateway.refunds).toHaveLength(0);
  });

  it("lets an admin retry an EXHAUSTED refund once the gateway recovers", async () => {
    const h = makeHarness({ REFUND_MAX_ATTEMPTS: "2" });
    const w = await makeWorld(h);
    const { refund, reference, order } = await failedRefund(h, w);
    h.clock.advance(h.config.refundBackoffMaxMs);
    await h.c.orders.retryRefunds();
    expect((await h.store.getRefund(refund.id))?.status).toBe("EXHAUSTED");
    h.gateway.failRefunds = false;
    const res = await request(h.app).post(`/api/admin/refunds/${refund.id}/retry`).set(auth(w.admin.token)).expect(200);
    expect(res.body.refund).toMatchObject({ status: "SUBMITTED", nextAttemptAt: null, lastError: null });
    expect(h.gateway.refunds).toEqual([{ reference, amountKobo: order.totalKobo }]);
  });
});

describe("atomic refund claim", () => {
  it("two concurrent sweeps submit the same refund once", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { refund } = await failedRefund(h, w);
    h.gateway.failRefunds = false;
    h.clock.advance(h.config.refundRetryMinAgeMs);
    const results = await Promise.all([h.c.orders.retryRefunds(), h.c.orders.retryRefunds(), h.c.orders.retryRefunds()]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(h.gateway.refunds).toHaveLength(1);
    expect((await h.store.getRefund(refund.id))?.status).toBe("SUBMITTED");
  });

  it("the sweep and an admin retry cannot both submit; the admin gets 409 while the claim is live", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { refund } = await failedRefund(h, w);
    h.gateway.failRefunds = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orig = h.gateway.refund.bind(h.gateway);
    h.gateway.refund = async (i) => { await gate; return orig(i); };
    h.clock.advance(h.config.refundRetryMinAgeMs);
    const sweep = h.c.orders.retryRefunds();
    await new Promise((r) => setTimeout(r, 20)); // sweep now holds the claim inside the gateway call
    expect((await h.store.getRefund(refund.id))?.status).toBe("SUBMITTING");
    await request(h.app).post(`/api/admin/refunds/${refund.id}/retry`).set(auth(w.admin.token)).expect(409);
    release();
    expect(await sweep).toBe(1);
    expect(h.gateway.refunds).toHaveLength(1);
  });

  it("a crashed submitter's claim is reclaimed only after the lease ends", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { refund } = await failedRefund(h, w);
    h.gateway.failRefunds = false;
    h.clock.advance(h.config.refundRetryMinAgeMs);
    const claimed = await h.store.claimRefund(refund.id, h.clock.now(), new Date(h.clock.now().getTime() + h.config.refundClaimLeaseMs), { maxAttempts: 8, force: false });
    expect(claimed?.status).toBe("SUBMITTING"); // ...and the process dies here
    expect(await h.c.orders.retryRefunds()).toBe(0);
    h.clock.advance(h.config.refundClaimLeaseMs);
    expect(await h.c.orders.retryRefunds()).toBe(1);
    expect(h.gateway.refunds).toHaveLength(1);
  });

  it("does not mark the refund FAILED when the gateway accepted it but recording SUBMITTED failed", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { refund } = await failedRefund(h, w);
    h.gateway.failRefunds = false;
    h.clock.advance(h.config.refundRetryMinAgeMs);
    const orig = h.store.updateRefund.bind(h.store);
    h.store.updateRefund = async (id, patch) => { if (patch.status === "SUBMITTED") throw new Error("db down"); return orig(id, patch); };
    await h.c.orders.retryRefunds();
    h.store.updateRefund = orig;
    expect(h.gateway.refunds).toHaveLength(1);
    expect((await h.store.getRefund(refund.id))?.status).toBe("SUBMITTING");
  });
});

describe("mismatched charge resolution", () => {
  async function mismatch(h: Harness, w: World, receivedDelta = -1000) {
    const order = await createOrder(h, w);
    const pay = await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(200);
    await postWebhook(h, webhookBody(pay.body.reference, order.totalKobo + receivedDelta, 4242)).expect(200);
    const payment = (await h.store.getPaymentByReference(pay.body.reference))!;
    return { order, payment };
  }
  const refundIt = (h: Harness, token: string, id: string, body: Record<string, unknown>) =>
    request(h.app).post(`/api/admin/payments/${id}/refund-mismatch`).set(auth(token)).send(body);

  it("records the received amount and blocks a new payment while unresolved", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, payment } = await mismatch(h, w);
    expect(payment).toMatchObject({ status: "MISMATCH", receivedKobo: order.totalKobo - 1000 });
    const res = await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(409);
    expect(res.body.error).toBe("payment_mismatch_unresolved");
    expect(await h.store.listPaymentsByOrder(order.id)).toHaveLength(1);
  });

  it("admin refunds the received amount with ledger entries and an audit row", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, payment } = await mismatch(h, w);
    const received = order.totalKobo - 1000;
    const cashBefore = await h.store.accountBalance(acct.cash);

    await refundIt(h, w.customer.token, payment.id, { confirm: payment.id, reason: "underpaid charge" }).expect(403);
    await refundIt(h, w.admin.token, payment.id, { confirm: "wrong", reason: "underpaid charge" }).expect(400);
    const res = await refundIt(h, w.admin.token, payment.id, { confirm: payment.id, reason: "underpaid charge" }).expect(200);

    expect(res.body.payment.status).toBe("MISMATCH_REFUNDED");
    expect(res.body.refund).toMatchObject({ kind: "MISMATCH", amountKobo: received, status: "SUBMITTED", paymentId: payment.id });
    expect(h.gateway.refunds).toEqual([{ reference: payment.reference, amountKobo: received }]);
    // Cash is debited by what was received, the refund liability credited by the same amount.
    expect(await h.store.accountBalance(acct.cash)).toBe(cashBefore - BigInt(received));
    expect(await h.store.accountBalance(acct.refunds)).toBe(BigInt(received));
    const tb = await h.store.trialBalance();
    expect(tb.debits).toBe(tb.credits);
    const audit = (await h.store.listAudit(20)).find((a) => a.action === "payment.mismatch_refund")!;
    expect(audit).toMatchObject({ actorId: w.admin.id, entityId: payment.id });
    expect(audit.metadata).toMatchObject({ expectedKobo: order.totalKobo, refundedKobo: received });
    // Resolved rows leave the mismatch list, the order is still unpaid, and the customer can pay again.
    const list = await request(h.app).get("/api/admin/payments/mismatched").set(auth(w.admin.token)).expect(200);
    expect(list.body.payments).toHaveLength(0);
    expect((await h.store.getOrder(order.id))?.status).toBe("PENDING_PAYMENT");
    await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(200);
  });

  it("cannot be refunded twice, even concurrently", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { payment } = await mismatch(h, w);
    const body = { confirm: payment.id, reason: "underpaid charge" };
    const rs = await Promise.all([refundIt(h, w.admin.token, payment.id, body), refundIt(h, w.admin.token, payment.id, body)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(h.gateway.refunds).toHaveLength(1);
    await refundIt(h, w.admin.token, payment.id, body).expect(409);
  });

  it("a gateway failure leaves a RECORDED/FAILED refund that the sweep retries", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { payment } = await mismatch(h, w);
    h.gateway.failRefunds = true;
    const res = await refundIt(h, w.admin.token, payment.id, { confirm: payment.id, reason: "underpaid charge" }).expect(200);
    expect(res.body.refund.status).toBe("FAILED");
    h.gateway.failRefunds = false;
    h.clock.advance(h.config.refundRetryMinAgeMs);
    expect(await h.c.orders.retryRefunds()).toBe(1);
  });

  it("refuses payments that are not mismatched or whose received amount is not refundable here", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const paid = await createPaidOrder(h, w);
    const paidPayment = (await h.store.getPaymentByReference(paid.reference))!;
    await refundIt(h, w.admin.token, paidPayment.id, { confirm: paidPayment.id, reason: "not a mismatch" }).expect(409);

    const order = await createOrder(h, w);
    const pay = await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(200);
    await postWebhook(h, webhookBody(pay.body.reference, order.totalKobo, 5151, { currency: "USD" })).expect(200);
    const usd = (await h.store.getPaymentByReference(pay.body.reference))!;
    expect(usd).toMatchObject({ status: "MISMATCH", receivedKobo: null });
    const res = await refundIt(h, w.admin.token, usd.id, { confirm: usd.id, reason: "foreign currency" }).expect(409);
    expect(res.body.error).toBe("received_amount_unknown");
    await refundIt(h, w.admin.token, "00000000-0000-4000-8000-000000000999", { confirm: "00000000-0000-4000-8000-000000000999", reason: "missing payment" }).expect(404);
  });
});
