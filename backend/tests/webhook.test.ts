import request from "supertest";
import { describe, expect, it } from "vitest";
import { paystackSignature, verifyPaystackSignature } from "../src/services/gateway";
import { acct } from "../src/services/ledger";
import { auth, createOrder, makeHarness, makeWorld, postWebhook, webhookBody } from "./helpers";

async function setup() {
  const h = makeHarness();
  const w = await makeWorld(h);
  const order = await createOrder(h, w);
  const pay = await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(200);
  return { h, w, order, reference: pay.body.reference as string };
}

describe("paystack signature", () => {
  it("accepts the exact HMAC-SHA512 hex and rejects anything else", () => {
    const raw = Buffer.from('{"a":1}');
    const sig = paystackSignature(raw, "k");
    expect(sig).toHaveLength(128);
    expect(verifyPaystackSignature(raw, sig, "k")).toBe(true);
    expect(verifyPaystackSignature(raw, sig, "other")).toBe(false);
    expect(verifyPaystackSignature(Buffer.from('{"a":2}'), sig, "k")).toBe(false);
    expect(verifyPaystackSignature(raw, undefined, "k")).toBe(false);
    expect(verifyPaystackSignature(raw, sig.slice(0, 64), "k")).toBe(false);
  });
});

describe("POST /api/webhooks/paystack", () => {
  it("valid signature marks the order paid and books the payment in escrow", async () => {
    const { h, order, reference } = await setup();
    const res = await postWebhook(h, webhookBody(reference, order.totalKobo)).expect(200);
    expect(res.body.outcome).toBe("processed");
    const stored = await h.store.getOrder(order.id);
    expect(stored?.status).toBe("AWAITING_VENDOR");
    expect(stored?.acceptDeadline?.getTime()).toBe(h.clock.now().getTime() + 120000);
    expect(await h.store.accountBalance(acct.escrow(order.id))).toBe(BigInt(order.totalKobo));
  });

  it("invalid signature is rejected with 401 and changes nothing", async () => {
    const { h, order, reference } = await setup();
    await postWebhook(h, webhookBody(reference, order.totalKobo), "0".repeat(128)).expect(401);
    expect((await h.store.getOrder(order.id))?.status).toBe("PENDING_PAYMENT");
    expect((await h.store.getPaymentByReference(reference))?.status).toBe("PENDING");
  });

  it("signature computed over a different body is rejected (body tamper)", async () => {
    const { h, order, reference } = await setup();
    const signed = webhookBody(reference, 1);
    await postWebhook(h, webhookBody(reference, order.totalKobo), paystackSignature(signed, h.paystackSecret)).expect(401);
    expect((await h.store.getOrder(order.id))?.status).toBe("PENDING_PAYMENT");
  });

  it("missing signature is rejected", async () => {
    const { h, order, reference } = await setup();
    await request(h.app).post("/api/webhooks/paystack").set("Content-Type", "application/json").send(webhookBody(reference, order.totalKobo)).expect(401);
  });

  it("is idempotent by event id: replay creates no second ledger posting", async () => {
    const { h, order, reference } = await setup();
    const body = webhookBody(reference, order.totalKobo, 777);
    await postWebhook(h, body).expect(200);
    const before = (await h.store.listLedger({ orderId: order.id })).length;
    const again = await postWebhook(h, body).expect(200);
    expect(again.body.outcome).toBe("duplicate");
    expect((await h.store.listLedger({ orderId: order.id })).length).toBe(before);
    expect(await h.store.accountBalance(acct.escrow(order.id))).toBe(BigInt(order.totalKobo));
  });

  it("is idempotent by reference: a different event id for a paid reference is a no-op", async () => {
    const { h, order, reference } = await setup();
    await postWebhook(h, webhookBody(reference, order.totalKobo, 1)).expect(200);
    const before = (await h.store.listLedger({ orderId: order.id })).length;
    const again = await postWebhook(h, webhookBody(reference, order.totalKobo, 2)).expect(200);
    expect(again.body.outcome).toBe("already_processed");
    expect((await h.store.listLedger({ orderId: order.id })).length).toBe(before);
  });

  it("amount mismatch does not mark the order paid and is audited", async () => {
    const { h, order, reference } = await setup();
    const res = await postWebhook(h, webhookBody(reference, order.totalKobo - 1)).expect(200);
    expect(res.body.outcome).toBe("amount_mismatch");
    expect((await h.store.getOrder(order.id))?.status).toBe("PENDING_PAYMENT");
    expect((await h.store.getPaymentByReference(reference))?.status).toBe("MISMATCH");
    expect((await h.store.listAudit(10)).some((a) => a.action === "payment.amount_mismatch")).toBe(true);
  });

  it("wrong currency is treated as a mismatch", async () => {
    const { h, order, reference } = await setup();
    const res = await postWebhook(h, webhookBody(reference, order.totalKobo, 5, { currency: "USD" })).expect(200);
    expect(res.body.outcome).toBe("amount_mismatch");
  });

  it("unknown reference and non-charge events are acknowledged without effect", async () => {
    const { h } = await setup();
    expect((await postWebhook(h, webhookBody("nope", 100)).expect(200)).body.outcome).toBe("unknown_reference");
    const other = JSON.stringify({ event: "transfer.success", data: {} });
    expect((await postWebhook(h, other).expect(200)).body.outcome).toBe("ignored");
  });

  it("malformed JSON with a valid signature is a 400", async () => {
    const { h } = await setup();
    await postWebhook(h, "{not json").expect(400);
  });

  it("a payment arriving after cancellation is booked and automatically refunded", async () => {
    const { h, w, order, reference } = await setup();
    await request(h.app).post(`/api/orders/${order.id}/cancel`).set(auth(w.customer.token)).expect(200);
    await postWebhook(h, webhookBody(reference, order.totalKobo)).expect(200);
    const stored = await h.store.getOrder(order.id);
    expect(stored?.status).toBe("REFUNDED");
    expect(await h.store.accountBalance(acct.escrow(order.id))).toBe(0n);
    expect(h.gateway.refunds).toHaveLength(1);
  });
});
