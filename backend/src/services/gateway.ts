import { createHmac, timingSafeEqual } from "node:crypto";
import type { Kobo } from "../types";

export interface InitializeInput { email: string; amountKobo: Kobo; reference: string; callbackUrl?: string; orderId: string }
export interface PaymentGateway {
  initialize(i: InitializeInput): Promise<{ authorizationUrl: string }>;
  refund(i: { reference: string; amountKobo: Kobo }): Promise<{ gatewayRef: string | null }>;
}

/** HMAC-SHA512 of the raw request body keyed with the Paystack secret, hex encoded. */
export function paystackSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha512", secret).update(rawBody).digest("hex");
}

export function verifyPaystackSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(paystackSignature(rawBody, secret), "utf8");
  const got = Buffer.from(header, "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export class PaystackGateway implements PaymentGateway {
  constructor(private readonly secret: string, private readonly base = "https://api.paystack.co") {}

  private async call(path: string, body: unknown): Promise<{ status: boolean; message?: string; data?: Record<string, unknown> }> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: Record<string, unknown> };
    if (!res.ok || !json.status) throw new Error(`paystack ${path} failed (${res.status}): ${json.message ?? "unknown"}`);
    return { status: true, message: json.message, data: json.data };
  }

  async initialize(i: InitializeInput) {
    const r = await this.call("/transaction/initialize", {
      email: i.email, amount: i.amountKobo, currency: "NGN", reference: i.reference,
      callback_url: i.callbackUrl, metadata: { orderId: i.orderId },
    });
    const url = r.data?.authorization_url;
    if (typeof url !== "string") throw new Error("paystack initialize returned no authorization_url");
    return { authorizationUrl: url };
  }

  async refund(i: { reference: string; amountKobo: Kobo }) {
    const r = await this.call("/refund", { transaction: i.reference, amount: i.amountKobo });
    const id = r.data?.id;
    return { gatewayRef: id === undefined ? null : String(id) };
  }
}

/** Deterministic gateway for tests and local development without Paystack keys. */
export class FakeGateway implements PaymentGateway {
  initialized: InitializeInput[] = [];
  refunds: { reference: string; amountKobo: Kobo }[] = [];
  failRefunds = false;
  async initialize(i: InitializeInput) {
    this.initialized.push(i);
    return { authorizationUrl: `https://checkout.paystack.test/${i.reference}` };
  }
  async refund(i: { reference: string; amountKobo: Kobo }) {
    if (this.failRefunds) throw new Error("gateway down");
    this.refunds.push(i);
    return { gatewayRef: `rf_${i.reference}` };
  }
}
