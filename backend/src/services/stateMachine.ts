import type { OrderStatus } from "../types";

/** Allowed order status transitions. Anything not listed is rejected. */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ["AWAITING_VENDOR", "CANCELLED"],
  AWAITING_VENDOR: ["ACCEPTED", "REFUNDED"],
  ACCEPTED: ["IN_PROGRESS", "REFUNDED"],
  IN_PROGRESS: ["READY_FOR_PICKUP", "REFUNDED"],
  READY_FOR_PICKUP: ["COURIER_ASSIGNED", "REFUNDED"],
  COURIER_ASSIGNED: ["OUT_FOR_DELIVERY", "REFUNDED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "REFUNDED"],
  DELIVERED: [],
  CANCELLED: ["REFUNDED"], // only for a late payment that arrives after cancellation
  REFUNDED: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => TRANSITIONS[from].includes(to);

/** Statuses in which funds sit in escrow and an operator may refund. */
export const REFUNDABLE: OrderStatus[] = [
  "AWAITING_VENDOR", "ACCEPTED", "IN_PROGRESS", "READY_FOR_PICKUP", "COURIER_ASSIGNED", "OUT_FOR_DELIVERY",
];

/** All statuses that can legally precede `to`. Used as the compare-and-set guard. */
export const predecessors = (to: OrderStatus): OrderStatus[] =>
  (Object.keys(TRANSITIONS) as OrderStatus[]).filter((s) => canTransition(s, to));
