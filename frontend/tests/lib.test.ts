import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { bannerMessage, connectionStore } from "../src/lib/connectionStore";
import { formatClock, offsetFromServerTime, secondsLeft } from "../src/lib/countdown";
import { formatNaira } from "../src/lib/money";
import { REALTIME_EVENTS, wireSocket, type SocketLike } from "../src/lib/realtimeSync";
import { SubmitGuard } from "../src/lib/submitGuard";
import { canApplyUpdate } from "../src/lib/swPolicy";
import { DEFAULT_LOCATION_THROTTLE, distanceMeters, shouldSendLocation } from "../src/lib/throttle";
import Offline from "../app/offline/page";

describe("countdown", () => {
  const deadline = "2025-01-01T12:02:00.000Z";
  const t0 = Date.parse("2025-01-01T12:00:00.000Z");
  it("counts the 2 minute vendor window down and never goes negative", () => {
    expect(secondsLeft(deadline, t0)).toBe(120);
    expect(secondsLeft(deadline, t0 + 119_001)).toBe(1);
    expect(secondsLeft(deadline, t0 + 120_000)).toBe(0);
    expect(secondsLeft(deadline, t0 + 999_999)).toBe(0);
  });
  it("handles missing or invalid deadlines and applies the server offset", () => {
    expect(secondsLeft(null, t0)).toBe(0);
    expect(secondsLeft("nope", t0)).toBe(0);
    const offset = offsetFromServerTime("2025-01-01T12:01:00.000Z", t0); // client clock is 60s behind
    expect(offset).toBe(60_000);
    expect(secondsLeft(deadline, t0, offset)).toBe(60);
    expect(offsetFromServerTime("bad", t0)).toBe(0);
  });
  it("formats m:ss", () => {
    expect(formatClock(120)).toBe("2:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(9.9)).toBe("0:09");
  });
});

describe("formatNaira", () => {
  it("formats integer kobo without float error", () => {
    expect(formatNaira(0)).toBe("\u20A60.00");
    expect(formatNaira(5)).toBe("\u20A60.05");
    expect(formatNaira(340000)).toBe("\u20A63,400.00");
    expect(formatNaira(123456789)).toBe("\u20A61,234,567.89");
    expect(formatNaira(-250)).toBe("-\u20A62.50");
  });
});

describe("connection banner", () => {
  it("is hidden when online, connected and nothing is queued", () => {
    expect(bannerMessage({ online: true, realtime: "connected", queued: 0 })).toBeNull();
    expect(bannerMessage({ online: true, realtime: "disconnected", queued: 0 })).toBeNull();
  });
  it("shows the offline banner, with the queued count when there is one", () => {
    expect(bannerMessage({ online: false, realtime: "connected", queued: 0 })).toEqual({ tone: "offline", text: "You are offline. Showing the last loaded data." });
    expect(bannerMessage({ online: false, realtime: "connected", queued: 2 })?.text).toContain("2 action(s)");
  });
  it("warns while reconnecting or sending queued actions, and offline wins over reconnecting", () => {
    expect(bannerMessage({ online: true, realtime: "reconnecting", queued: 0 })?.tone).toBe("warn");
    expect(bannerMessage({ online: true, realtime: "connected", queued: 3 })?.text).toContain("3");
    expect(bannerMessage({ online: false, realtime: "reconnecting", queued: 0 })?.tone).toBe("offline");
  });
  it("store notifies subscribers, merges patches and stops after unsubscribe", () => {
    const fn = vi.fn();
    const off = connectionStore.subscribe(fn);
    connectionStore.set({ online: false });
    expect(connectionStore.get().online).toBe(false);
    expect(connectionStore.get().realtime).toBe("disconnected");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    connectionStore.set({ online: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(connectionStore.server()).toEqual({ online: true, realtime: "disconnected", queued: 0 });
  });
});

describe("offline page", () => {
  it("renders a useful fallback with a way back", () => {
    const html = renderToStaticMarkup(createElement(Offline));
    expect(html).toContain("You are offline");
    expect(html).toContain('href="/"');
    expect(html).toContain("Try again");
    expect(html).toContain("safe");
  });
});

describe("swPolicy", () => {
  it("allows the update prompt only when idle with an empty queue", () => {
    expect(canApplyUpdate(false, 0)).toBe(true);
    expect(canApplyUpdate(true, 0)).toBe(false);
    expect(canApplyUpdate(false, 1)).toBe(false);
  });
});

describe("location throttle", () => {
  const a = { lat: 9, lng: 7.5, at: 0 };
  it("always sends the first fix", () => expect(shouldSendLocation(null, a)).toBe(true));
  it("blocks sends inside the minimum interval even if moved far", () => {
    expect(shouldSendLocation(a, { lat: 10, lng: 7.5, at: DEFAULT_LOCATION_THROTTLE.minIntervalMs - 1 })).toBe(false);
  });
  it("requires minimum distance after the interval, but heartbeat forces a send", () => {
    const still = { ...a, at: 15_000 };
    expect(shouldSendLocation(a, still)).toBe(false);
    expect(shouldSendLocation(a, { lat: 9.001, lng: 7.5, at: 15_000 })).toBe(true); // ~111 m
    expect(shouldSendLocation(a, { ...a, at: DEFAULT_LOCATION_THROTTLE.heartbeatMs })).toBe(true);
  });
  it("computes haversine distance", () => {
    expect(distanceMeters(a, a)).toBe(0);
    expect(Math.round(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }))).toBeGreaterThan(111_000);
    expect(Math.round(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }))).toBeLessThan(111_400);
  });
});

describe("realtimeSync", () => {
  function fakeSocket() {
    const h = new Map<string, (...a: any[]) => void>();
    const emit = vi.fn();
    const disconnect = vi.fn();
    const s: SocketLike = { on: (e, fn) => { h.set(e, fn); }, emit, disconnect };
    return { s, h, emit, disconnect };
  }
  it("re-joins order rooms and reconciles via REST on every connect", () => {
    const f = fakeSocket();
    const onSync = vi.fn(), onState = vi.fn(), onEvent = vi.fn();
    wireSocket(f.s, { onSync, onState, onEvent }, () => ["o1", "o2"]);
    f.h.get("connect")!();
    expect(onState).toHaveBeenLastCalledWith("connected");
    expect(f.emit).toHaveBeenCalledWith("order:join", { orderId: "o1" }, expect.any(Function));
    expect(f.emit).toHaveBeenCalledWith("order:join", { orderId: "o2" }, expect.any(Function));
    f.h.get("connect")!();
    expect(onSync).toHaveBeenCalledTimes(2);
  });
  it("reports reconnecting on disconnect or error, forwards events, and cleans up", () => {
    const f = fakeSocket();
    const onSync = vi.fn(), onState = vi.fn(), onEvent = vi.fn();
    const stop = wireSocket(f.s, { onSync, onState, onEvent });
    f.h.get("disconnect")!();
    expect(onState).toHaveBeenLastCalledWith("reconnecting");
    f.h.get("connect_error")!();
    expect(onState).toHaveBeenCalledTimes(2);
    for (const ev of REALTIME_EVENTS) f.h.get(ev)!({ x: ev });
    expect(onEvent).toHaveBeenCalledWith("order:update", { x: "order:update" });
    expect(onEvent).toHaveBeenCalledTimes(REALTIME_EVENTS.length);
    stop();
    expect(f.disconnect).toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith("disconnected");
  });
});

describe("SubmitGuard edge cases", () => {
  it("runs once per scope concurrently, keeps the key after failure, rotates it after success", async () => {
    let n = 0;
    const g = new SubmitGuard(() => `k${++n}`);
    const fn = vi.fn(async (_k: string) => { throw new Error("net"); });
    await expect(g.run("create", fn)).rejects.toThrow("net");
    expect(g.isBusy()).toBe(false);
    const keys: string[] = [];
    await g.run("create", async (k) => { keys.push(k); });
    expect(keys).toEqual(["k1"]);
    await g.run("create", async (k) => { keys.push(k); });
    expect(keys).toEqual(["k1", "k2"]);
  });
  it("different scopes do not block each other and listeners fire on start and finish", async () => {
    const g = new SubmitGuard(() => "k");
    const l = vi.fn();
    g.subscribe(l);
    let release!: () => void;
    const p = g.run("a", () => new Promise<void>((r) => { release = r; }));
    expect(g.isBusy("a")).toBe(true);
    expect(g.isBusy("b")).toBe(false);
    await g.run("b", async () => undefined);
    release();
    await p;
    expect(g.isBusy()).toBe(false);
    expect(l.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
