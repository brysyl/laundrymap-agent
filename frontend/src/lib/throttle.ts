/** Decides whether a new position should be sent to the server. */
export interface Fix { lat: number; lng: number; at: number }

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface ThrottleOptions { minIntervalMs: number; minDistanceM: number; heartbeatMs: number }
export const DEFAULT_LOCATION_THROTTLE: ThrottleOptions = { minIntervalMs: 10_000, minDistanceM: 20, heartbeatMs: 60_000 };

/** Send when the courier moved enough and the minimum interval passed, or when the heartbeat is due. */
export function shouldSendLocation(last: Fix | null, next: Fix, o: ThrottleOptions = DEFAULT_LOCATION_THROTTLE): boolean {
  if (!last) return true;
  const dt = next.at - last.at;
  if (dt < o.minIntervalMs) return false;
  if (dt >= o.heartbeatMs) return true;
  return distanceMeters(last, next) >= o.minDistanceM;
}
