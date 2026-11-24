import type { AddressInfo } from "node:net";
import { createServer, type Server as HttpServer } from "node:http";
import { io as connect, type Socket } from "socket.io-client";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { buildContainer } from "../src/container";
import { createApp } from "../src/http/app";
import { createRealtime } from "../src/realtime/socket";
import { MemoryCache } from "../src/cache/cache";
import { createLogger } from "../src/logger";
import { auth, createOrder, createPaidOrder, makeHarness, makeWorld, register, type Harness, type World } from "./helpers";

const sockets: Socket[] = [];
let server: HttpServer | undefined;
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** Wires real Socket.IO to the harness stores so REST actions produce live events. */
async function boot(): Promise<{ h: Harness; w: World; url: string }> {
  const base = makeHarness();
  const rt = createRealtime();
  const c = buildContainer({ ...base.c, publish: rt.publish, cache: new MemoryCache(base.clock), logger: createLogger("silent") });
  const h: Harness = { ...base, c, app: createApp(c) };
  server = createServer(h.app);
  rt.attach(server, c);
  await new Promise<void>((r) => server!.listen(0, r));
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { h, w: await makeWorld(h), url };
}

function open(url: string, token?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(url, { auth: token === undefined ? {} : { token }, transports: ["websocket"], reconnection: false });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
  });
}
const join = (s: Socket, orderId: string) => new Promise<{ ok: boolean; error?: string }>((r) => s.emit("order:join", { orderId }, r));
const next = (s: Socket, event: string) => new Promise<any>((r) => s.once(event, r));
const quiet = (s: Socket, event: string, ms = 150) => new Promise<boolean>((r) => { let got = false; s.on(event, () => { got = true; }); setTimeout(() => r(!got), ms); });

describe("socket authentication", () => {
  it("rejects connections without a token, with a bad token, or with the token in the query string", async () => {
    const { url, w } = await boot();
    await expect(open(url)).rejects.toThrow(/unauthorized/);
    await expect(open(url, "garbage")).rejects.toThrow(/unauthorized/);
    await expect(new Promise((res, rej) => {
      const s = connect(url, { query: { token: w.customer.token }, transports: ["websocket"], reconnection: false });
      sockets.push(s);
      s.on("connect", () => res("connected"));
      s.on("connect_error", rej);
    })).rejects.toThrow(/unauthorized/);
  });

  it("accepts a valid JWT and rejects a suspended user", async () => {
    const { url, w, h } = await boot();
    const s = await open(url, w.customer.token);
    expect(s.connected).toBe(true);
    (h.store as unknown as { state: { users: Map<string, { status: string }> } }).state.users.get(w.customer.id)!.status = "SUSPENDED";
    await expect(open(url, w.customer.token)).rejects.toThrow(/forbidden/);
  });
});

describe("socket room scoping", () => {
  it("only the owning customer, the vendor and admin can join an order room", async () => {
    const { url, w, h } = await boot();
    const { order } = await createPaidOrder(h, w);
    const eve = await register(h, "CUSTOMER", "eve");
    const otherVendor = await register(h, "VENDOR", "ov");
    await request(h.app).post(`/api/admin/vendors/${otherVendor.vendorId}/approve`).set(auth(w.admin.token)).expect(200);

    expect((await join(await open(url, w.customer.token), order.id)).ok).toBe(true);
    expect((await join(await open(url, w.vendor.token), order.id)).ok).toBe(true);
    expect((await join(await open(url, w.admin.token), order.id)).ok).toBe(true);
    expect(await join(await open(url, eve.token), order.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await join(await open(url, otherVendor.token), order.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await join(await open(url, w.courier.token), order.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await join(await open(url, w.customer.token), "not-a-uuid")).toEqual({ ok: false, error: "invalid_order_id" });
  });

  it("a stranger never receives updates for an order, while owners do", async () => {
    const { url, w, h } = await boot();
    const order = await createOrder(h, w);
    const eve = await register(h, "CUSTOMER", "eve");
    const owner = await open(url, w.customer.token);
    const stranger = await open(url, eve.token);
    await join(owner, order.id);
    await join(stranger, order.id); // denied
    const gotOwner = next(owner, "order:update");
    const strangerQuiet = quiet(stranger, "order:update");
    await request(h.app).post(`/api/orders/${order.id}/cancel`).set(auth(w.customer.token)).expect(200);
    expect((await gotOwner).order.status).toBe("CANCELLED");
    expect(await strangerQuiet).toBe(true);
  });

  it("clients cannot join arbitrary rooms such as admin or another user's room by name", async () => {
    const { url, w, h } = await boot();
    const eve = await register(h, "CUSTOMER", "eve");
    const s = await open(url, eve.token);
    s.emit("join", "admin");
    s.emit("order:join", { orderId: "admin" });
    const adminQuiet = quiet(s, "order:update", 200);
    const order = await createOrder(h, w);
    await request(h.app).post(`/api/orders/${order.id}/cancel`).set(auth(w.customer.token)).expect(200);
    expect(await adminQuiet).toBe(true);
  });

  it("couriers get availability broadcasts without customer details; vendors get new-order events", async () => {
    const { url, w, h } = await boot();
    const courier = await open(url, w.courier.token);
    const vendor = await open(url, w.vendor.token);
    const newOrder = next(vendor, "order:new");
    const { order } = await createPaidOrder(h, w);
    expect((await newOrder).order.id).toBe(order.id);

    const avail = next(courier, "order:available");
    for (const a of ["accept", "start", "ready"]) await request(h.app).post(`/api/vendor/orders/${order.id}/${a}`).set(auth(w.vendor.token)).expect(200);
    const msg = await avail;
    expect(msg).toEqual({ orderId: order.id, vendorId: w.vendor.vendorId, deliveryFeeKobo: 100000 });
    expect(JSON.stringify(msg)).not.toContain("Mararaba");
  });

  it("a customer receives courier location only for their own order", async () => {
    const { url, w, h } = await boot();
    const { order } = await createPaidOrder(h, w);
    for (const a of ["accept", "start", "ready"]) await request(h.app).post(`/api/vendor/orders/${order.id}/${a}`).set(auth(w.vendor.token)).expect(200);
    await request(h.app).post(`/api/courier/orders/${order.id}/claim`).set(auth(w.courier.token)).expect(200);
    const eve = await register(h, "CUSTOMER", "eve");
    const mine = await open(url, w.customer.token);
    const other = await open(url, eve.token);
    const got = next(mine, "courier:location");
    const otherQuiet = quiet(other, "courier:location");
    await request(h.app).post("/api/courier/location").set(auth(w.courier.token)).send({ lat: 9.01, lng: 7.58 }).expect(200);
    expect(await got).toMatchObject({ orderId: order.id, lat: 9.01, lng: 7.58 });
    expect(await otherQuiet).toBe(true);
  });
});
