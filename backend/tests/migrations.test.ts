import { readdirSync, readFileSync } from "node:fs";
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
  it("003 adds refund claim columns, a payment-keyed refund uniqueness and the mismatch states", () => {
    const m3 = readFileSync(path.resolve(__dirname, "../migrations/003_refund_claims_and_mismatch_resolution.sql"), "utf8");
    expect(m3).toMatch(/ADD COLUMN attempts integer NOT NULL DEFAULT 0/);
    expect(m3).toMatch(/ADD COLUMN next_attempt_at timestamptz/);
    expect(m3).toMatch(/'SUBMITTING'/);
    expect(m3).toMatch(/'EXHAUSTED'/);
    expect(m3).toMatch(/UNIQUE \(payment_id\)/);
    expect(m3).toMatch(/'MISMATCH_REFUNDED'/);
    expect(m3).toMatch(/received_kobo bigint/);
  });
});

describe("migration files (static, always run)", () => {
  const dir = path.resolve(__dirname, "../migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  it("are numbered contiguously from 001 so lexical order is application order", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    files.forEach((f, i) => expect(f.startsWith(String(i + 1).padStart(3, "0") + "_"), f).toBe(true));
  });
  it("later migrations never drop or recreate the ledger or webhook tables", () => {
    for (const f of files.slice(1)) {
      const t = readFileSync(path.join(dir, f), "utf8");
      expect(t, f).not.toMatch(/DROP TABLE\s+(IF EXISTS\s+)?(ledger_entries|webhook_events)/i);
      expect(t, f).not.toMatch(/CREATE TABLE\s+(ledger_entries|webhook_events)\b/i);
    }
  });
  it("no migration uses floating point types for money", () => {
    for (const f of files) expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/\b(float|double precision|real|numeric|decimal)\b/i);
  });
});
