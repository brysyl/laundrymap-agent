import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store";
import type { Clock } from "../types";

export interface OtpOptions {
  encryptionKey: string;
  ttlMs: number;
  maxAttempts: number;
  lockMs: number;
}

export type OtpResult = "OK" | "INVALID" | "EXPIRED" | "REPLAYED" | "LOCKED" | "NOT_FOUND";

/** Derive a 32-byte AES key from the configured secret (domain separated from JWT). */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update("laundrymap:otp:v1:").update(secret).digest();
}

export function encryptOtp(code: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ct = Buffer.concat([c.update(code, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

export function decryptOtp(blob: string, secret: string): string {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !ct) throw new Error("malformed otp ciphertext");
  const d = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export class OtpService {
  constructor(private readonly opts: OtpOptions, private readonly clock: Clock) {}

  /** Creates (or replaces) the delivery OTP for an order. Returns the plaintext once. */
  async issue(store: Store, orderId: string): Promise<string> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const now = this.clock.now();
    await store.upsertOtp({
      orderId,
      ciphertext: encryptOtp(code, this.opts.encryptionKey),
      expiresAt: new Date(now.getTime() + this.opts.ttlMs),
      attempts: 0,
      lockedUntil: null,
      consumedAt: null,
      createdAt: now,
    });
    return code;
  }

  /** Lets the owning customer re-read an unconsumed, unexpired code. */
  async reveal(store: Store, orderId: string): Promise<string | null> {
    const otp = await store.getOtp(orderId);
    if (!otp || otp.consumedAt || otp.expiresAt.getTime() <= this.clock.now().getTime()) return null;
    return decryptOtp(otp.ciphertext, this.opts.encryptionKey);
  }

  async verify(store: Store, orderId: string, submitted: string): Promise<OtpResult> {
    const now = this.clock.now();
    const otp = await store.getOtp(orderId);
    if (!otp) return "NOT_FOUND";
    if (otp.consumedAt) return "REPLAYED";
    if (otp.lockedUntil && otp.lockedUntil.getTime() > now.getTime()) return "LOCKED";
    if (otp.expiresAt.getTime() <= now.getTime()) return "EXPIRED";

    const expected = Buffer.from(decryptOtp(otp.ciphertext, this.opts.encryptionKey));
    const got = Buffer.from(submitted);
    const match = expected.length === got.length && timingSafeEqual(expected, got);
    if (!match) {
      const updated = await store.recordOtpFailure(orderId, now, this.opts.maxAttempts, this.opts.lockMs);
      return updated?.lockedUntil && updated.lockedUntil.getTime() > now.getTime() ? "LOCKED" : "INVALID";
    }
    return (await store.consumeOtp(orderId, now)) ? "OK" : "REPLAYED";
  }
}
