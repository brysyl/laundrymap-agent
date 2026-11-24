import request from "supertest";
import { describe, expect, it } from "vitest";
import { auth, createOrder, createPaidOrder, makeHarness, makeWorld, register } from "./helpers";

describe("authentication", () => {
  it("rejects missing, malformed, wrong-secret and expired tokens with 401", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    await request(h.app).get("/api/me").expect(401);
    await request(h.app).get("/api/me").set("Authorization", "Bearer garbage").expect(401);
    await request(h.app).get("/api/me").set("Authorization", w.customer.token).expect(401);
    const jwt = (await import("jsonwebtoken")).default;
    const forged = jwt.sign({ role: "ADMIN" }, "x".repeat(40), { subject: w.customer.id, algorithm: "HS256", issuer: "laundrymap" });
    await request(h.app).get("/api/me").set(auth(forged)).expect(401);
    const none = jwt.sign({ role: "ADMIN" }, "", { subject: w.customer.id, algorithm: "none" as never, issuer: "laundrymap" });
    await request(h.app).get("/api/me").set(auth(none)).expect(401);
    const expired = jwt.sign({ role: "CUSTOMER" }, h.config.jwtSecret, { subject: w.customer.id, expiresIn: -10, issuer: "laundrymap" });
    await request(h.app).get("/api/me").set(auth(expired)).expect(401);
  });

  it("the role claim in the token is not trusted: role comes from the database", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const jwt = (await import("jsonwebtoken")).default;
    const escalated = jwt.sign({ role: "ADMIN" }, h.config.jwtSecret, { subject: w.customer.id, algorithm: "HS256", issuer: "laundrymap" });
    await request(h.app).get("/api/admin/system").set(auth(escalated)).expect(403);
  });

  it("cannot self-register as ADMIN", async () => {
    const h = makeHarness();
    await request(h.app).post("/api/auth/register").send({
      name: "Eve", email: "eve@example.com", phone: "+2348011112222", password: "correct-horse-battery", role: "ADMIN",
    }).expect(400);
  });

  it("login works and wrong password is 401", async () => {
    const h = makeHarness();
    await request(h.app).post("/api/auth/register").send({
      name: "Login User", email: "login@example.com", phone: "+2348099998888", password: "correct-horse-battery", role: "CUSTOMER",
    }).expect(201);
    await request(h.app).post("/api/auth/login").send({ identifier: "login@example.com", password: "correct-horse-battery" }).expect(200);
    await request(h.app).post("/api/auth/login").send({ identifier: "+2348099998888", password: "correct-horse-battery" }).expect(200);
    await request(h.app).post("/api/auth/login").send({ identifier: "login@example.com", password: "wrong-password-1" }).expect(401);
    await request(h.app).post("/api/auth/login").send({ identifier: "nobody@example.com", password: "wrong-password-1" }).expect(401);
    await request(h.app).post("/api/auth/register").send({
      name: "Dup", email: "LOGIN@example.com", phone: "+2348099997777", password: "correct-horse-battery", role: "CUSTOMER",
    }).expect(409);
  });

  it("a suspended user's existing token stops working immediately", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    // MemoryStore returns clones, so mutate through the internal map.
    ((h.store as unknown as { state: { users: Map<string, unknown> } }).state.users.get(w.customer.id) as { status: string }).status = "SUSPENDED";
    await request(h.app).get("/api/me").set(auth(w.customer.token)).expect(403);
  });
});

describe("role based access control", () => {
  it("each role is blocked from the other roles' endpoints with 403", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const order = await createOrder(h, w);
    const admin = auth(w.admin.token), cu = auth(w.customer.token), v = auth(w.vendor.token), co = auth(w.courier.token);
    await request(h.app).get("/api/admin/system").set(cu).expect(403);
    await request(h.app).get("/api/admin/ledger").set(v).expect(403);
    await request(h.app).post(`/api/admin/vendors/${w.vendor.vendorId}/approve`).set(co).expect(403);
    await request(h.app).post(`/api/admin/orders/${order.id}/refund`).set(v).send({ confirm: order.id, reason: "because" }).expect(403);
    await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(cu).expect(403);
    await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(co).expect(403);
    await request(h.app).post(`/api/courier/orders/${order.id}/claim`).set(cu).expect(403);
    await request(h.app).post(`/api/courier/location`).set(v).send({ lat: 9, lng: 7 }).expect(403);
    await request(h.app).post("/api/orders").set(v).send({}).expect(403);
    await request(h.app).post("/api/admin/payouts").set(admin).send({ kind: "VENDOR", ownerId: w.vendor.vendorId, amountKobo: 1 }).expect(409);
  });

  it("unauthenticated requests to protected routes are 401", async () => {
    const h = makeHarness();
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [m, p] of [["get", "/api/me/orders"], ["get", `/api/orders/${id}`], ["get", `/api/orders/${id}/sync`], ["post", `/api/orders/${id}/pay`],
      ["post", `/api/vendor/orders/${id}/accept`], ["post", `/api/courier/orders/${id}/claim`], ["get", "/api/admin/system"]] as const) {
      await request(h.app)[m](p).expect(401);
    }
  });

  it("another customer cannot read, sync, pay for, cancel or fetch the code of someone else's order", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const order = await createOrder(h, w);
    const eve = await register(h, "CUSTOMER", "eve");
    const e = auth(eve.token);
    await request(h.app).get(`/api/orders/${order.id}`).set(e).expect(403);
    await request(h.app).get(`/api/orders/${order.id}/sync`).set(e).expect(403);
    await request(h.app).post(`/api/orders/${order.id}/pay`).set(e).expect(403);
    await request(h.app).post(`/api/orders/${order.id}/cancel`).set(e).expect(403);
    await request(h.app).get(`/api/orders/${order.id}/delivery-code`).set(e).expect(403);
    expect((await request(h.app).get("/api/me/orders").set(e).expect(200)).body.orders).toHaveLength(0);
  });

  it("another vendor cannot see or act on an order for a different vendor", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    const other = await register(h, "VENDOR", "other");
    await request(h.app).post(`/api/admin/vendors/${other.vendorId}/approve`).set(auth(w.admin.token)).expect(200);
    const o = auth(other.token);
    await request(h.app).get(`/api/orders/${order.id}`).set(o).expect(403);
    await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(o).expect(403);
    await request(h.app).post(`/api/vendor/orders/${order.id}/reject`).set(o).send({}).expect(403);
    expect((await h.store.getOrder(order.id))?.status).toBe("AWAITING_VENDOR");
  });

  it("an unapproved vendor or courier cannot act", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const pendingVendor = await register(h, "VENDOR", "pend");
    const pendingCourier = await register(h, "COURIER", "pendc");
    const { order } = await createPaidOrder(h, w);
    await request(h.app).post(`/api/vendor/orders/${order.id}/accept`).set(auth(pendingVendor.token)).expect(403);
    await request(h.app).post(`/api/courier/orders/${order.id}/claim`).set(auth(pendingCourier.token)).expect(403);
    const nearby = await request(h.app).get("/api/vendors/nearby?lat=9&lng=7.59").expect(200);
    expect(nearby.body.vendors.map((x: { id: string }) => x.id)).not.toContain(pendingVendor.vendorId);
    await request(h.app).post("/api/orders").set(auth(w.customer.token)).send({
      vendorId: pendingVendor.vendorId, items: [{ name: "x", quantity: 1 }], dropoff: { address: "Somewhere", lat: 9, lng: 7 },
    }).expect(409);
  });

  it("a courier not assigned to an order cannot read it, and unassigned couriers cannot see in-progress orders", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const { order } = await createPaidOrder(h, w);
    await request(h.app).get(`/api/orders/${order.id}`).set(auth(w.courier.token)).expect(403);
  });

  it("clients cannot set prices or status: unknown body fields are ignored and prices come from the vendor", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    const res = await request(h.app).post("/api/orders").set(auth(w.customer.token)).send({
      vendorId: w.vendor.vendorId, items: [{ name: "Shirts", quantity: 1, unitPriceKobo: 1 }], status: "DELIVERED", totalKobo: 1,
      dropoff: { address: "Mararaba", lat: 9, lng: 7.5 },
    }).expect(201);
    expect(res.body.order.status).toBe("PENDING_PAYMENT");
    expect(res.body.order.totalKobo).toBe(120000 + 100000);
  });

  it("validates input: bad uuid, fractional kobo-like quantity, bad coordinates", async () => {
    const h = makeHarness();
    const w = await makeWorld(h);
    await request(h.app).get("/api/orders/not-a-uuid").set(auth(w.customer.token)).expect(400);
    const body = { vendorId: w.vendor.vendorId, items: [{ name: "x", quantity: 1.5 }], dropoff: { address: "Mararaba", lat: 9, lng: 7.5 } };
    await request(h.app).post("/api/orders").set(auth(w.customer.token)).send(body).expect(400);
    await request(h.app).get("/api/vendors/nearby?lat=999&lng=7").expect(400);
  });
});

describe("nearby vendors and admin approval", () => {
  it("returns only approved vendors within the radius, nearest first", async () => {
    const h = makeHarness();
    const { seedKaruMararaba } = await import("../src/services/vendors");
    expect(await seedKaruMararaba(h.store, h.clock)).toBe(4);
    const w = await makeWorld(h);
    const near = await request(h.app).get("/api/vendors/nearby?lat=9.0123&lng=7.5726&radiusM=3000").expect(200);
    const distances = near.body.vendors.map((v: { distanceM: number }) => v.distanceM);
    expect(near.body.vendors[0].name).toBe("Mararaba Fresh Laundry");
    expect(distances).toEqual([...distances].sort((a: number, b: number) => a - b));
    expect(distances.every((d: number) => d <= 3000)).toBe(true);
    const far = await request(h.app).get("/api/vendors/nearby?lat=6.5&lng=3.3&radiusM=5000").expect(200);
    expect(far.body.vendors).toHaveLength(0);
    // approve/suspend toggles discoverability and writes audit logs
    await request(h.app).post(`/api/admin/vendors/${w.vendor.vendorId}/suspend`).set(auth(w.admin.token)).expect(200);
    const after = await request(h.app).get("/api/vendors/nearby?lat=9.0&lng=7.59&radiusM=1000").expect(200);
    expect(after.body.vendors.map((v: { id: string }) => v.id)).not.toContain(w.vendor.vendorId);
    expect((await h.store.listAudit(10)).map((a) => a.action)).toContain("vendor.suspend");
  });
});

describe("transport hardening", () => {
  it("sets security headers, health and readiness work, and CORS enforces the allowlist", async () => {
    const h = makeHarness({ CORS_EXTRA_ORIGINS: "https://staging.laundrymap.ng" });
    const res = await request(h.app).get("/health").expect(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    await request(h.app).get("/ready").expect(200);
    const ok = await request(h.app).get("/health").set("Origin", "https://laundrymap.ng");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://laundrymap.ng");
    const staging = await request(h.app).get("/health").set("Origin", "https://staging.laundrymap.ng");
    expect(staging.headers["access-control-allow-origin"]).toBe("https://staging.laundrymap.ng");
    const bad = await request(h.app).get("/health").set("Origin", "https://evil.example.com");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate limits repeated login attempts", async () => {
    const h = makeHarness({ AUTH_RATE_LIMIT_MAX: "3" });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await request(h.app).post("/api/auth/login").send({ identifier: "a@example.com", password: "nope-nope-1" })).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });
});
