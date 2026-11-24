import { DemoVendor, ServiceType } from "./demoVendors";

export type ServiceFilter = ServiceType | "all";
export type SortKey = "eta" | "rating" | "price";

/** Per-item price in kobo for the selected service, or the cheapest offered when "all". */
export function vendorPrice(v: DemoVendor, service: ServiceFilter = "all"): number {
  if (service !== "all") return v.prices[service] ?? Number.POSITIVE_INFINITY;
  const all = Object.values(v.prices) as number[];
  return all.length ? Math.min(...all) : Number.POSITIVE_INFINITY;
}

export function filterVendors(vendors: DemoVendor[], service: ServiceFilter, search: string): DemoVendor[] {
  const q = search.trim().toLowerCase();
  return vendors.filter((v) => {
    if (service !== "all" && !v.services.includes(service)) return false;
    if (!q) return true;
    return v.name.toLowerCase().includes(q) || v.area.toLowerCase().includes(q);
  });
}

export function sortVendors(vendors: DemoVendor[], key: SortKey, service: ServiceFilter = "all"): DemoVendor[] {
  const out = [...vendors];
  out.sort((a, b) => {
    const d =
      key === "eta" ? a.etaMin - b.etaMin :
      key === "rating" ? b.rating - a.rating :
      vendorPrice(a, service) - vendorPrice(b, service);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  return out;
}

export const PICKUP_SLOTS = ["Today 4pm - 6pm", "Tomorrow 9am - 11am", "Tomorrow 2pm - 4pm"] as const;
export const DEMO_PICKUP_FEE_KOBO = 50000;

export const ORDER_STEPS = ["service", "items", "slot", "review"] as const;
export type OrderStep = (typeof ORDER_STEPS)[number];

/** Estimated total in kobo: items x unit price + pickup fee. Null if vendor lacks the service or items invalid. */
export function estimateTotal(v: DemoVendor, service: ServiceType, items: number): number | null {
  const unit = v.prices[service];
  if (unit === undefined || !Number.isInteger(items) || items < 1 || items > 50) return null;
  return unit * items + DEMO_PICKUP_FEE_KOBO;
}

export function nextStep(step: OrderStep): OrderStep {
  const i = ORDER_STEPS.indexOf(step);
  return ORDER_STEPS[Math.min(i + 1, ORDER_STEPS.length - 1)] ?? step;
}

export function prevStep(step: OrderStep): OrderStep {
  const i = ORDER_STEPS.indexOf(step);
  return ORDER_STEPS[Math.max(i - 1, 0)] ?? step;
}
