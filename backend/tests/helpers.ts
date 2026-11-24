import { randomBytes } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { MemoryCache } from "../src/cache/cache";
import { loadConfig, type Config } from "../src/config";
import { buildContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";
import { createLogger } from "../src/logger";
import type { RealtimeMessage } from "../src/realtime/events";
import { FakeGateway, paystackSignature } from "../src/services/gateway";
import { MemoryStore } from "../src/store/memory";
import type { Clock } from "../src/types";

export class FakeClock implements Clock {
  constructor(private t = Date.UTC(2025, 0, 1, 12, 0, 0)) {}
  now() { return new Date(this.t); }
  advance(ms: number) { this.t += ms; }
}

export interface Harness {
  config: Config;
  store: MemoryStore;
  clock: FakeClock;
  gateway: FakeGateway;
  c: Container;
  app: Express;
  messages: RealtimeMessage[];
  paystackSecret: string;
  users: Record<string, { id: string; token: string }>;
}

export function makeHarness(env: Record<string, string> = {}): Harness {
  const paystackSecret = randomBytes(24).toString("hex");
  const config = loadConfig({
    NODE_ENV: "test",
    JWT_SECRET: randomBytes(32).toString("hex"),
    OTP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PAYSTACK_SECRET_KEY: paystackSecret,
    LOG_LEVEL: "silent",
    RATE_LIMIT_MAX: "100000",
    AUTH_RATE_LIMIT_MAX: "100000",
    DELIVERY_FEE_KOBO: "100000",
    COURIER_LOCATION_MIN_INTERVAL_MS: "5000",
    ...env,
  });
  const clock = new FakeClock();
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const messages: RealtimeMessage[] = [];
  const c = buildContainer({
    config, store, clock, gateway, logger: createLogger("silent"), cache: new MemoryCache(clock),
    publish: (m) => { messages.push(m); },
  });
  return { config, store, clock, gateway, c, app: createApp(c), messages, paystackSecret, users: {} };
}

let seq = 0;
export async function register(h: Harness, role: "CUSTOMER" | "VENDOR" | "COURIER", name = role.toLowerCase()) {
  seq += 1;
  const res = await request(h.app).post("/api/auth/register").send({
    name: `${name} ${seq}`, email: `${name}${seq}@example.com`, phone: `+23480${String(10000000 + seq)}`,
    password: "correct-horse-battery", role,
    ...(role === "VENDOR" ? { vendor: { name: `Shop ${seq}`, address: "Karu Site", lat: 9.0, lng: 7.59, unitPriceKobo: 120000 } } : {}),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id as string, token: res.body.token as string, vendorId: res.body.vendor?.id as string | undefined, courierId: res.body.courier?.id as string | undefined };
}

export async function makeAdmin(h: Harness) {
  await h.c.auth.ensureAdmin({ email: "admin@example.com", phone: "+2348000000000", password: "admin-password-123" });
  const res = await request(h.app).post("/api/auth/login").send({ identifier: "admin@example.com", password: "admin-password-123" });
  return { id: res.body.user.id as string, token: res.body.token as string };
}

export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

export function webhookBody(reference: string, amountKobo: number, id: number | string = 1001, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ event: "charge.success", data: { id, reference, amount: amountKobo, currency: "NGN", status: "success", ...extra } });
}

export function postWebhook(h: Harness, body: string, signature?: string) {
  return request(h.app)
    .post("/api/webhooks/paystack")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signature ?? paystackSignature(body, h.paystackSecret))
    .send(body);
}

export interface World {
  admin: { id: string; token: string };
  customer: Awaited<ReturnType<typeof register>>;
  vendor: Awaited<ReturnType<typeof register>>;
  courier: Awaited<ReturnType<typeof register>>;
}

/** Registers an approved vendor and courier plus a customer and admin. */
export async function makeWorld(h: Harness): Promise<World> {
  const admin = await makeAdmin(h);
  const customer = await register(h, "CUSTOMER");
  const vendor = await register(h, "VENDOR");
  const courier = await register(h, "COURIER");
  await request(h.app).post(`/api/admin/vendors/${vendor.vendorId}/approve`).set(auth(admin.token)).expect(200);
  await request(h.app).post(`/api/admin/couriers/${courier.courierId}/approve`).set(auth(admin.token)).expect(200);
  return { admin, customer, vendor, courier };
}

export async function createOrder(h: Harness, w: World, quantity = 2) {
  const res = await request(h.app).post("/api/orders").set(auth(w.customer.token)).send({
    vendorId: w.vendor.vendorId, items: [{ name: "Shirts", quantity }],
    dropoff: { address: "Mararaba Market Road", lat: 9.01, lng: 7.57 },
  });
  if (res.status !== 201) throw new Error(`create order failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order as { id: string; totalKobo: number; subtotalKobo: number; status: string };
}

/** Creates an order, initializes payment and delivers a signed charge.success webhook. */
export async function createPaidOrder(h: Harness, w: World, quantity = 2, eventId: number = Math.floor(Math.random() * 1e9)) {
  const order = await createOrder(h, w, quantity);
  const pay = await request(h.app).post(`/api/orders/${order.id}/pay`).set(auth(w.customer.token)).expect(200);
  await postWebhook(h, webhookBody(pay.body.reference, order.totalKobo, eventId)).expect(200);
  return { order, reference: pay.body.reference as string };
}
