import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { acct, payoutLines, post } from "../src/services/ledger";
import { createPostgresStore } from "../src/store/postgres";
import type { Order, Payment, Refund } from "../src/types";

/**
 * Runs only when TEST_DATABASE_URL points at a throwaway PostgreSQL database with PostGIS
 * (CI provides one). Without it the suite is skipped, so a plain `npm test` stays hermetic.
 */
const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("PostgresStore against a live database", () => {
  let pool: Pool;
  const store = () => createPostgresStore(pool);
  const now = () => new Date();

  async function seedOrder(): Promise<Order> {
    const s = store();
    const n = randomUUID().slice(0, 8);
    const user = await s.createUser({
      id: randomUUID(), email: `u${n}@example.com`, phone: `+234${Math.floor(Math.random() * 1e10).toString().padStart(10, "0")}`, name: "Test User",
      role: "CUSTOMER", passwordHash: "x", status: "ACTIVE", createdAt: now(),
    });
    const owner = await s.createUser({
      id: randomUUID(), email: `v${n}@example.com`, phone: `+234${Math.floor(Math.random() * 1e10).toString().padStart(10, "0")}`, name: "Vendor Owner",
      role: "VENDOR", passwordHash: "x", status: "ACTIVE", createdAt: now(),
    });
    const vendor = await s.createVendor({
      id: randomUUID(), ownerId: owner.id, name: "Shop", address: "Karu", lat: 9, lng: 7.59, unitPriceKobo: 1000, status: "APPROVED", createdAt: now(),
    });
    const id = randomUUID();
    return s.createOrder({
      id, customerId: user.id, vendorId: vendor.id, courierId: null, status: "READY_FOR_PICKUP",
      subtotalKobo: 1000, deliveryFeeKobo: 100, totalKobo: 1100, dropoffAddress: "Mararaba", dropoffLat: 9.01, dropoffLng: 7.57,
      acceptDeadline: null, cancelReason: null, version: 1, createdAt: now(), updatedAt: now(),
      items: [{ id: randomUUID(), orderId: id, name: "Shirt", quantity: 1, unitPriceKobo: 1000 }],
    });
  }

  const pending = (orderId: string): Payment => ({
    id: randomUUID(), orderId, reference: `ref_${randomUUID()}`, amountKobo: 1100, receivedKobo: null, status: "PENDING",
    authorizationUrl: "https://pay.test/x", gatewayTransactionId: null, paidAt: null, createdAt: now(),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 10 });
    await migrate(pool);
  });
  afterAll(async () => { await pool?.end(); });

  it("rejects UPDATE and DELETE on ledger entries", async () => {
    const s = store();
    const account = `test:${randomUUID()}`;
    await post(s, null, [
      { account, direction: "DEBIT", amountKobo: 5, type: "PAYOUT", memo: "t" },
      { account: acct.payouts, direction: "CREDIT", amountKobo: 5, type: "PAYOUT", memo: "t" },
    ], now());
    await expect(pool.query("UPDATE ledger_entries SET amount_kobo = 1 WHERE account = $1", [account])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM ledger_entries WHERE account = $1", [account])).rejects.toThrow(/append-only/);
  });

  it("rejects an unbalanced posting at commit", async () => {
    const s = store();
    const txId = randomUUID();
    await expect(s.tx((t) => t.appendLedger([
      { id: randomUUID(), txId, orderId: null, account: `test:${randomUUID()}`, direction: "DEBIT", amountKobo: 10, type: "PAYOUT", memo: "t", createdAt: now() },
      { id: randomUUID(), txId, orderId: null, account: acct.payouts, direction: "CREDIT", amountKobo: 9, type: "PAYOUT", memo: "t", createdAt: now() },
    ]))).rejects.toThrow();
  });

  it("allows only one PENDING payment per order", async () => {
    const order = await seedOrder();
    const s = store();
    await s.createPayment(pending(order.id));
    await expect(s.createPayment(pending(order.id))).rejects.toMatchObject({ status: 409, code: "payment_pending" });
  });

  it("deduplicates webhook events", async () => {
    const s = store();
    const id = `charge.success:${randomUUID()}`;
    expect(await s.recordWebhookEvent(id, "r", { a: 1 }, now())).toBe(true);
    expect(await s.recordWebhookEvent(id, "r", { a: 1 }, now())).toBe(false);
  });

  it("lets exactly one of many concurrent claims win the compare-and-set", async () => {
    const order = await seedOrder();
    const s = store();
    const courierIds = await Promise.all(Array.from({ length: 5 }, async () => (await s.createUser({
      id: randomUUID(), email: `c${randomUUID()}@example.com`, phone: `+234${Math.floor(Math.random() * 1e10).toString().padStart(10, "0")}`, name: "Courier",
      role: "COURIER", passwordHash: "x", status: "ACTIVE", createdAt: now(),
    })).id));
    const results = await Promise.all(courierIds.map((cid) => s.transitionOrder(order.id, ["READY_FOR_PICKUP"], { status: "COURIER_ASSIGNED", courierId: cid }, now())));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("serializes concurrent payouts with lockAccount so the account cannot be overdrawn", async () => {
    const s = store();
    const account = acct.vendor(randomUUID());
    await post(s, null, [
      { account: acct.cash, direction: "DEBIT", amountKobo: 10_000, type: "VENDOR_EARNINGS", memo: "seed" },
      { account, direction: "CREDIT", amountKobo: 10_000, type: "VENDOR_EARNINGS", memo: "seed" },
    ], now());
    const payout = () => s.tx(async (t) => {
      await t.lockAccount(account);
      if ((await t.accountBalance(account)) < 6000n) return false;
      await post(t, null, payoutLines(account, 6000), now());
      return true;
    });
    const outcomes = await Promise.all([payout(), payout(), payout(), payout()]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await s.accountBalance(account)).toBe(4000n);
  });
  async function seedPaidPayment(order: Order, status: Payment["status"] = "PAID"): Promise<Payment> {
    const s = store();
    const p = await s.createPayment({ ...pending(order.id), status: "FAILED" });
    return (await s.updatePayment(p.id, { status, paidAt: now(), ...(status === "MISMATCH" ? { receivedKobo: 900 } : {}) }))!;
  }
  const recorded = (orderId: string, paymentId: string, createdAt = now()): Refund => ({
    id: randomUUID(), orderId, paymentId, amountKobo: 1100, reason: "test refund", kind: "ADMIN", status: "RECORDED", requestedBy: null,
    gatewayRef: null, attempts: 0, nextAttemptAt: null, lastError: null, createdAt,
  });

  it("finds the PAID payment and lists payments by status and by order", async () => {
    const order = await seedOrder();
    const s = store();
    await s.createPayment({ ...pending(order.id), status: "FAILED" });
    const paid = await seedPaidPayment(order);
    const mismatch = await seedPaidPayment(order, "MISMATCH");
    expect((await s.getPaidPaymentByOrder(order.id))?.id).toBe(paid.id);
    expect((await s.listPaymentsByStatus("MISMATCH", 1000)).map((p) => p.id)).toContain(mismatch.id);
    expect(mismatch.receivedKobo).toBe(900);
    expect((await s.listPaymentsByOrder(order.id)).length).toBe(3);
  });

  it("allows only one refund per payment", async () => {
    const order = await seedOrder();
    const s = store();
    const p = await seedPaidPayment(order);
    await s.createRefund(recorded(order.id, p.id));
    await expect(s.createRefund(recorded(order.id, p.id))).rejects.toMatchObject({ status: 409, code: "refund_exists" });
  });

  it("lists due refunds (ANY/status filters) and claims with SKIP LOCKED so exactly one concurrent claimer wins", async () => {
    const order = await seedOrder();
    const s = store();
    const p = await seedPaidPayment(order);
    const old = new Date(Date.now() - 3600_000);
    const r = await s.createRefund(recorded(order.id, p.id, old));
    expect((await s.listDueRefunds(now(), now(), 8, 1000)).map((x) => x.id)).toContain(r.id);

    const lease = new Date(Date.now() + 300_000);
    const results = await Promise.all(Array.from({ length: 6 }, () => s.claimRefund(r.id, now(), lease, { maxAttempts: 8, force: false })));
    expect(results.filter((x) => x !== null)).toHaveLength(1);
    expect(await s.getRefund(r.id)).toMatchObject({ status: "SUBMITTING", attempts: 1 });
    expect((await s.listDueRefunds(now(), now(), 8, 1000)).map((x) => x.id)).not.toContain(r.id);
    // A live lease blocks even a forced claim; an expired one does not.
    expect(await s.claimRefund(r.id, now(), lease, { maxAttempts: 8, force: true })).toBeNull();
    expect(await s.claimRefund(r.id, new Date(Date.now() + 301_000), lease, { maxAttempts: 8, force: false })).toMatchObject({ attempts: 2 });
  });

  it("applies backoff and the attempt cap in claimRefund, and updateRefund can clear columns", async () => {
    const order = await seedOrder();
    const s = store();
    const p = await seedPaidPayment(order);
    const r = await s.createRefund(recorded(order.id, p.id, new Date(Date.now() - 3600_000)));
    const lease = new Date(Date.now() + 1000);
    await s.claimRefund(r.id, now(), lease, { maxAttempts: 2, force: false });
    const later = new Date(Date.now() + 600_000);
    await s.updateRefund(r.id, { status: "FAILED", nextAttemptAt: later, lastError: "boom" });
    expect(await s.claimRefund(r.id, now(), lease, { maxAttempts: 2, force: false })).toBeNull(); // in backoff
    expect((await s.listDueRefunds(now(), now(), 2, 1000)).map((x) => x.id)).not.toContain(r.id);
    expect(await s.claimRefund(r.id, new Date(later.getTime() + 1), lease, { maxAttempts: 2, force: false })).toMatchObject({ attempts: 2 });
    await s.updateRefund(r.id, { status: "FAILED", nextAttemptAt: later });
    expect(await s.claimRefund(r.id, new Date(later.getTime() + 1), lease, { maxAttempts: 2, force: false })).toBeNull(); // cap reached
    await s.updateRefund(r.id, { status: "EXHAUSTED", nextAttemptAt: null, lastError: null });
    expect(await s.getRefund(r.id)).toMatchObject({ status: "EXHAUSTED", nextAttemptAt: null, lastError: null });
    expect(await s.claimRefund(r.id, now(), lease, { maxAttempts: 2, force: true })).toMatchObject({ status: "SUBMITTING" });
  });

  it("re-running migrations is a no-op and records every migration file once", async () => {
    expect(await migrate(pool)).toEqual([]);
    const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["001_init.sql", "002_payment_and_refund_hardening.sql", "003_refund_claims_and_mismatch_resolution.sql"]));
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
  });

  it("creates the expected tables and indexes from migrations 001-003", async () => {
    const t = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()");
    const tables = t.rows.map((r) => r.table_name);
    for (const n of ["users", "vendors", "couriers", "orders", "order_items", "payments", "webhook_events", "ledger_entries", "refunds", "audit_logs", "otps"]) expect(tables).toContain(n);
    const i = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()");
    const idx = i.rows.map((r) => r.indexname);
    expect(idx).toContain("payments_one_pending_per_order");
    expect(idx).toContain("refunds_unsettled_idx");
  });

  it("keeps the whole-database ledger balanced when summed in SQL", async () => {
    const s = store();
    const account = `test:${randomUUID()}`;
    await post(s, null, [
      { account, direction: "DEBIT", amountKobo: 77, type: "PAYOUT", memo: "t" },
      { account: acct.payouts, direction: "CREDIT", amountKobo: 77, type: "PAYOUT", memo: "t" },
    ], now());
    const r = await pool.query<{ d: string; c: string }>(
      "SELECT COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'DEBIT'), 0) AS d, COALESCE(SUM(amount_kobo) FILTER (WHERE direction = 'CREDIT'), 0) AS c FROM ledger_entries");
    expect(r.rows[0]!.d).toBe(r.rows[0]!.c);
  });
});
