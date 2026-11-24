import { describe, expect, it } from "vitest";
import { formatClock, offsetFromServerTime, secondsLeft } from "../src/lib/countdown";
import { formatNaira } from "../src/lib/money";
import { wireSocket, type ConnState } from "../src/lib/realtimeSync";
import { bannerMessage } from "../src/lib/connectionStore";
import { shouldSendLocation } from "../src/lib/throttle";

class FakeSocket {
  h: Record<string, ((...a: any[]) => void)[]> = {}; emitted: any[][] = []; disconnected = false;
  on(e: string, f: (...a: any[]) => void) { (this.h[e] ??= []).push(f); return this; }
  emit(...a: any[]) { this.emitted.push(a); return this; }
  disconnect() { this.disconnected = true; }
  fire(e: string, ...a: any[]) { (this.h[e] ?? []).forEach((f) => f(...a)); }
}

describe("realtime reconnect", () => {
  it("re-joins order rooms and triggers REST sync on every connect", () => {
    const s = new FakeSocket(); let syncs = 0; const states: ConnState[] = []; const events: string[] = [];
    wireSocket(s, { onSync: () => { syncs++; }, onState: (x) => states.push(x), onEvent: (e) => events.push(e) }, () => ["o1"]);
    s.fire("connect"); s.fire("disconnect"); s.fire("connect");
    expect(syncs).toBe(2);
    expect(states).toEqual(["connected", "reconnecting", "connected"]);
    expect(s.emitted.filter((e) => e[0] === "order:join")).toHaveLength(2);
    s.fire("order:update", {});
    expect(events).toEqual(["order:update"]);
  });
  it("cleanup disconnects", () => {
    const s = new FakeSocket();
    wireSocket(s, { onSync() {}, onState() {}, onEvent() {} })();
    expect(s.disconnected).toBe(true);
  });
});

describe("connection banner", () => {
  it("reports offline, reconnecting and queued states", () => {
    expect(bannerMessage({ online: true, realtime: "connected", queued: 0 })).toBeNull();
    expect(bannerMessage({ online: false, realtime: "connected", queued: 0 })?.tone).toBe("offline");
    expect(bannerMessage({ online: true, realtime: "reconnecting", queued: 0 })?.text).toMatch(/Reconnecting/);
    expect(bannerMessage({ online: false, realtime: "disconnected", queued: 2 })?.text).toMatch(/2 action/);
  });
});

describe("location throttle", () => {
  const a = { lat: 9, lng: 7.5, at: 0 };
  it("sends first fix, suppresses rapid or tiny moves, sends on movement and heartbeat", () => {
    expect(shouldSendLocation(null, a)).toBe(true);
    expect(shouldSendLocation(a, { ...a, lat: 9.01, at: 5_000 })).toBe(false);
    expect(shouldSendLocation(a, { ...a, at: 20_000 })).toBe(false);
    expect(shouldSendLocation(a, { ...a, lat: 9.001, at: 20_000 })).toBe(true);
    expect(shouldSendLocation(a, { ...a, at: 61_000 })).toBe(true);
  });
});

describe("countdown and money", () => {
  it("computes seconds left using server offset and never goes negative", () => {
    const deadline = "2025-01-01T00:02:00.000Z"; const t0 = Date.parse("2025-01-01T00:00:00.000Z");
    expect(secondsLeft(deadline, t0)).toBe(120);
    expect(secondsLeft(deadline, t0, 30_000)).toBe(90);
    expect(secondsLeft(deadline, t0 + 999_999)).toBe(0);
    expect(secondsLeft(null, t0)).toBe(0);
    expect(formatClock(120)).toBe("2:00"); expect(formatClock(65)).toBe("1:05");
    expect(offsetFromServerTime("2025-01-01T00:00:10.000Z", t0)).toBe(10_000);
  });
  it("formats kobo as naira with integers", () => {
    expect(formatNaira(100000)).toBe("\u20A61,000.00");
    expect(formatNaira(5)).toBe("\u20A60.05");
    expect(formatNaira(123456789)).toBe("\u20A61,234,567.89");
  });
});
