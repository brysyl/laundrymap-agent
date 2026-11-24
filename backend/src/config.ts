import { z } from "zod";

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n - ${issues.join("\n - ")}`);
  }
}

export const BASE_ALLOWED_ORIGINS = ["https://laundrymap.ng", "https://api.laundrymap.ng"];
const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];
const MIN_SECRET_LEN = 32;
const PLACEHOLDER = /(changeme|change-me|replace|example|secret|password|placeholder|xxxx)/i;

const intStr = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().nonnegative());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: intStr(4000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  OTP_ENCRYPTION_KEY: z.string().optional(),
  JWT_TTL_SECONDS: intStr(12 * 3600),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_CALLBACK_URL: z.string().optional(),
  CORS_EXTRA_ORIGINS: z.string().optional(),
  TRUST_PROXY: intStr(0),
  PLATFORM_FEE_BPS: intStr(1000),
  DELIVERY_FEE_KOBO: intStr(100000),
  GATEWAY_BPS: intStr(150),
  GATEWAY_FLAT_KOBO: intStr(10000),
  GATEWAY_FLAT_THRESHOLD_KOBO: intStr(250000),
  GATEWAY_CAP_KOBO: intStr(200000),
  VENDOR_ACCEPT_TIMEOUT_MS: intStr(120000),
  WORKER_INTERVAL_MS: intStr(5000),
  REFUND_RETRY_MIN_AGE_MS: intStr(60000),
  REFUND_MAX_ATTEMPTS: intStr(8),
  REFUND_BACKOFF_MAX_MS: intStr(3600000),
  REFUND_CLAIM_LEASE_MS: intStr(300000),
  OTP_TTL_MS: intStr(6 * 3600 * 1000),
  OTP_MAX_ATTEMPTS: intStr(5),
  OTP_LOCK_MS: intStr(15 * 60 * 1000),
  COURIER_LOCATION_MIN_INTERVAL_MS: intStr(3000),
  RATE_LIMIT_MAX: intStr(300),
  AUTH_RATE_LIMIT_MAX: intStr(20),
  SEED_DEMO: z.enum(["true", "false"]).default("false"),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PHONE: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

export interface Config {
  env: "development" | "test" | "production";
  isProd: boolean;
  port: number;
  logLevel: string;
  databaseUrl?: string;
  redisUrl?: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  otpEncryptionKey: string;
  paystackSecretKey: string;
  paystackCallbackUrl?: string;
  corsOrigins: string[];
  trustProxy: number;
  platformFeeBps: number;
  deliveryFeeKobo: number;
  gatewayBps: number;
  gatewayFlatKobo: number;
  gatewayFlatThresholdKobo: number;
  gatewayCapKobo: number;
  vendorAcceptTimeoutMs: number;
  workerIntervalMs: number;
  refundRetryMinAgeMs: number;
  refundMaxAttempts: number;
  refundBackoffMaxMs: number;
  refundClaimLeaseMs: number;
  otpTtlMs: number;
  otpMaxAttempts: number;
  otpLockMs: number;
  courierLocationMinIntervalMs: number;
  rateLimitMax: number;
  authRateLimitMax: number;
  seedDemo: boolean;
  admin?: { email: string; phone: string; password: string };
}

function tlsPostgres(url: string): boolean {
  try {
    const u = new URL(url);
    const mode = u.searchParams.get("sslmode");
    return ["require", "verify-ca", "verify-full"].includes(mode ?? "") || u.searchParams.get("ssl") === "true";
  } catch {
    return false;
  }
}

export function parseOrigins(extra: string | undefined, isProd: boolean, issues: string[] = []): string[] {
  const list = [...BASE_ALLOWED_ORIGINS, ...(isProd ? [] : DEV_ORIGINS)];
  for (const raw of (extra ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      const u = new URL(raw);
      if (raw === "*" || u.origin !== raw.replace(/\/$/, "")) throw new Error("not an origin");
      if (isProd && u.protocol !== "https:") issues.push(`CORS_EXTRA_ORIGINS entry must be https in production: ${raw}`);
      list.push(u.origin);
    } catch {
      issues.push(`CORS_EXTRA_ORIGINS has invalid origin: ${raw}`);
    }
  }
  return [...new Set(list)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === "production";
  const issues: string[] = [];

  const jwt = e.JWT_SECRET ?? "";
  const otpKey = e.OTP_ENCRYPTION_KEY ?? "";
  if (isProd) {
    if (jwt.length < MIN_SECRET_LEN) issues.push(`JWT_SECRET must be at least ${MIN_SECRET_LEN} characters`);
    if (otpKey.length < MIN_SECRET_LEN) issues.push(`OTP_ENCRYPTION_KEY must be at least ${MIN_SECRET_LEN} characters`);
    if (jwt && jwt === otpKey) issues.push("JWT_SECRET and OTP_ENCRYPTION_KEY must be different values");
    if (PLACEHOLDER.test(jwt)) issues.push("JWT_SECRET looks like a placeholder");
    if (PLACEHOLDER.test(otpKey)) issues.push("OTP_ENCRYPTION_KEY looks like a placeholder");
    if (!e.DATABASE_URL) issues.push("DATABASE_URL is required in production");
    else if (!tlsPostgres(e.DATABASE_URL)) issues.push("DATABASE_URL must enforce TLS (sslmode=require|verify-ca|verify-full)");
    if (!e.REDIS_URL) issues.push("REDIS_URL is required in production");
    else if (!e.REDIS_URL.startsWith("rediss://")) issues.push("REDIS_URL must use TLS (rediss://)");
    if (!e.PAYSTACK_SECRET_KEY) issues.push("PAYSTACK_SECRET_KEY is required in production");
  } else {
    if (jwt && jwt === otpKey) issues.push("JWT_SECRET and OTP_ENCRYPTION_KEY must be different values");
    if (!jwt && e.NODE_ENV !== "test") issues.push("JWT_SECRET is required");
    if (!otpKey && e.NODE_ENV !== "test") issues.push("OTP_ENCRYPTION_KEY is required");
    if (e.NODE_ENV === "test" && (!jwt || !otpKey)) issues.push("JWT_SECRET and OTP_ENCRYPTION_KEY are required (set explicit test values)");
  }
  if (e.PLATFORM_FEE_BPS > 10000) issues.push("PLATFORM_FEE_BPS must be <= 10000");
  if (e.GATEWAY_BPS > 10000) issues.push("GATEWAY_BPS must be <= 10000");

  const corsOrigins = parseOrigins(e.CORS_EXTRA_ORIGINS, isProd, issues);

  let admin: Config["admin"];
  if (e.ADMIN_EMAIL || e.ADMIN_PHONE || e.ADMIN_PASSWORD) {
    if (!e.ADMIN_EMAIL || !e.ADMIN_PHONE || !e.ADMIN_PASSWORD) issues.push("ADMIN_EMAIL, ADMIN_PHONE and ADMIN_PASSWORD must be set together");
    else if (e.ADMIN_PASSWORD.length < 12) issues.push("ADMIN_PASSWORD must be at least 12 characters");
    else admin = { email: e.ADMIN_EMAIL, phone: e.ADMIN_PHONE, password: e.ADMIN_PASSWORD };
  }

  if (issues.length) throw new ConfigError(issues);

  return {
    env: e.NODE_ENV,
    isProd,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    jwtSecret: jwt,
    jwtTtlSeconds: e.JWT_TTL_SECONDS,
    otpEncryptionKey: otpKey,
    paystackSecretKey: e.PAYSTACK_SECRET_KEY ?? "",
    paystackCallbackUrl: e.PAYSTACK_CALLBACK_URL,
    corsOrigins,
    trustProxy: e.TRUST_PROXY,
    platformFeeBps: e.PLATFORM_FEE_BPS,
    deliveryFeeKobo: e.DELIVERY_FEE_KOBO,
    gatewayBps: e.GATEWAY_BPS,
    gatewayFlatKobo: e.GATEWAY_FLAT_KOBO,
    gatewayFlatThresholdKobo: e.GATEWAY_FLAT_THRESHOLD_KOBO,
    gatewayCapKobo: e.GATEWAY_CAP_KOBO,
    vendorAcceptTimeoutMs: e.VENDOR_ACCEPT_TIMEOUT_MS,
    workerIntervalMs: e.WORKER_INTERVAL_MS,
    refundRetryMinAgeMs: e.REFUND_RETRY_MIN_AGE_MS,
    refundMaxAttempts: e.REFUND_MAX_ATTEMPTS,
    refundBackoffMaxMs: e.REFUND_BACKOFF_MAX_MS,
    refundClaimLeaseMs: e.REFUND_CLAIM_LEASE_MS,
    otpTtlMs: e.OTP_TTL_MS,
    otpMaxAttempts: e.OTP_MAX_ATTEMPTS,
    otpLockMs: e.OTP_LOCK_MS,
    courierLocationMinIntervalMs: e.COURIER_LOCATION_MIN_INTERVAL_MS,
    rateLimitMax: e.RATE_LIMIT_MAX,
    authRateLimitMax: e.AUTH_RATE_LIMIT_MAX,
    seedDemo: e.SEED_DEMO === "true",
    admin,
  };
}
