import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { acct, payoutLines, post } from "../src/services/ledger";
import { createPostgresStore } from "../src/store/postgres";
import type { Order, Payment } from "../src/types";

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
    id: randomUUID(), orderId, reference: `ref_${randomUUID()}`, amountKobo: 1100, status: "PENDING",
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
});
