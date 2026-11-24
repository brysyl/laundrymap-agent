import type {
  AuditLog, Courier, ApprovalStatus, LedgerEntry, Order, OrderFilter, OrderPatch, Otp, Payment,
  Refund, User, Vendor, VendorNearby, OrderStatus,
} from "../types";

export interface SystemCounts {
  users: number;
  vendors: number;
  couriers: number;
  ordersByStatus: Partial<Record<OrderStatus, number>>;
}

/**
 * Persistence boundary. `tx` runs `fn` atomically against a transaction-bound
 * Store; any thrown error rolls back every write made through that Store.
 */
export interface Store {
  tx<T>(fn: (s: Store) => Promise<T>): Promise<T>;
  ping(): Promise<void>;

  /** Throws ConflictError-shaped HttpError (409) on duplicate email or phone. */
  createUser(u: User): Promise<User>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserByPhone(phone: string): Promise<User | null>;

  createVendor(v: Vendor): Promise<Vendor>;
  getVendor(id: string): Promise<Vendor | null>;
  getVendorByOwner(ownerId: string): Promise<Vendor | null>;
  setVendorStatus(id: string, status: ApprovalStatus): Promise<Vendor | null>;
  listVendors(status?: ApprovalStatus): Promise<Vendor[]>;
  nearbyVendors(lat: number, lng: number, radiusM: number, limit: number): Promise<VendorNearby[]>;

  createCourier(c: Courier): Promise<Courier>;
  getCourierByUser(userId: string): Promise<Courier | null>;
  getCourier(id: string): Promise<Courier | null>;
  setCourierStatus(id: string, status: ApprovalStatus): Promise<Courier | null>;
  listCouriers(status?: ApprovalStatus): Promise<Courier[]>;
  updateCourierLocation(userId: string, lat: number, lng: number, at: Date): Promise<void>;

  createOrder(o: Order): Promise<Order>;
  getOrder(id: string): Promise<Order | null>;
  /** Compare-and-set: applies patch only if current status is in `from`. Bumps version. */
  transitionOrder(id: string, from: OrderStatus[], patch: OrderPatch, now: Date): Promise<Order | null>;
  listOrders(f: OrderFilter): Promise<Order[]>;
  listExpiredAwaiting(now: Date, limit: number): Promise<Order[]>;

  createPayment(p: Payment): Promise<Payment>;
  getPaymentByReference(reference: string): Promise<Payment | null>;
  getPaymentByOrder(orderId: string): Promise<Payment | null>;
  updatePayment(id: string, patch: Partial<Pick<Payment, "status" | "gatewayTransactionId" | "paidAt">>): Promise<Payment | null>;

  /** Returns false when the event id was already recorded (idempotency key). */
  recordWebhookEvent(eventId: string, reference: string | null, payload: unknown, at: Date): Promise<boolean>;

  /** Append-only. There is intentionally no update or delete. */
  appendLedger(entries: LedgerEntry[]): Promise<void>;
  listLedger(f: { orderId?: string; account?: string; limit?: number }): Promise<LedgerEntry[]>;
  /** credits minus debits */
  accountBalance(account: string): Promise<bigint>;
  trialBalance(): Promise<{ debits: bigint; credits: bigint }>;

  createRefund(r: Refund): Promise<Refund>;
  getRefundByOrder(orderId: string): Promise<Refund | null>;
  updateRefund(id: string, patch: Partial<Pick<Refund, "status" | "gatewayRef">>): Promise<Refund | null>;
  listRefunds(limit: number): Promise<Refund[]>;

  addAudit(a: AuditLog): Promise<void>;
  listAudit(limit: number): Promise<AuditLog[]>;

  upsertOtp(o: Otp): Promise<void>;
  getOtp(orderId: string): Promise<Otp | null>;
  /** Atomically increments attempts (resetting after an expired lock) and locks at `max`. */
  recordOtpFailure(orderId: string, now: Date, max: number, lockMs: number): Promise<Otp | null>;
  /** Atomic single-use consume. Returns false if already consumed. */
  consumeOtp(orderId: string, now: Date): Promise<boolean>;

  counts(): Promise<SystemCounts>;
}
