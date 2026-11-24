import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const R = require("../public/sw-routing.js");
const ORIGIN = "https://laundrymap.ng";
const cls = (path: string, method = "GET", mode = "cors", origin = ORIGIN) => R.classifyRequest({ url: origin + path, method, mode }, ORIGIN);

describe("service worker routing", () => {
  it("never caches API, auth or socket traffic", () => {
    for (const p of ["/api/orders", "/api/me/orders?x=1", "/api/auth/login", "/api/webhooks/paystack", "/api", "/socket.io/?EIO=4&transport=polling", "/auth/callback", "/_next/data/abc/index.json"]) {
      expect(cls(p), p).toBe("network-only");
      expect(cls(p, "GET", "navigate"), p + " navigate").toBe("network-only");
    }
  });

  it("never touches non-GET requests", () => {
    expect(cls("/_next/static/chunk.js", "POST")).toBe("network-only");
    expect(cls("/offline", "POST")).toBe("network-only");
  });

  it("ignores cross-origin requests (API host, Paystack)", () => {
    expect(cls("/api/orders", "GET", "cors", "https://api.laundrymap.ng")).toBe("passthrough");
    expect(cls("/", "GET", "navigate", "https://checkout.paystack.com")).toBe("passthrough");
  });

  it("uses cache-first for hashed static assets", () => {
    expect(cls("/_next/static/chunks/app-123.js")).toBe("cache-first");
  });

  it("uses stale-while-revalidate for shell assets", () => {
    for (const p of ["/manifest.webmanifest", "/icons/icon-192.png", "/offline", "/favicon.ico"]) expect(cls(p)).toBe("stale-while-revalidate");
  });

  it("handles navigations with network-first offline fallback", () => {
    expect(cls("/customer", "GET", "navigate")).toBe("navigate");
    expect(cls("/", "GET", "navigate")).toBe("navigate");
  });

  it("does not intercept the worker script itself", () => {
    expect(cls("/sw.js")).toBe("network-only");
    expect(cls("/sw-routing.js")).toBe("network-only");
  });

  it("lets unknown subresources pass through", () => {
    expect(cls("/something.json")).toBe("passthrough");
  });

  it("cleans only old app caches", () => {
    const names = ["laundrymap-static-v0", "laundrymap-shell-v0", R.STATIC_CACHE, R.SHELL_CACHE, "other-app-cache"];
    expect(R.staleCacheNames(names)).toEqual(["laundrymap-static-v0", "laundrymap-shell-v0"]);
  });

  it("caches only successful basic responses", () => {
    expect(R.isCacheableResponse({ status: 200, type: "basic" })).toBe(true);
    expect(R.isCacheableResponse({ status: 500, type: "basic" })).toBe(false);
    expect(R.isCacheableResponse({ status: 200, type: "opaque" })).toBe(false);
    expect(R.isCacheableResponse(undefined)).toBe(false);
  });

  it("precaches the offline page", () => {
    expect(R.PRECACHE_URLS).toContain("/offline");
  });
});

describe("sw.js wiring", () => {
  const src = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");
  it("calls skipWaiting only from the SKIP_WAITING message handler", () => {
    const calls = src.match(/skipWaiting\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(src).toMatch(/SKIP_WAITING"\) self\.skipWaiting\(\)/);
  });
  it("claims clients and removes stale caches on activate", () => {
    expect(src).toContain("clients.claim()");
    expect(src).toContain("staleCacheNames");
  });
  it("only respondWith for cache-first, swr and navigate", () => {
    expect(src).not.toMatch(/case "network-only"/);
    expect(src).toContain("importScripts(\"/sw-routing.js\")");
  });
});

describe("sw.js behavior with fake globals", () => {
  it("does not call respondWith for /api requests and does for static assets", async () => {
    const listeners: Record<string, (e: any) => void> = {};
    const g: any = {
      SwRouting: R,
      location: { origin: ORIGIN },
      addEventListener: (t: string, fn: any) => { listeners[t] = fn; },
      caches: { open: async () => ({ match: async () => undefined, put: async () => undefined, addAll: async () => undefined }), keys: async () => [], delete: async () => true },
      clients: { claim: async () => undefined },
      skipWaiting: () => undefined,
    };
    const src = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");
    new Function("self", "importScripts", "caches", "Request", "Response", "fetch", src)(g, () => undefined, g.caches, class {}, { error: () => ({}) }, async () => ({ status: 200, type: "basic", clone() { return this; } }));
    const fire = (url: string, method = "GET", mode = "cors") => {
      let responded = false;
      listeners.fetch!({ request: { url, method, mode }, respondWith: () => { responded = true; }, waitUntil: () => undefined });
      return responded;
    };
    expect(fire(ORIGIN + "/api/orders")).toBe(false);
    expect(fire(ORIGIN + "/api/orders", "POST")).toBe(false);
    expect(fire(ORIGIN + "/socket.io/?EIO=4")).toBe(false);
    expect(fire(ORIGIN + "/_next/static/a.js")).toBe(true);
    expect(fire(ORIGIN + "/customer", "GET", "navigate")).toBe(true);
  });
});
