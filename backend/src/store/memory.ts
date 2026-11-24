import { AsyncLocalStorage } from "node:async_hooks";
import { conflict } from "../errors";
import type {
  ApprovalStatus, AuditLog, Courier, LedgerEntry, Order, OrderFilter, OrderPatch, OrderStatus, Otp,
  Payment, Refund, User, Vendor, VendorNearby,
} from "../types";
import type { Store, SystemCounts } from "./store";
import { haversineMeters } from "../geo";

interface State {
  users: Map<string, User>;
  vendors: Map<string, Vendor>;
  couriers: Map<string, Courier>;
  orders: Map<string, Order>;
  payments: Map<string, Payment>;
  webhookEvents: Map<string, { reference: string | null; payload: unknown; at: Date }>;
  ledger: LedgerEntry[];
  refunds: Map<string, Refund>;
  audit: AuditLog[];
  otps: Map<string, Otp>;
}

const clone = <T>(v: T): T => structuredClone(v);

function emptyState(): State {
  return {
    users: new Map(), vendors: new Map(), couriers: new Map(), orders: new Map(), payments: new Map(),
    webhookEvents: new Map(), ledger: [], refunds: new Map(), audit: [], otps: new Map(),
  };
}

function snapshot(s: State): State {
  return {
    users: clone(s.users), vendors: clone(s.vendors), couriers: clone(s.couriers), orders: clone(s.orders),
    payments: clone(s.payments), webhookEvents: clone(s.webhookEvents), ledger: clone(s.ledger),
    refunds: clone(s.refunds), audit: clone(s.audit), otps: clone(s.otps),
  };
}

/** In-memory Store used by tests and local development without Postgres. */
export class MemoryStore implements Store {
  private state: State;
  private lock: Promise<unknown> = Promise.resolve();
  private als = new AsyncLocalStorage<boolean>();

  constructor(state?: State) {
    this.state = state ?? emptyState();
  }

  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn(this);
    const run = async (): Promise<T> => {
      const before = snapshot(this.state);
      try {
        return await this.als.run(true, () => fn(this));
      } catch (err) {
        this.state = before;
        throw err;
      }
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => undefined);
    return p;
  }

  async ping(): Promise<void> {}

  async createUser(u: User) {
    for (const x of this.state.users.values()) {
      if (x.email.toLowerCase() === u.email.toLowerCase()) throw conflict("email_taken", "Email already registered");
      if (x.phone === u.phone) throw conflict("phone_taken", "Phone already registered");
    }
    this.state.users.set(u.id, clone(u));
    return clone(u);
  }
  async getUser(id: string) { return clone(this.state.users.get(id) ?? null); }
  async getUserByEmail(email: string) {
    for (const u of this.state.users.values()) if (u.email.toLowerCase() === email.toLowerCase()) return clone(u);
    return null;
  }
  async getUserByPhone(phone: string) {
    for (const u of this.state.users.values()) if (u.phone === phone) return clone(u);
    return null;
  }

  async createVendor(v: Vendor) { this.state.vendors.set(v.id, clone(v)); return clone(v); }
  async getVendor(id: string) { return clone(this.state.vendors.get(id) ?? null); }
  async getVendorByOwner(ownerId: string) {
    for (const v of this.state.vendors.values()) if (v.ownerId === ownerId) return clone(v);
    return null;
  }
  async setVendorStatus(id: string, status: ApprovalStatus) {
    const v = this.state.vendors.get(id);
    if (!v) return null;
    v.status = status;
    return clone(v);
  }
  async listVendors(status?: ApprovalStatus) {
    return [...this.state.vendors.values()].filter((v) => !status || v.status === status).map(clone);
  }
  async nearbyVendors(lat: number, lng: number, radiusM: number, limit: number): Promise<VendorNearby[]> {
    return [...this.state.vendors.values()]
      .filter((v) => v.status === "APPROVED")
      .map((v) => ({ ...clone(v), distanceM: haversineMeters(lat, lng, v.lat, v.lng) }))
      .filter((v) => v.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit);
  }

  async createCourier(c: Courier) { this.state.couriers.set(c.id, clone(c)); return clone(c); }
  async getCourierByUser(userId: string) {
    for (const c of this.state.couriers.values()) if (c.userId === userId) return clone(c);
    return null;
  }
  async getCourier(id: string) { return clone(this.state.couriers.get(id) ?? null); }
  async setCourierStatus(id: string, status: ApprovalStatus) {
    const c = this.state.couriers.get(id);
    if (!c) return null;
    c.status = status;
    return clone(c);
  }
  async listCouriers(status?: ApprovalStatus) {
    return [...this.state.couriers.values()].filter((c) => !status || c.status === status).map(clone);
  }
  async updateCourierLocation(userId: string, lat: number, lng: number, at: Date) {
    for (const c of this.state.couriers.values()) {
      if (c.userId === userId) { c.lat = lat; c.lng = lng; c.locationAt = at; }
    }
  }

  async createOrder(o: Order) { this.state.orders.set(o.id, clone(o)); return clone(o); }
  async getOrder(id: string) { return clone(this.state.orders.get(id) ?? null); }
  async transitionOrder(id: string, from: OrderStatus[], patch: OrderPatch, now: Date) {
    const o = this.state.orders.get(id);
    if (!o || !from.includes(o.status)) return null;
    if (patch.status !== undefined) o.status = patch.status;
    if (patch.courierId !== undefined) o.courierId = patch.courierId;
    if (patch.acceptDeadline !== undefined) o.acceptDeadline = patch.acceptDeadline;
    if (patch.cancelReason !== undefined) o.cancelReason = patch.cancelReason;
    o.version += 1;
    o.updatedAt = now;
    return clone(o);
  }
  async listOrders(f: OrderFilter) {
    return [...this.state.orders.values()]
      .filter((o) =>
        (!f.customerId || o.customerId === f.customerId) &&
        (!f.vendorId || o.vendorId === f.vendorId) &&
        (!f.courierId || o.courierId === f.courierId) &&
        (!f.statuses || f.statuses.includes(o.status)) &&
        (!f.unassigned || o.courierId === null))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, f.limit ?? 100)
      .map(clone);
  }
  async listExpiredAwaiting(now: Date, limit: number) {
    return [...this.state.orders.values()]
      .filter((o) => o.status === "AWAITING_VENDOR" && o.acceptDeadline !== null && o.acceptDeadline.getTime() <= now.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async createPayment(p: Payment) {
    if (p.status === "PENDING") {
      for (const x of this.state.payments.values()) {
        if (x.orderId === p.orderId && x.status === "PENDING") throw conflict("payment_pending", "Order already has a pending payment");
      }
    }
    this.state.payments.set(p.id, clone(p));
    return clone(p);
  }
  async getPayment(id: string) { return clone(this.state.payments.get(id) ?? null); }
  async getPaidPaymentByOrder(orderId: string) {
    for (const p of this.state.payments.values()) if (p.orderId === orderId && p.status === "PAID") return clone(p);
    return null;
  }
  async listPaymentsByStatus(status: Payment["status"], limit: number) {
    return [...this.state.payments.values()].filter((p) => p.status === status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit).map(clone);
  }
  async getPaymentByReference(reference: string) {
    for (const p of this.state.payments.values()) if (p.reference === reference) return clone(p);
    return null;
  }
  async getPaymentByOrder(orderId: string) {
    const list = [...this.state.payments.values()].filter((p) => p.orderId === orderId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return clone(list[0] ?? null);
  }
  async updatePayment(id: string, patch: Partial<Pick<Payment, "status" | "gatewayTransactionId" | "paidAt">>) {
    const p = this.state.payments.get(id);
    if (!p) return null;
    Object.assign(p, patch);
    return clone(p);
  }

  async recordWebhookEvent(eventId: string, reference: string | null, payload: unknown, at: Date) {
    if (this.state.webhookEvents.has(eventId)) return false;
    this.state.webhookEvents.set(eventId, { reference, payload: clone(payload), at });
    return true;
  }

  async appendLedger(entries: LedgerEntry[]) { this.state.ledger.push(...entries.map(clone)); }
  async listLedger(f: { orderId?: string; account?: string; limit?: number }) {
    return this.state.ledger
      .filter((e) => (!f.orderId || e.orderId === f.orderId) && (!f.account || e.account === f.account))
      .slice(-(f.limit ?? 500)).map(clone);
  }
  /** Transactions are already serialized by the store-wide lock. */
  async lockAccount(_account: string) {}
  async accountBalance(account: string) {
    let b = 0n;
    for (const e of this.state.ledger) {
      if (e.account !== account) continue;
      b += e.direction === "CREDIT" ? BigInt(e.amountKobo) : -BigInt(e.amountKobo);
    }
    return b;
  }
  async trialBalance() {
    let debits = 0n, credits = 0n;
    for (const e of this.state.ledger) {
      if (e.direction === "DEBIT") debits += BigInt(e.amountKobo); else credits += BigInt(e.amountKobo);
    }
    return { debits, credits };
  }

  async createRefund(r: Refund) {
    for (const x of this.state.refunds.values()) if (x.orderId === r.orderId) throw conflict("refund_exists", "Order already refunded");
    this.state.refunds.set(r.id, clone(r));
    return clone(r);
  }
  async getRefund(id: string) { return clone(this.state.refunds.get(id) ?? null); }
  async listRefundsByStatus(statuses: Refund["status"][], olderThan: Date, limit: number) {
    return [...this.state.refunds.values()]
      .filter((r) => statuses.includes(r.status) && r.createdAt.getTime() <= olderThan.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit).map(clone);
  }
  async getRefundByOrder(orderId: string) {
    for (const r of this.state.refunds.values()) if (r.orderId === orderId) return clone(r);
    return null;
  }
  async updateRefund(id: string, patch: Partial<Pick<Refund, "status" | "gatewayRef">>) {
    const r = this.state.refunds.get(id);
    if (!r) return null;
    Object.assign(r, patch);
    return clone(r);
  }
  async listRefunds(limit: number) { return [...this.state.refunds.values()].slice(-limit).map(clone); }

  async addAudit(a: AuditLog) { this.state.audit.push(clone(a)); }
  async listAudit(limit: number) { return this.state.audit.slice(-limit).reverse().map(clone); }

  async upsertOtp(o: Otp) { this.state.otps.set(o.orderId, clone(o)); }
  async getOtp(orderId: string) { return clone(this.state.otps.get(orderId) ?? null); }
  async recordOtpFailure(orderId: string, now: Date, max: number, lockMs: number) {
    const o = this.state.otps.get(orderId);
    if (!o) return null;
    if (o.lockedUntil && o.lockedUntil.getTime() <= now.getTime()) { o.attempts = 0; o.lockedUntil = null; }
    o.attempts += 1;
    if (o.attempts >= max) o.lockedUntil = new Date(now.getTime() + lockMs);
    return clone(o);
  }
  async consumeOtp(orderId: string, now: Date) {
    const o = this.state.otps.get(orderId);
    if (!o || o.consumedAt) return false;
    o.consumedAt = now;
    return true;
  }

  async counts(): Promise<SystemCounts> {
    const ordersByStatus: SystemCounts["ordersByStatus"] = {};
    for (const o of this.state.orders.values()) ordersByStatus[o.status] = (ordersByStatus[o.status] ?? 0) + 1;
    return { users: this.state.users.size, vendors: this.state.vendors.size, couriers: this.state.couriers.size, ordersByStatus };
  }
}
