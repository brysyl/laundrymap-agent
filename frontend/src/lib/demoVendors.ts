/** Local demo data for the home page map. Not live vendor data. Prices are integer kobo per item. */
export type ServiceType = "wash-fold" | "dry-clean" | "express";

export const SERVICE_LABELS: Record<ServiceType, string> = {
  "wash-fold": "Wash & Fold",
  "dry-clean": "Dry Cleaning",
  express: "Express",
};

export interface DemoVendor {
  id: string;
  name: string;
  area: string;
  demo: true;
  services: ServiceType[];
  /** Price per item in kobo, for each offered service. */
  prices: Partial<Record<ServiceType, number>>;
  rating: number;
  reviews: number;
  distanceKm: number;
  etaMin: number;
  turnaround24hr: boolean;
  verified: boolean;
  /** Position on the 100 x 60 SVG corridor map. */
  x: number;
  y: number;
}

export const DEMO_VENDORS: DemoVendor[] = [
  { id: "dv-karu-fresh", name: "Karu Fresh Laundry", area: "Karu", demo: true, services: ["wash-fold", "express"], prices: { "wash-fold": 150000, express: 250000 }, rating: 4.7, reviews: 213, distanceKm: 0.8, etaMin: 15, turnaround24hr: true, verified: true, x: 58, y: 24 },
  { id: "dv-mararaba-suds", name: "Mararaba Suds & Press", area: "Mararaba", demo: true, services: ["wash-fold", "dry-clean"], prices: { "wash-fold": 130000, "dry-clean": 350000 }, rating: 4.4, reviews: 156, distanceKm: 1.9, etaMin: 28, turnaround24hr: false, verified: true, x: 40, y: 34 },
  { id: "dv-gurku-express", name: "Gurku Express Wash", area: "Gurku", demo: true, services: ["express", "wash-fold"], prices: { express: 280000, "wash-fold": 160000 }, rating: 4.2, reviews: 88, distanceKm: 2.6, etaMin: 22, turnaround24hr: true, verified: false, x: 72, y: 14 },
  { id: "dv-newkaru-dry", name: "New Karu Dry Cleaners", area: "New Karu", demo: true, services: ["dry-clean", "wash-fold"], prices: { "dry-clean": 400000, "wash-fold": 180000 }, rating: 4.8, reviews: 301, distanceKm: 1.4, etaMin: 35, turnaround24hr: false, verified: true, x: 66, y: 38 },
  { id: "dv-nyanya-quick", name: "Nyanya Quick Clean", area: "Nyanya, Abuja side", demo: true, services: ["express", "wash-fold", "dry-clean"], prices: { express: 300000, "wash-fold": 170000, "dry-clean": 380000 }, rating: 4.5, reviews: 190, distanceKm: 4.1, etaMin: 40, turnaround24hr: true, verified: true, x: 24, y: 22 },
  { id: "dv-jikwoyi-pure", name: "Jikwoyi Pure Wash", area: "Jikwoyi, Abuja side", demo: true, services: ["wash-fold"], prices: { "wash-fold": 120000 }, rating: 4.0, reviews: 64, distanceKm: 3.3, etaMin: 45, turnaround24hr: false, verified: false, x: 14, y: 40 },
  { id: "dv-mpape-premium", name: "Mpape Premium Care", area: "Mpape side, Abuja", demo: true, services: ["dry-clean", "express"], prices: { "dry-clean": 450000, express: 320000 }, rating: 4.6, reviews: 122, distanceKm: 6.2, etaMin: 55, turnaround24hr: true, verified: true, x: 12, y: 10 },
  { id: "dv-karu-bubbles", name: "Bubbles & Co Karu", area: "Karu", demo: true, services: ["wash-fold", "dry-clean", "express"], prices: { "wash-fold": 140000, "dry-clean": 360000, express: 260000 }, rating: 4.3, reviews: 97, distanceKm: 1.1, etaMin: 18, turnaround24hr: true, verified: true, x: 50, y: 46 },
];
