import { describe, expect, it } from "vitest";
import { computeSplit, lineTotal, sumKobo, type SplitParams } from "../src/money";

const P: SplitParams = { platformFeeBps: 1000, gatewayBps: 150, gatewayFlatKobo: 10000, gatewayFlatThresholdKobo: 250000, gatewayCapKobo: 200000 };

// Small deterministic PRNG so failures are reproducible.
function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe("kobo split math", () => {
  it("splits a known order exactly", () => {
    const s = computeSplit(240000, 100000, P);
    expect(s).toEqual({ totalKobo: 340000, platformFeeKobo: 24000, vendorEarningsKobo: 216000, courierFeeKobo: 100000, gatewayFeeKobo: 15100 });
  });

  it("floors the platform fee so the remainder stays with the vendor", () => {
    const s = computeSplit(1999, 0, { ...P, platformFeeBps: 1000 }); // 199.9 -> 199
    expect(s.platformFeeKobo).toBe(199);
    expect(s.vendorEarningsKobo).toBe(1800);
  });

  it("always conserves money: vendor + courier + platform === total (property)", () => {
    const rnd = prng(42);
    for (let i = 0; i < 5000; i++) {
      const sub = Math.floor(rnd() * 5_000_000_000);
      const del = Math.floor(rnd() * 10_000_000);
      const bps = Math.floor(rnd() * 10001);
      const s = computeSplit(sub, del, { ...P, platformFeeBps: bps });
      expect(s.vendorEarningsKobo + s.courierFeeKobo + s.platformFeeKobo).toBe(s.totalKobo);
      expect(Number.isInteger(s.platformFeeKobo) && Number.isInteger(s.gatewayFeeKobo)).toBe(true);
      expect(s.platformFeeKobo).toBeLessThanOrEqual(sub);
      expect(s.gatewayFeeKobo).toBeLessThanOrEqual(P.gatewayCapKobo);
    }
  });

  it("is bigint-safe near the safe-integer limit", () => {
    const sub = Number.MAX_SAFE_INTEGER - 1000;
    const s = computeSplit(sub, 500, { ...P, platformFeeBps: 1234 });
    expect(s.vendorEarningsKobo + s.courierFeeKobo + s.platformFeeKobo).toBe(s.totalKobo);
    expect(Number.isSafeInteger(s.totalKobo)).toBe(true);
  });

  it("rejects totals beyond the safe-integer range instead of losing precision", () => {
    expect(() => computeSplit(Number.MAX_SAFE_INTEGER, 10, P)).toThrow(RangeError);
    expect(() => lineTotal(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });

  it("rejects floats, negatives and NaN", () => {
    expect(() => computeSplit(10.5, 0, P)).toThrow(RangeError);
    expect(() => computeSplit(-1, 0, P)).toThrow(RangeError);
    expect(() => computeSplit(Number.NaN, 0, P)).toThrow(RangeError);
    expect(() => lineTotal(100, 1.5)).toThrow(RangeError);
  });

  it("gateway fee: ceil percentage, flat only above threshold, capped", () => {
    expect(computeSplit(100000, 0, P).gatewayFeeKobo).toBe(1500); // under threshold: no flat fee
    expect(computeSplit(250001, 0, P).gatewayFeeKobo).toBe(Math.ceil(250001 * 0.015) + 10000);
    expect(computeSplit(900_000_000, 0, P).gatewayFeeKobo).toBe(200000);
  });

  it("sums line items exactly", () => {
    expect(sumKobo([lineTotal(120000, 2), lineTotal(5, 3)])).toBe(240015);
  });
});
