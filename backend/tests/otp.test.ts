import request from "supertest";
import { describe, expect, it } from "vitest";
import { decryptOtp } from "../src/services/otp";
import { auth, createPaidOrder, makeHarness, makeWorld, type Harness, type World } from "./helpers";

async function outForDelivery(h: Harness, w: World) {
  const { order } = await createPaidOrder(h, w);
  const v = auth(w.vendor.token), c = auth(w.courier.token);
  await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(v).expect(200);
  await request(h.app).post(`/api/vendor/orders/${order.id}/start`).set(v).expect(200);
  await request(h.app).post(`/api/vendor/orders/${order.id}/ready`).set(v).expect(200);
  await request(h.app).post(`/api/courier/orders/${order.id}/claim`).set(c).expect(200);
  await request(h.app).post(`/api/courier/orders/${order.id}/pickup`).set(c).expect(200);
  const code = (await request(h.app).get(`/api/orders/${order.id}/delivery-code`).set(auth(w.customer.token)).expect(200)).body.code as string;
  const deliver = (otp: string) => request(h.app).post(`/api/courier/orders/${order.id}/deliver`).set(c).send({ otp });
  return { order, code, deliver };
}

const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

describe("delivery OTP", () => {
  it("is stored AES-256-GCM encrypted, never as plaintext, and decrypts only with the OTP key", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, code } = await outForDelivery(h, w);
    const row = await h.store.getOtp(order.id);
    expect(row?.ciphertext).toBeDefined();
    expect(row?.ciphertext).not.toContain(code);
    expect(decryptOtp(row!.ciphertext, h.config.otpEncryptionKey)).toBe(code);
    expect(() => decryptOtp(row!.ciphertext, h.config.jwtSecret)).toThrow();
  });

  it("accepts the correct code once and settles the order", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, code, deliver } = await outForDelivery(h, w);
    const res = await deliver(code).expect(200);
    expect(res.body.order.status).toBe("DELIVERED");
    expect((await h.store.getOrder(order.id))?.status).toBe("DELIVERED");
  });

  it("rejects a wrong code and leaves the order out for delivery", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, code, deliver } = await outForDelivery(h, w);
    const res = await deliver(wrongCode(code)).expect(400);
    expect(res.body.error).toBe("invalid_otp");
    expect((await h.store.getOrder(order.id))?.status).toBe("OUT_FOR_DELIVERY");
  });

  it("rejects an expired code", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { code, deliver } = await outForDelivery(h, w);
    h.clock.advance(h.config.otpTtlMs + 1);
    const res = await deliver(code).expect(410);
    expect(res.body.error).toBe("otp_expired");
  });

  it("rejects a replayed code after use", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, code, deliver } = await outForDelivery(h, w);
    await deliver(code).expect(200);
    // Order is delivered, so the status guard fires first; verify the OTP layer directly too.
    await deliver(code).expect(409);
    expect(await h.c.otp.verify(h.store, order.id, code)).toBe("REPLAYED");
  });

  it("locks out after max wrong attempts, even for the correct code, until the lock expires", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { code, deliver } = await outForDelivery(h, w);
    for (let i = 0; i < h.config.otpMaxAttempts - 1; i++) await deliver(wrongCode(code)).expect(400);
    await deliver(wrongCode(code)).expect(429);
    await deliver(code).expect(429);
    h.clock.advance(h.config.otpLockMs + 1);
    await deliver(code).expect(200);
  });

  it("only the owning customer can read the code; other customers and couriers cannot", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await outForDelivery(h, w);
    await request(h.app).get(`/api/orders/${order.id}/delivery-code`).set(auth(w.courier.token)).expect(403);
    await request(h.app).get(`/api/orders/${order.id}/delivery-code`).set(auth(w.vendor.token)).expect(403);
  });

  it("a courier who is not assigned cannot deliver", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order, code } = await outForDelivery(h, w);
    const { register } = await import("./helpers");
    const other = await register(h, "COURIER");
    const { default: req } = await import("supertest");
    await req(h.app).post(`/api/admin/couriers/${other.courierId}/approve`).set(auth(w.admin.token)).expect(200);
    await req(h.app).post(`/api/courier/orders/${order.id}/deliver`).set(auth(other.token)).send({ otp: code }).expect(403);
  });
});
