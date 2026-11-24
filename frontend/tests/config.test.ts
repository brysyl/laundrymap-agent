import { describe, expect, it } from "vitest";
import { buildRewrites, normalizeTarget, securityHeaders, swHeaders } from "../config/build-config.mjs";
import nextConfig from "../next.config.mjs";

describe("next config", () => {
  it("rewrites /api to the configured backend", () => {
    expect(buildRewrites("https://api.laundrymap.ng/")).toEqual([{ source: "/api/:path*", destination: "https://api.laundrymap.ng/api/:path*" }]);
  });
  it("defaults to the local backend and rejects bad targets", () => {
    expect(buildRewrites(undefined)[0]!.destination).toBe("http://localhost:4000/api/:path*");
    expect(buildRewrites("javascript:alert(1)")[0]!.destination).toBe("http://localhost:4000/api/:path*");
    expect(normalizeTarget("ftp://x")).toBeNull();
  });
  it("sw.js is served with no-cache", async () => {
    const headers = (await nextConfig.headers!()).find((h) => h.source === "/sw.js")!.headers;
    expect(headers.find((h) => h.key === "Cache-Control")!.value).toContain("no-cache");
    expect(swHeaders().find((h) => h.key === "Service-Worker-Allowed")!.value).toBe("/");
  });
  it("applies security headers to all routes", async () => {
    const all = (await nextConfig.headers!()).find((h) => h.source === "/:path*")!.headers;
    const keys = all.map((h) => h.key);
    for (const k of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Strict-Transport-Security", "Permissions-Policy"]) expect(keys).toContain(k);
  });
  it("CSP allows only self plus configured API and socket origins", () => {
    const csp = securityHeaders("https://api.laundrymap.ng", "https://api.laundrymap.ng").find((h) => h.key === "Content-Security-Policy")!.value;
    expect(csp).toContain("connect-src 'self' https://api.laundrymap.ng wss://api.laundrymap.ng");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/\*/);
  });
  it("rewrites via next.config use API_PROXY_TARGET", async () => {
    process.env.API_PROXY_TARGET = "https://proxy.example.com";
    expect((await nextConfig.rewrites!() as any)[0].destination).toBe("https://proxy.example.com/api/:path*");
    delete process.env.API_PROXY_TARGET;
  });
});
