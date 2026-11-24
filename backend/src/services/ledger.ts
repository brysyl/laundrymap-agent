import { randomUUID } from "node:crypto";
import type { Kobo, LedgerEntry, LedgerType, Order } from "../types";
import type { Store } from "../store/store";
import type { Split } from "../money";
import { assertKobo } from "../money";

/**
 * Double-entry ledger. Each posting is a group of lines sharing a tx_id where
 * sum(DEBIT) === sum(CREDIT). Account balance is credits minus debits.
 *
 * Accounts:
 *  cash:paystack                 asset: money held at the gateway (debited when a payment lands)
 *  escrow:order:<orderId>        customer funds held until delivery or refund
 *  vendor:<vendorId>:payable     owed to vendor
 *  courier:<userId>:payable      owed to courier
 *  platform:revenue              platform fee income
 *  expense:gateway_fees          gateway cost borne by the platform
 *  payable:paystack_fees         owed to the gateway
 *  payable:customer_refunds      owed back to customers
 *  clearing:payouts              money paid out to vendors and couriers
 */
export const acct = {
  cash: "cash:paystack",
  escrow: (orderId: string) => `escrow:order:${orderId}`,
  vendor: (vendorId: string) => `vendor:${vendorId}:payable`,
  courier: (userId: string) => `courier:${userId}:payable`,
  revenue: "platform:revenue",
  gatewayExpense: "expense:gateway_fees",
  gatewayPayable: "payable:paystack_fees",
  refunds: "payable:customer_refunds",
  payouts: "clearing:payouts",
};

export interface Line {
  account: string;
  direction: "CREDIT" | "DEBIT";
  amountKobo: Kobo;
  type: LedgerType;
  memo: string;
}

export function assertBalanced(lines: Line[]): void {
  if (lines.length < 2) throw new Error("ledger posting needs at least two lines");
  let d = 0n, c = 0n;
  for (const l of lines) {
    assertKobo(l.amountKobo, "ledger amount");
    if (l.amountKobo <= 0) throw new Error("ledger amounts must be positive");
    if (l.direction === "DEBIT") d += BigInt(l.amountKobo); else c += BigInt(l.amountKobo);
  }
  if (d !== c) throw new Error(`unbalanced ledger posting: debits ${d} credits ${c}`);
}

export async function post(store: Store, orderId: string | null, lines: Line[], now: Date): Promise<string> {
  assertBalanced(lines);
  const txId = randomUUID();
  const entries: LedgerEntry[] = lines.map((l) => ({ id: randomUUID(), txId, orderId, createdAt: now, ...l }));
  await store.appendLedger(entries);
  return txId;
}

export const paymentLines = (order: Order, amount: Kobo): Line[] => [
  { account: acct.cash, direction: "DEBIT", amountKobo: amount, type: "ORDER_PAYMENT", memo: `payment for order ${order.id}` },
  { account: acct.escrow(order.id), direction: "CREDIT", amountKobo: amount, type: "ORDER_PAYMENT", memo: "held in escrow" },
];

export function settlementLines(order: Order, courierId: string, s: Split): Line[] {
  const lines: Line[] = [
    { account: acct.escrow(order.id), direction: "DEBIT", amountKobo: s.totalKobo, type: "ORDER_PAYMENT", memo: "escrow released on delivery" },
    { account: acct.vendor(order.vendorId), direction: "CREDIT", amountKobo: s.vendorEarningsKobo, type: "VENDOR_EARNINGS", memo: "vendor earnings" },
    { account: acct.courier(courierId), direction: "CREDIT", amountKobo: s.courierFeeKobo, type: "COURIER_FEE", memo: "delivery fee" },
    { account: acct.revenue, direction: "CREDIT", amountKobo: s.platformFeeKobo, type: "PLATFORM_FEE", memo: "platform fee" },
  ];
  if (s.gatewayFeeKobo > 0) {
    lines.push(
      { account: acct.gatewayExpense, direction: "DEBIT", amountKobo: s.gatewayFeeKobo, type: "GATEWAY_FEE", memo: "gateway fee expense" },
      { account: acct.gatewayPayable, direction: "CREDIT", amountKobo: s.gatewayFeeKobo, type: "GATEWAY_FEE", memo: "gateway fee payable" },
    );
  }
  // Zero-amount lines (e.g. zero platform fee) are not representable; drop them.
  return lines.filter((l) => l.amountKobo > 0);
}

export const refundLines = (order: Order, amount: Kobo, reason: string): Line[] => [
  { account: acct.escrow(order.id), direction: "DEBIT", amountKobo: amount, type: "REFUND", memo: `refund: ${reason}` },
  { account: acct.refunds, direction: "CREDIT", amountKobo: amount, type: "REFUND", memo: `owed to customer ${order.customerId}` },
];

export const payoutLines = (payableAccount: string, amount: Kobo): Line[] => [
  { account: payableAccount, direction: "DEBIT", amountKobo: amount, type: "PAYOUT", memo: "payout" },
  { account: acct.payouts, direction: "CREDIT", amountKobo: amount, type: "PAYOUT", memo: "paid out" },
];
