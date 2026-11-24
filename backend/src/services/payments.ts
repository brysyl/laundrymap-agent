import { randomUUID } from "node:crypto";
import { badRequest, unauthorized } from "../errors";
import type { Store } from "../store/store";
import type { Clock } from "../types";
import { verifyPaystackSignature } from "./gateway";
import type { OrderService } from "./orders";
import type { Logger } from "../logger";

export type WebhookOutcome = "processed" | "duplicate" | "already_processed" | "ignored" | "unknown_reference" | "amount_mismatch";

interface PaystackEvent {
  event?: unknown;
  data?: { id?: unknown; reference?: unknown; amount?: unknown; currency?: unknown };
}

export class PaymentService {
  constructor(
    private readonly store: Store,
    private readonly orders: OrderService,
    private readonly secret: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<WebhookOutcome> {
    if (!verifyPaystackSignature(rawBody, signature, this.secret)) throw unauthorized("Invalid signature");
    let payload: PaystackEvent;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as PaystackEvent;
    } catch {
      throw badRequest("invalid_json");
    }
    if (payload.event !== "charge.success" || !payload.data) return "ignored";
    const d = payload.data;
    if (typeof d.reference !== "string" || d.reference.length === 0) throw badRequest("missing_reference");
    const reference = d.reference;
    const gatewayId = d.id === undefined ? null : String(d.id);
    const eventId = `charge.success:${gatewayId ?? reference}`;
    const now = this.clock.now();

    const result = await this.store.tx(async (s: Store) => {
      // Idempotency key 1: the event id. A replay of the same event is a no-op.
      if (!(await s.recordWebhookEvent(eventId, reference, payload, now))) return { outcome: "duplicate" as const };
      const payment = await s.getPaymentByReference(reference);
      if (!payment) return { outcome: "unknown_reference" as const };
      // Idempotency key 2: the payment reference. A different event id for a paid reference is a no-op.
      if (payment.status === "PAID") return { outcome: "already_processed" as const };
      if (typeof d.amount !== "number" || !Number.isSafeInteger(d.amount) || d.amount !== payment.amountKobo || d.currency !== "NGN") {
        // Only a positive NGN amount can be refunded later by an admin; anything else is left for the Paystack dashboard.
        const receivedKobo = d.currency === "NGN" && typeof d.amount === "number" && Number.isSafeInteger(d.amount) && d.amount > 0 ? d.amount : null;
        await s.updatePayment(payment.id, { status: "MISMATCH", receivedKobo });
        await s.addAudit({
          id: randomUUID(), actorId: null, action: "payment.amount_mismatch", entityType: "payment", entityId: payment.id,
          metadata: { reference, expectedKobo: payment.amountKobo, receivedAmount: String(d.amount), currency: String(d.currency) }, createdAt: now,
        });
        return { outcome: "amount_mismatch" as const };
      }
      const confirmed = await this.orders.confirmPayment(s, payment, gatewayId);
      return { outcome: "processed" as const, confirmed };
    });

    if (result.outcome === "processed") {
      try {
        await this.orders.afterPayment(result.confirmed);
      } catch (err) {
        this.logger.error({ err, reference }, "post-payment side effects failed");
      }
    } else if (result.outcome === "amount_mismatch") {
      this.logger.warn({ reference, alert: true }, "paystack amount mismatch, payment not applied; admin action required");
    }
    return result.outcome;
  }
}
