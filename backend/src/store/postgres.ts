import type { Pool, PoolClient, QueryResultRow } from "pg";
import { conflict } from "../errors";
import type {
  ApprovalStatus, AuditLog, Courier, LedgerEntry, Order, OrderFilter, OrderItem, OrderPatch, OrderStatus,
  Otp, Payment, Refund, User, Vendor, VendorNearby,
} from "../types";
import type { RefundPatch, Store, SystemCounts } from "./store";

type Q = Pool | PoolClient;
type Row = QueryResultRow;

/** BIGINT comes back from pg as string. Reject anything outside the safe-integer range. */
function kobo(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`kobo value out of safe range: ${String(v)}`);
  return n;
}
const dt = (v: unknown): Date | null => (v === null || v === undefined ? null : (v instanceof Date ? v : new Date(String(v))));
const dreq = (v: unknown): Date => dt(v) as Date;

const userOf = (r: Row): User => ({
  id: r.id, email: r.email, phone: r.phone, name: r.name, role: r.role, passwordHash: r.password_hash,
  status: r.status, createdAt: dreq(r.created_at),
});
const VENDOR_COLS = "id, owner_id, name, address, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, unit_price_kobo, status, created_at";
const vendorOf = (r: Row): Vendor => ({
  id: r.id, ownerId: r.owner_id, name: r.name, address: r.address, lat: Number(r.lat), lng: Number(r.lng),
  unitPriceKobo: kobo(r.unit_price_kobo), status: r.status, createdAt: dreq(r.created_at),
});
const COURIER_COLS = "id, user_id, status, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, location_at, created_at";
const courierOf = (r: Row): Courier => ({
  id: r.id, userId: r.user_id, status: r.status, lat: r.lat === null ? null : Number(r.lat),
  lng: r.lng === null ? null : Number(r.lng), locationAt: dt(r.location_at), createdAt: dreq(r.created_at),
});
const ORDER_COLS = `id, customer_id, vendor_id, courier_id, status, subtotal_kobo, delivery_fee_kobo, total_kobo,
  dropoff_address, ST_Y(dropoff_location::geometry) AS dlat, ST_X(dropoff_location::geometry) AS dlng,
  accept_deadline, cancel_reason, version, created_at, updated_at`;
const orderOf = (r: Row, items: OrderItem[]): Order => ({
  id: r.id, customerId: r.customer_id, vendorId: r.vendor_id, courierId: r.courier_id, status: r.status,
  subtotalKobo: kobo(r.subtotal_kobo), deliveryFeeKobo: kobo(r.delivery_fee_kobo), totalKobo: kobo(r.total_kobo),
  dropoffAddress: r.dropoff_address, dropoffLat: Number(r.dlat), dropoffLng: Number(r.dlng),
  acceptDeadline: dt(r.accept_deadline), cancelReason: r.cancel_reason, version: Number(r.version),
  createdAt: dreq(r.created_at), updatedAt: dreq(r.updated_at), items,
});
const itemOf = (r: Row): OrderItem => ({
  id: r.id, orderId: r.order_id, name: r.name, quantity: Number(r.quantity), unitPriceKobo: kobo(r.unit_price_kobo),
});
const paymentOf = (r: Row): Payment => ({
  id: r.id, orderId: r.order_id, reference: r.reference, amountKobo: kobo(r.amount_kobo),
  receivedKobo: r.received_kobo === null || r.received_kobo === undefined ? null : kobo(r.received_kobo), status: r.status,
  authorizationUrl: r.authorization_url, gatewayTransactionId: r.gateway_transaction_id, paidAt: dt(r.paid_at),
  createdAt: dreq(r.created_at),
});
const ledgerOf = (r: Row): LedgerEntry => ({
  id: r.id, txId: r.tx_id, orderId: r.order_id, account: r.account, direction: r.direction,
  amountKobo: kobo(r.amount_kobo), type: r.type, memo: r.memo, createdAt: dreq(r.created_at),
});
const refundOf = (r: Row): Refund => ({
  id: r.id, orderId: r.order_id, paymentId: r.payment_id, amountKobo: kobo(r.amount_kobo), reason: r.reason,
  kind: r.kind, status: r.status, requestedBy: r.requested_by, gatewayRef: r.gateway_ref,
  attempts: Number(r.attempts), nextAttemptAt: dt(r.next_attempt_at), lastError: r.last_error, createdAt: dreq(r.created_at),
});
const otpOf = (r: Row): Otp => ({
  orderId: r.order_id, ciphertext: r.ciphertext, expiresAt: dreq(r.expires_at), attempts: Number(r.attempts),
  lockedUntil: dt(r.locked_until), consumedAt: dt(r.consumed_at), createdAt: dreq(r.created_at),
});

const isUnique = (e: unknown): e is { code: string; constraint?: string } =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";

export class PostgresStore implements Store {
  /** `q` is the Pool, or the checked-out client when inside tx(). */
  constructor(private readonly q: Q, private readonly pool?: Pool) {}

  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    if (!this.pool) return fn(this); // already inside a transaction
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(new PostgresStore(client));
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.q.query(sql, params)).rows;
  }
  private async one(sql: string, params: unknown[] = []): Promise<Row | null> {
    return (await this.rows(sql, params))[0] ?? null;
  }

  async ping() { await this.q.query("SELECT 1"); }

  async createUser(u: User) {
    try {
      await this.q.query(
        "INSERT INTO users (id,email,phone,name,role,password_hash,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [u.id, u.email, u.phone, u.name, u.role, u.passwordHash, u.status, u.createdAt],
      );
    } catch (e) {
      if (isUnique(e)) throw conflict("user_exists", "Email or phone already registered");
      throw e;
    }
    return u;
  }
  async getUser(id: string) { const r = await this.one("SELECT * FROM users WHERE id=$1", [id]); return r ? userOf(r) : null; }
  async getUserByEmail(email: string) { const r = await this.one("SELECT * FROM users WHERE lower(email)=lower($1)", [email]); return r ? userOf(r) : null; }
  async getUserByPhone(phone: string) { const r = await this.one("SELECT * FROM users WHERE phone=$1", [phone]); return r ? userOf(r) : null; }

  async createVendor(v: Vendor) {
    await this.q.query(
      `INSERT INTO vendors (id,owner_id,name,address,location,unit_price_kobo,status,created_at)
       VALUES ($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($6,$5),4326)::geography,$7,$8,$9)`,
      [v.id, v.ownerId, v.name, v.address, v.lat, v.lng, v.unitPriceKobo, v.status, v.createdAt],
    );
    return v;
  }
  async getVendor(id: string) { const r = await this.one(`SELECT ${VENDOR_COLS} FROM vendors WHERE id=$1`, [id]); return r ? vendorOf(r) : null; }
  async getVendorByOwner(ownerId: string) { const r = await this.one(`SELECT ${VENDOR_COLS} FROM vendors WHERE owner_id=$1`, [ownerId]); return r ? vendorOf(r) : null; }
  async setVendorStatus(id: string, status: ApprovalStatus) {
    const r = await this.one(`UPDATE vendors SET status=$2 WHERE id=$1 RETURNING ${VENDOR_COLS}`, [id, status]);
    return r ? vendorOf(r) : null;
  }
  async listVendors(status?: ApprovalStatus) {
    const rows = await this.rows(`SELECT ${VENDOR_COLS} FROM vendors WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT 500`, [status ?? null]);
    return rows.map(vendorOf);
  }
  async nearbyVendors(lat: number, lng: number, radiusM: number, limit: number): Promise<VendorNearby[]> {
    const rows = await this.rows(
      `SELECT ${VENDOR_COLS}, ST_Distance(location, p.pt) AS distance_m
         FROM vendors, (SELECT ST_SetSRID(ST_MakePoint($2,$1),4326)::geography AS pt) p
        WHERE status='APPROVED' AND ST_DWithin(location, p.pt, $3)
        ORDER BY distance_m ASC LIMIT $4`,
      [lat, lng, radiusM, limit],
    );
    return rows.map((r) => ({ ...vendorOf(r), distanceM: Number(r.distance_m) }));
  }

  async createCourier(c: Courier) {
    await this.q.query("INSERT INTO couriers (id,user_id,status,created_at) VALUES ($1,$2,$3,$4)", [c.id, c.userId, c.status, c.createdAt]);
    return c;
  }
  async getCourierByUser(userId: string) { const r = await this.one(`SELECT ${COURIER_COLS} FROM couriers WHERE user_id=$1`, [userId]); return r ? courierOf(r) : null; }
  async getCourier(id: string) { const r = await this.one(`SELECT ${COURIER_COLS} FROM couriers WHERE id=$1`, [id]); return r ? courierOf(r) : null; }
  async setCourierStatus(id: string, status: ApprovalStatus) {
    const r = await this.one(`UPDATE couriers SET status=$2 WHERE id=$1 RETURNING ${COURIER_COLS}`, [id, status]);
    return r ? courierOf(r) : null;
  }
  async listCouriers(status?: ApprovalStatus) {
    const rows = await this.rows(`SELECT ${COURIER_COLS} FROM couriers WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT 500`, [status ?? null]);
    return rows.map(courierOf);
  }
  async updateCourierLocation(userId: string, lat: number, lng: number, at: Date) {
    await this.q.query(
      "UPDATE couriers SET location=ST_SetSRID(ST_MakePoint($3,$2),4326)::geography, location_at=$4 WHERE user_id=$1",
      [userId, lat, lng, at],
    );
  }

  private async withItems(rows: Row[]): Promise<Order[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const items = (await this.rows("SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY id", [ids])).map(itemOf);
    return rows.map((r) => orderOf(r, items.filter((i) => i.orderId === r.id)));
  }

  async createOrder(o: Order) {
    await this.q.query(
      `INSERT INTO orders (id,customer_id,vendor_id,courier_id,status,subtotal_kobo,delivery_fee_kobo,total_kobo,
         dropoff_address,dropoff_location,accept_deadline,cancel_reason,version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ST_SetSRID(ST_MakePoint($11,$10),4326)::geography,$12,$13,$14,$15,$16)`,
      [o.id, o.customerId, o.vendorId, o.courierId, o.status, o.subtotalKobo, o.deliveryFeeKobo, o.totalKobo,
        o.dropoffAddress, o.dropoffLat, o.dropoffLng, o.acceptDeadline, o.cancelReason, o.version, o.createdAt, o.updatedAt],
    );
    for (const i of o.items) {
      await this.q.query("INSERT INTO order_items (id,order_id,name,quantity,unit_price_kobo) VALUES ($1,$2,$3,$4,$5)",
        [i.id, o.id, i.name, i.quantity, i.unitPriceKobo]);
    }
    return o;
  }
  async getOrder(id: string) {
    const [o] = await this.withItems(await this.rows(`SELECT ${ORDER_COLS} FROM orders WHERE id=$1`, [id]));
    return o ?? null;
  }
  async transitionOrder(id: string, from: OrderStatus[], patch: OrderPatch, now: Date) {
    const sets: string[] = ["version = version + 1", "updated_at = $3"];
    const params: unknown[] = [id, from, now];
    const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.courierId !== undefined) add("courier_id", patch.courierId);
    if (patch.acceptDeadline !== undefined) add("accept_deadline", patch.acceptDeadline);
    if (patch.cancelReason !== undefined) add("cancel_reason", patch.cancelReason);
    const r = await this.one(`UPDATE orders SET ${sets.join(", ")} WHERE id=$1 AND status = ANY($2::text[]) RETURNING id`, params);
    return r ? this.getOrder(id) : null;
  }
  async listOrders(f: OrderFilter) {
    const rows = await this.rows(
      `SELECT ${ORDER_COLS} FROM orders
        WHERE ($1::uuid IS NULL OR customer_id=$1) AND ($2::uuid IS NULL OR vendor_id=$2)
          AND ($3::uuid IS NULL OR courier_id=$3) AND ($4::text[] IS NULL OR status = ANY($4))
          AND (NOT $5::boolean OR courier_id IS NULL)
        ORDER BY created_at DESC LIMIT $6`,
      [f.customerId ?? null, f.vendorId ?? null, f.courierId ?? null, f.statuses ?? null, f.unassigned ?? false, f.limit ?? 100],
    );
    return this.withItems(rows);
  }
  async listExpiredAwaiting(now: Date, limit: number) {
    return this.withItems(await this.rows(
      `SELECT ${ORDER_COLS} FROM orders WHERE status='AWAITING_VENDOR' AND accept_deadline <= $1 ORDER BY accept_deadline LIMIT $2`,
      [now, limit],
    ));
  }

  async createPayment(p: Payment) {
    try {
      await this.q.query(
        `INSERT INTO payments (id,order_id,reference,amount_kobo,status,authorization_url,gateway_transaction_id,paid_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.id, p.orderId, p.reference, p.amountKobo, p.status, p.authorizationUrl, p.gatewayTransactionId, p.paidAt, p.createdAt],
      );
    } catch (e) {
      if (isUnique(e) && e.constraint === "payments_one_pending_per_order") throw conflict("payment_pending", "Order already has a pending payment");
      throw e;
    }
    return p;
  }
  async getPayment(id: string) { const r = await this.one("SELECT * FROM payments WHERE id=$1", [id]); return r ? paymentOf(r) : null; }
  async getPaidPaymentByOrder(orderId: string) {
    const r = await this.one("SELECT * FROM payments WHERE order_id=$1 AND status='PAID' ORDER BY paid_at LIMIT 1", [orderId]);
    return r ? paymentOf(r) : null;
  }
  async listPaymentsByStatus(status: Payment["status"], limit: number) {
    return (await this.rows("SELECT * FROM payments WHERE status=$1 ORDER BY created_at DESC LIMIT $2", [status, limit])).map(paymentOf);
  }
  async getPaymentByReference(reference: string) { const r = await this.one("SELECT * FROM payments WHERE reference=$1", [reference]); return r ? paymentOf(r) : null; }
  async getPaymentByOrder(orderId: string) { const r = await this.one("SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1", [orderId]); return r ? paymentOf(r) : null; }
  async listPaymentsByOrder(orderId: string) {
    return (await this.rows("SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at DESC", [orderId])).map(paymentOf);
  }
  async updatePayment(id: string, patch: Partial<Pick<Payment, "status" | "gatewayTransactionId" | "paidAt" | "receivedKobo">>) {
    const r = await this.one(
      `UPDATE payments SET status=COALESCE($2,status), gateway_transaction_id=COALESCE($3,gateway_transaction_id),
         paid_at=COALESCE($4,paid_at), received_kobo=COALESCE($5,received_kobo) WHERE id=$1 RETURNING *`,
      [id, patch.status ?? null, patch.gatewayTransactionId ?? null, patch.paidAt ?? null, patch.receivedKobo ?? null],
    );
    return r ? paymentOf(r) : null;
  }

  async recordWebhookEvent(eventId: string, reference: string | null, payload: unknown, at: Date) {
    const r = await this.q.query(
      "INSERT INTO webhook_events (event_id,reference,payload,received_at) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (event_id) DO NOTHING",
      [eventId, reference, JSON.stringify(payload), at],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async appendLedger(entries: LedgerEntry[]) {
    for (const e of entries) {
      await this.q.query(
        "INSERT INTO ledger_entries (id,tx_id,order_id,account,direction,amount_kobo,type,memo,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [e.id, e.txId, e.orderId, e.account, e.direction, e.amountKobo, e.type, e.memo, e.createdAt],
      );
    }
  }
  async listLedger(f: { orderId?: string; account?: string; limit?: number }) {
    const rows = await this.rows(
      `SELECT * FROM ledger_entries WHERE ($1::uuid IS NULL OR order_id=$1) AND ($2::text IS NULL OR account=$2)
        ORDER BY created_at DESC, id LIMIT $3`,
      [f.orderId ?? null, f.account ?? null, f.limit ?? 500],
    );
    return rows.map(ledgerOf);
  }
  async lockAccount(account: string) {
    // Transaction-scoped. Under READ COMMITTED the balance read that follows sees every commit made before the lock was granted.
    await this.q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ledger-account:${account}`]);
  }
  async accountBalance(account: string) {
    const r = await this.one(
      "SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount_kobo ELSE -amount_kobo END),0)::text AS bal FROM ledger_entries WHERE account=$1",
      [account],
    );
    return BigInt(r?.bal ?? "0");
  }
  async trialBalance() {
    const r = await this.one(
      `SELECT COALESCE(SUM(amount_kobo) FILTER (WHERE direction='DEBIT'),0)::text AS d,
              COALESCE(SUM(amount_kobo) FILTER (WHERE direction='CREDIT'),0)::text AS c FROM ledger_entries`,
    );
    return { debits: BigInt(r?.d ?? "0"), credits: BigInt(r?.c ?? "0") };
  }

  async createRefund(r: Refund) {
    try {
      await this.q.query(
        `INSERT INTO refunds (id,order_id,payment_id,amount_kobo,reason,kind,status,requested_by,gateway_ref,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.id, r.orderId, r.paymentId, r.amountKobo, r.reason, r.kind, r.status, r.requestedBy, r.gatewayRef, r.createdAt],
      );
    } catch (e) {
      if (isUnique(e)) throw conflict("refund_exists", "Payment already refunded");
      throw e;
    }
    return r;
  }
  async getRefund(id: string) { const r = await this.one("SELECT * FROM refunds WHERE id=$1", [id]); return r ? refundOf(r) : null; }
  async listDueRefunds(now: Date, recordedBefore: Date, maxAttempts: number, limit: number) {
    return (await this.rows(
      `SELECT * FROM refunds WHERE
         (status = 'RECORDED' AND created_at <= $2 AND (next_attempt_at IS NULL OR next_attempt_at <= $1) AND attempts < $3)
         OR (status = 'FAILED' AND next_attempt_at <= $1 AND attempts < $3)
         OR (status = 'SUBMITTING' AND next_attempt_at <= $1)
       ORDER BY created_at LIMIT $4`,
      [now, recordedBefore, maxAttempts, limit],
    )).map(refundOf);
  }
  async claimRefund(id: string, now: Date, leaseUntil: Date, opts: { maxAttempts: number; force: boolean }) {
    // One UPDATE over a row locked with SKIP LOCKED: a concurrent claimer skips the row instead of waiting, so exactly one wins.
    const r = await this.one(
      `UPDATE refunds SET status = 'SUBMITTING', attempts = attempts + 1, next_attempt_at = $3
        WHERE id = (
          SELECT id FROM refunds WHERE id = $1 AND (
            (status IN ('RECORDED','FAILED') AND ($4::boolean OR ((next_attempt_at IS NULL OR next_attempt_at <= $2) AND attempts < $5)))
            OR (status = 'SUBMITTING' AND next_attempt_at <= $2)
            OR ($4::boolean AND status = 'EXHAUSTED')
          ) FOR UPDATE SKIP LOCKED
        ) RETURNING *`,
      [id, now, leaseUntil, opts.force, opts.maxAttempts],
    );
    return r ? refundOf(r) : null;
  }
  async getRefundByOrder(orderId: string) { const r = await this.one("SELECT * FROM refunds WHERE order_id=$1 ORDER BY created_at LIMIT 1", [orderId]); return r ? refundOf(r) : null; }
  async updateRefund(id: string, patch: RefundPatch) {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const col: Record<keyof RefundPatch, string> = { status: "status", gatewayRef: "gateway_ref", nextAttemptAt: "next_attempt_at", lastError: "last_error" };
    for (const k of Object.keys(col) as (keyof RefundPatch)[]) {
      if (patch[k] === undefined) continue; // null is a real value (clears the column)
      vals.push(patch[k]);
      sets.push(`${col[k]}=$${vals.length}`);
    }
    if (sets.length === 0) return this.getRefund(id);
    const r = await this.one(`UPDATE refunds SET ${sets.join(", ")} WHERE id=$1 RETURNING *`, vals);
    return r ? refundOf(r) : null;
  }
  async listRefunds(limit: number) { return (await this.rows("SELECT * FROM refunds ORDER BY created_at DESC LIMIT $1", [limit])).map(refundOf); }

  async addAudit(a: AuditLog) {
    await this.q.query(
      "INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)",
      [a.id, a.actorId, a.action, a.entityType, a.entityId, JSON.stringify(a.metadata), a.createdAt],
    );
  }
  async listAudit(limit: number) {
    return (await this.rows("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1", [limit])).map((r): AuditLog => ({
      id: r.id, actorId: r.actor_id, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      metadata: r.metadata ?? {}, createdAt: dreq(r.created_at),
    }));
  }

  async upsertOtp(o: Otp) {
    await this.q.query(
      `INSERT INTO otps (order_id,ciphertext,expires_at,attempts,locked_until,consumed_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (order_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, expires_at=EXCLUDED.expires_at,
         attempts=EXCLUDED.attempts, locked_until=EXCLUDED.locked_until, consumed_at=EXCLUDED.consumed_at`,
      [o.orderId, o.ciphertext, o.expiresAt, o.attempts, o.lockedUntil, o.consumedAt, o.createdAt],
    );
  }
  async getOtp(orderId: string) { const r = await this.one("SELECT * FROM otps WHERE order_id=$1", [orderId]); return r ? otpOf(r) : null; }
  async recordOtpFailure(orderId: string, now: Date, max: number, lockMs: number) {
    const lockUntil = new Date(now.getTime() + lockMs);
    const next = "(CASE WHEN locked_until IS NOT NULL AND locked_until <= $2 THEN 1 ELSE attempts + 1 END)";
    const r = await this.one(
      `UPDATE otps SET
         locked_until = CASE WHEN ${next} >= $3 THEN $4
                             WHEN locked_until IS NOT NULL AND locked_until <= $2 THEN NULL ELSE locked_until END,
         attempts = ${next}
       WHERE order_id=$1 RETURNING *`,
      [orderId, now, max, lockUntil],
    );
    return r ? otpOf(r) : null;
  }
  async consumeOtp(orderId: string, now: Date) {
    const r = await this.q.query("UPDATE otps SET consumed_at=$2 WHERE order_id=$1 AND consumed_at IS NULL", [orderId, now]);
    return (r.rowCount ?? 0) === 1;
  }

  async counts(): Promise<SystemCounts> {
    const c = await this.one(
      "SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM vendors)::int AS v, (SELECT count(*) FROM couriers)::int AS c",
    );
    const ordersByStatus: SystemCounts["ordersByStatus"] = {};
    for (const r of await this.rows("SELECT status, count(*)::int AS n FROM orders GROUP BY status")) ordersByStatus[r.status as OrderStatus] = r.n;
    return { users: c?.u ?? 0, vendors: c?.v ?? 0, couriers: c?.c ?? 0, ordersByStatus };
  }
}

export function createPostgresStore(pool: Pool): PostgresStore {
  return new PostgresStore(pool, pool);
}
