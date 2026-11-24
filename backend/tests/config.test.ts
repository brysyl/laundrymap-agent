import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

const A = "a".repeat(40);
const B = "b".repeat(40);
const prod = {
  NODE_ENV: "production",
  JWT_SECRET: A,
  OTP_ENCRYPTION_KEY: B,
  DATABASE_URL: "postgres://u:p@db.example.com:5432/lm?sslmode=require",
  REDIS_URL: "rediss://default:p@redis.example.com:6380",
  PAYSTACK_SECRET_KEY: "sk_live_" + "z".repeat(20),
};

const issues = (env: Record<string, string>) => {
  try { loadConfig(env); return []; } catch (e) { return (e as ConfigError).issues; }
};

describe("config validation", () => {
  it("accepts a valid production config", () => {
    const c = loadConfig(prod);
    expect(c.isProd).toBe(true);
    expect(c.corsOrigins).toEqual(["https://laundrymap.ng", "https://api.laundrymap.ng"]);
  });

  it("rejects identical JWT_SECRET and OTP_ENCRYPTION_KEY", () => {
    expect(issues({ ...prod, OTP_ENCRYPTION_KEY: A }).join()).toMatch(/must be different/);
  });

  it("rejects short secrets and placeholders in production", () => {
    expect(issues({ ...prod, JWT_SECRET: "short" }).join()).toMatch(/JWT_SECRET must be at least/);
    expect(issues({ ...prod, OTP_ENCRYPTION_KEY: "changeme".repeat(6) }).join()).toMatch(/placeholder/);
  });

  it("requires TLS database and redis URLs in production", () => {
    expect(issues({ ...prod, DATABASE_URL: "postgres://u:p@db/lm" }).join()).toMatch(/DATABASE_URL must enforce TLS/);
    expect(issues({ ...prod, REDIS_URL: "redis://r:6379" }).join()).toMatch(/rediss/);
  });

  it("requires DATABASE_URL, REDIS_URL and PAYSTACK_SECRET_KEY in production", () => {
    const { DATABASE_URL: _d, REDIS_URL: _r, PAYSTACK_SECRET_KEY: _p, ...rest } = prod;
    const joined = issues(rest).join();
    expect(joined).toMatch(/DATABASE_URL is required/);
    expect(joined).toMatch(/REDIS_URL is required/);
    expect(joined).toMatch(/PAYSTACK_SECRET_KEY is required/);
  });

  it("adds staging origins from CORS_EXTRA_ORIGINS and rejects wildcards and http in production", () => {
    const c = loadConfig({ ...prod, CORS_EXTRA_ORIGINS: "https://staging.laundrymap.ng, https://preview-1.vercel.app" });
    expect(c.corsOrigins).toContain("https://staging.laundrymap.ng");
    expect(c.corsOrigins).toContain("https://preview-1.vercel.app");
    expect(issues({ ...prod, CORS_EXTRA_ORIGINS: "*" }).join()).toMatch(/invalid origin/);
    expect(issues({ ...prod, CORS_EXTRA_ORIGINS: "http://evil.example.com" }).join()).toMatch(/https/);
    expect(issues({ ...prod, CORS_EXTRA_ORIGINS: "https://a.example.com/path" }).join()).toMatch(/invalid origin/);
  });

  it("does not allow localhost origins in production", () => {
    expect(loadConfig(prod).corsOrigins.some((o) => o.includes("localhost"))).toBe(false);
  });

  it("rejects identical secrets in development too", () => {
    expect(issues({ NODE_ENV: "development", JWT_SECRET: A, OTP_ENCRYPTION_KEY: A }).join()).toMatch(/must be different/);
  });
});
