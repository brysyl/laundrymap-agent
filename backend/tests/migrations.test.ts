import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(path.resolve(__dirname, "../migrations/001_init.sql"), "utf8");

// Static checks only. These cannot prove behaviour against a live Postgres.
describe("001_init.sql (static)", () => {
  it("creates every required table", () => {
    for (const t of ["users", "vendors", "couriers", "orders", "order_items", "payments", "webhook_events", "ledger_entries", "refunds", "audit_logs", "otps"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE ${t} \\(`));
    }
  });
  it("uses PostGIS geography for vendor locations with a GiST index", () => {
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS postgis/);
    expect(sql).toMatch(/location\s+geography\(Point, 4326\) NOT NULL/);
    expect(sql).toMatch(/USING gist \(location\)/);
  });
  it("blocks UPDATE, DELETE and TRUNCATE on the ledger and enforces balance", () => {
    expect(sql).toMatch(/BEFORE UPDATE ON ledger_entries/);
    expect(sql).toMatch(/BEFORE DELETE ON ledger_entries/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON ledger_entries/);
    expect(sql).toMatch(/CONSTRAINT TRIGGER ledger_balanced/);
  });
  it("webhook event ids are unique and money columns are BIGINT without floats", () => {
    expect(sql).toMatch(/event_id\s+text PRIMARY KEY/);
    expect(sql).not.toMatch(/\b(float|double precision|real|numeric|decimal)\b/i);
    expect(sql).toMatch(/amount_kobo\s+bigint/);
  });
  it("002 enforces one pending payment per order and indexes unsettled refunds", () => {
    const m2 = readFileSync(path.resolve(__dirname, "../migrations/002_payment_and_refund_hardening.sql"), "utf8");
    expect(m2).toMatch(/CREATE UNIQUE INDEX payments_one_pending_per_order ON payments \(order_id\) WHERE status = 'PENDING'/);
    expect(m2).toMatch(/refunds_unsettled_idx/);
  });
});
