export type Role = "CUSTOMER" | "VENDOR" | "COURIER" | "ADMIN";
export type ApprovalStatus = "PENDING" | "APPROVED" | "SUSPENDED";

/** All money fields are integer kobo (1 NGN = 100 kobo). Never floats. */
export type Kobo = number;

export interface User {
  id: string;
  email: string;
  phone: string;
  name: string;
  role: Role;
  passwordHash: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: Date;
}

export interface Vendor {
  id: string;
  ownerId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  unitPriceKobo: Kobo;
  status: ApprovalStatus;
  createdAt: Date;
}

export interface VendorNearby extends Vendor {
  distanceM: number;
}

export interface Courier {
  id: string;
  userId: string;
  status: ApprovalStatus;
  lat: number | null;
  lng: number | null;
  locationAt: Date | null;
  createdAt: Date;
}

export type OrderStatus =
  | "PENDING_PAYMENT"
  | "AWAITING_VENDOR"
  | "ACCEPTED"
  | "IN_PROGRESS"
  | "READY_FOR_PICKUP"
  | "COURIER_ASSIGNED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED"
  | "REFUNDED";

export interface OrderItem {
  id: string;
  orderId: string;
  name: string;
  quantity: number;
  unitPriceKobo: Kobo;
}

export interface Order {
  id: string;
  customerId: string;
  vendorId: string;
  /** User id of the assigned courier. */
  courierId: string | null;
  status: OrderStatus;
  subtotalKobo: Kobo;
  deliveryFeeKobo: Kobo;
  totalKobo: Kobo;
  dropoffAddress: string;
  dropoffLat: number;
  dropoffLng: number;
  acceptDeadline: Date | null;
  cancelReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  items: OrderItem[];
}

export type OrderPatch = Partial<Pick<Order, "status" | "courierId" | "acceptDeadline" | "cancelReason">>;

export interface OrderFilter {
  customerId?: string;
  vendorId?: string;
  courierId?: string;
  statuses?: OrderStatus[];
  /** Only orders with no courier assigned. */
  unassigned?: boolean;
  limit?: number;
}

export type PaymentStatus = "PENDING" | "PAID" | "FAILED" | "MISMATCH" | "MISMATCH_REFUNDED";

export interface Payment {
  id: string;
  orderId: string;
  reference: string;
  amountKobo: Kobo;
  /** Amount the gateway reported for a MISMATCH charge (NGN only). Null otherwise. */
  receivedKobo: Kobo | null;
  status: PaymentStatus;
  authorizationUrl: string | null;
  gatewayTransactionId: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export type LedgerType =
  | "ORDER_PAYMENT"
  | "PLATFORM_FEE"
  | "VENDOR_EARNINGS"
  | "COURIER_FEE"
  | "GATEWAY_FEE"
  | "REFUND"
  | "PAYOUT";

export interface LedgerEntry {
  id: string;
  txId: string;
  orderId: string | null;
  account: string;
  direction: "CREDIT" | "DEBIT";
  amountKobo: Kobo;
  type: LedgerType;
  memo: string;
  createdAt: Date;
}

export type RefundKind = "AUTO_TIMEOUT" | "AUTO_REJECT" | "ADMIN" | "LATE_PAYMENT" | "MISMATCH";

export interface Refund {
  id: string;
  orderId: string;
  paymentId: string;
  amountKobo: Kobo;
  reason: string;
  kind: RefundKind;
  /** SUBMITTING is a claim held by one submitter until `nextAttemptAt` (the lease end). EXHAUSTED needs an operator. */
  status: "RECORDED" | "SUBMITTING" | "SUBMITTED" | "FAILED" | "EXHAUSTED";
  requestedBy: string | null;
  gatewayRef: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface AuditLog {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface Otp {
  orderId: string;
  /** base64(iv).base64(tag).base64(ciphertext), AES-256-GCM. */
  ciphertext: string;
  expiresAt: Date;
  attempts: number;
  lockedUntil: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
