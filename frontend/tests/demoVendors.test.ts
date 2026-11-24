import { describe, expect, it } from "vitest";
import { DEMO_VENDORS } from "../src/lib/demoVendors";
import { estimateTotal, filterVendors, nextStep, prevStep, sortVendors, vendorPrice, DEMO_PICKUP_FEE_KOBO } from "../src/lib/demoFilter";

const byId = (id: string) => DEMO_VENDORS.find((v) => v.id === id)!;

describe("demo data integrity", () => {
  it("has unique ids, all flagged demo, and prices for every offered service", () => {
    expect(new Set(DEMO_VENDORS.map((v) => v.id)).size).toBe(DEMO_VENDORS.length);
    for (const v of DEMO_VENDORS) {
      expect(v.demo).toBe(true);
      expect(v.services.length).toBeGreaterThan(0);
      for (const s of v.services) expect(Number.isInteger(v.prices[s])).toBe(true);
      expect(Object.keys(v.prices).sort()).toEqual([...v.services].sort());
      expect(v.x).toBeGreaterThanOrEqual(0);
      expect(v.x).toBeLessThanOrEqual(100);
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.y).toBeLessThanOrEqual(60);
    }
  });
});

describe("filterVendors", () => {
  it("filters by service", () => {
    const r = filterVendors(DEMO_VENDORS, "dry-clean", "");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((v) => v.services.includes("dry-clean"))).toBe(true);
    expect(r.length).toBeLessThan(DEMO_VENDORS.length);
  });
  it("returns all for all and blank search", () => {
    expect(filterVendors(DEMO_VENDORS, "all", "  ")).toHaveLength(DEMO_VENDORS.length);
  });
  it("searches name and area case-insensitively", () => {
    expect(filterVendors(DEMO_VENDORS, "all", "MARARABA").map((v) => v.id)).toEqual(["dv-mararaba-suds"]);
    expect(filterVendors(DEMO_VENDORS, "all", "abuja").length).toBeGreaterThanOrEqual(2);
  });
  it("combines service and search", () => {
    expect(filterVendors(DEMO_VENDORS, "express", "karu").every((v) => v.services.includes("express"))).toBe(true);
    expect(filterVendors(DEMO_VENDORS, "all", "zzz")).toEqual([]);
  });
});

describe("sortVendors", () => {
  it("sorts by eta ascending without mutating input", () => {
    const copy = [...DEMO_VENDORS];
    const r = sortVendors(DEMO_VENDORS, "eta");
    expect(DEMO_VENDORS).toEqual(copy);
    expect(r[0]!.id).toBe("dv-karu-fresh");
    for (let i = 1; i < r.length; i++) expect(r[i]!.etaMin).toBeGreaterThanOrEqual(r[i - 1]!.etaMin);
  });
  it("sorts by rating descending", () => {
    const r = sortVendors(DEMO_VENDORS, "rating");
    expect(r[0]!.id).toBe("dv-newkaru-dry");
    for (let i = 1; i < r.length; i++) expect(r[i]!.rating).toBeLessThanOrEqual(r[i - 1]!.rating);
  });
  it("sorts by price ascending, per selected service", () => {
    const r = sortVendors(DEMO_VENDORS, "price");
    expect(r[0]!.id).toBe("dv-jikwoyi-pure");
    const e = sortVendors(filterVendors(DEMO_VENDORS, "express", ""), "price", "express");
    expect(e[0]!.id).toBe("dv-karu-fresh");
    expect(vendorPrice(byId("dv-karu-fresh"), "express")).toBe(250000);
  });
});

describe("demo order", () => {
  it("estimates items x unit + pickup fee", () => {
    expect(estimateTotal(byId("dv-karu-fresh"), "wash-fold", 3)).toBe(150000 * 3 + DEMO_PICKUP_FEE_KOBO);
  });
  it("rejects unsupported service and bad item counts", () => {
    expect(estimateTotal(byId("dv-jikwoyi-pure"), "express", 1)).toBeNull();
    expect(estimateTotal(byId("dv-karu-fresh"), "wash-fold", 0)).toBeNull();
    expect(estimateTotal(byId("dv-karu-fresh"), "wash-fold", 1.5)).toBeNull();
    expect(estimateTotal(byId("dv-karu-fresh"), "wash-fold", 51)).toBeNull();
  });
  it("moves between steps within bounds", () => {
    expect(nextStep("service")).toBe("items");
    expect(nextStep("review")).toBe("review");
    expect(prevStep("items")).toBe("service");
    expect(prevStep("service")).toBe("service");
  });
});
