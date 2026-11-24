import { randomUUID } from "node:crypto";
import type { Store } from "../store/store";
import type { Clock } from "../types";
import { hashPassword } from "./auth";
import { randomBytes } from "node:crypto";

/** Approximate coordinates for Karu and Mararaba (Nasarawa State). Demo data only. */
export const KARU_MARARABA_SEED = [
  { name: "Mararaba Fresh Laundry", address: "Mararaba Market Road, Mararaba", lat: 9.0123, lng: 7.5726, unitPriceKobo: 120000 },
  { name: "Karu Express Wash", address: "Karu Site, Karu", lat: 8.9954, lng: 7.5872, unitPriceKobo: 100000 },
  { name: "Gurku Clean & Press", address: "Gurku Junction, Karu", lat: 9.0301, lng: 7.5517, unitPriceKobo: 150000 },
  { name: "New Karu Dry Cleaners", address: "New Karu, Karu LGA", lat: 9.0058, lng: 7.6019, unitPriceKobo: 130000 },
];

/** Seeds approved demo vendors. Owner accounts get random unusable passwords. */
export async function seedKaruMararaba(store: Store, clock: Clock): Promise<number> {
  if ((await store.listVendors()).length > 0) return 0;
  let n = 0;
  for (const v of KARU_MARARABA_SEED) {
    const id = randomUUID();
    await store.createUser({
      id, email: `seed-${id}@seed.laundrymap.invalid`, phone: `+000${String(n).padStart(2, "0")}${id.slice(0, 8)}`, name: `${v.name} owner`,
      role: "VENDOR", passwordHash: await hashPassword(randomBytes(24).toString("base64")), status: "ACTIVE", createdAt: clock.now(),
    });
    await store.createVendor({ id: randomUUID(), ownerId: id, ...v, status: "APPROVED", createdAt: clock.now() });
    n++;
  }
  return n;
}
