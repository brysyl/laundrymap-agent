import type { Kobo } from "./types";

/**
 * Kobo split math. All amounts are integer kobo. Intermediate products use
 * BigInt so they cannot lose precision before the final safe-integer check.
 *
 * Rules (documented, deterministic):
 *  - total = subtotal + deliveryFee
 *  - courierFee = deliveryFee (courier receives the full delivery fee)
 *  - platformFee = floor(subtotal * platformFeeBps / 10000). The fractional
 *    kobo remainder is dropped from the platform fee, so it stays with the vendor.
 *  - vendorEarnings = subtotal - platformFee
 *  - therefore vendorEarnings + courierFee + platformFee === total, always.
 *  - gatewayFee (Paystack cost) = ceil(total * gatewayBps / 10000) + flat (flat only
 *    if total >= flatThreshold), capped at gatewayCap. Rounded up so the platform
 *    never under-provisions. It is borne by the platform and is NOT deducted from
 *    vendor or courier. It is booked as an expense/payable pair outside the total.
 */
export interface SplitParams {
  platformFeeBps: number;
  gatewayBps: number;
  gatewayFlatKobo: number;
  gatewayFlatThresholdKobo: number;
  gatewayCapKobo: number;
}

export interface Split {
  totalKobo: Kobo;
  platformFeeKobo: Kobo;
  vendorEarningsKobo: Kobo;
  courierFeeKobo: Kobo;
  gatewayFeeKobo: Kobo;
}

export function assertKobo(n: unknown, label = "amount"): asserts n is number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer (kobo)`);
  }
}

function toKobo(v: bigint, label: string): Kobo {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} out of safe range`);
  return Number(v);
}

export function computeSplit(subtotalKobo: Kobo, deliveryFeeKobo: Kobo, p: SplitParams): Split {
  assertKobo(subtotalKobo, "subtotal");
  assertKobo(deliveryFeeKobo, "deliveryFee");
  for (const [k, v] of Object.entries(p)) assertKobo(v, k);
  if (p.platformFeeBps > 10000 || p.gatewayBps > 10000) throw new RangeError("bps must be <= 10000");

  const sub = BigInt(subtotalKobo);
  const del = BigInt(deliveryFeeKobo);
  const total = sub + del;
  const platformFee = (sub * BigInt(p.platformFeeBps)) / 10000n;
  const vendor = sub - platformFee;

  const pct = (total * BigInt(p.gatewayBps) + 9999n) / 10000n;
  const flat = total >= BigInt(p.gatewayFlatThresholdKobo) ? BigInt(p.gatewayFlatKobo) : 0n;
  let gateway = pct + flat;
  if (gateway > BigInt(p.gatewayCapKobo)) gateway = BigInt(p.gatewayCapKobo);

  return {
    totalKobo: toKobo(total, "total"),
    platformFeeKobo: toKobo(platformFee, "platformFee"),
    vendorEarningsKobo: toKobo(vendor, "vendorEarnings"),
    courierFeeKobo: toKobo(del, "courierFee"),
    gatewayFeeKobo: toKobo(gateway, "gatewayFee"),
  };
}

/** Multiply unit price by quantity with overflow protection. */
export function lineTotal(unitPriceKobo: Kobo, quantity: number): Kobo {
  assertKobo(unitPriceKobo, "unitPrice");
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError("quantity must be a positive integer");
  return toKobo(BigInt(unitPriceKobo) * BigInt(quantity), "lineTotal");
}

export function sumKobo(values: Kobo[]): Kobo {
  return toKobo(values.reduce((a, b) => a + BigInt(b), 0n), "sum");
}
