import { randomUUID } from "node:crypto";
import type { Config } from "../config";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../errors";
import type { Logger } from "../logger";
import { computeSplit, lineTotal, sumKobo, type SplitParams } from "../money";
import type { Publisher } from "../realtime/events";
import { orderRooms, room } from "../realtime/events";
import type { Cache } from "../cache/cache";
import type { Store } from "../store/store";
import type { Clock, Order, OrderStatus, Payment, Refund, RefundKind, User } from "../types";
import type { PaymentGateway } from "./gateway";
import { paymentLines, post, refundLines, settlementLines } from "./ledger";
import type { OtpService } from "./otp";
import { REFUNDABLE, predecessors } from "./stateMachine";

export interface CreateOrderInput {
  vendorId: string;
  items: { name: string; quantity: number }[];
  dropoff: { address: string; lat: number; lng: number };
}

export interface OrderDeps {
  store: Store;
  config: Config;
  clock: Clock;
  gateway: PaymentGateway;
  otp: OtpService;
  cache: Cache;
  publish: Publisher;
  logger: Logger;
}

export class OrderService {
  constructor(private readonly d: OrderDeps) {}

  private get splitParams(): SplitParams {
    const c = this.d.config;
    return {
      platformFeeBps: c.platformFeeBps, gatewayBps: c.gatewayBps, gatewayFlatKobo: c.gatewayFlatKobo,
      gatewayFlatThresholdKobo: c.gatewayFlatThresholdKobo, gatewayCapKobo: c.gatewayCapKobo,
    };
  }

  // ---------- access control ----------

  /** Ownership check shared by REST and Socket.IO room joins. */
  async canView(user: User, order: Order): Promise<boolean> {
    switch (user.role) {
      case "ADMIN": return true;
      case "CUSTOMER": return order.customerId === user.id;
      case "VENDOR": {
        const v = await this.d.store.getVendorByOwner(user.id);
        return !!v && v.id === order.vendorId;
      }
      case "COURIER": {
        if (order.courierId === user.id) return true;
        if (order.courierId === null && order.status === "READY_FOR_PICKUP") {
          const c = await this.d.store.getCourierByUser(user.id);
          return c?.status === "APPROVED";
        }
        return false;
      }
    }
  }

  async getFor(user: User, id: string): Promise<Order> {
    const order = await this.d.store.getOrder(id);
    if (!order) throw notFound("Order");
    if (!(await this.canView(user, order))) throw forbidden("You do not have access to this order");
    return order;
  }

  async listFor(user: User): Promise<Order[]> {
    const s = this.d.store;
    switch (user.role) {
      case "CUSTOMER": return s.listOrders({ customerId: user.id });
      case "VENDOR": {
        const v = await s.getVendorByOwner(user.id);
        return v ? s.listOrders({ vendorId: v.id }) : [];
      }
      case "COURIER": {
        const mine = await s.listOrders({ courierId: user.id });
        const c = await s.getCourierByUser(user.id);
        const open = c?.status === "APPROVED" ? await s.listOrders({ statuses: ["READY_FOR_PICKUP"], unassigned: true }) : [];
        return [...mine, ...open];
      }
      case "ADMIN": return s.listOrders({ limit: 200 });
    }
  }

  async sync(user: User, id: string) {
    const order = await this.getFor(user, id);
    const payment = user.role === "CUSTOMER" || user.role === "ADMIN" ? await this.d.store.getPaymentByOrder(id) : null;
    return {
      order,
      payment: payment ? { reference: payment.reference, status: payment.status } : null,
      serverTime: this.d.clock.now().toISOString(),
    };
  }

  // ---------- customer ----------

  async create(customer: User, input: CreateOrderInput): Promise<Order> {
    const vendor = await this.d.store.getVendor(input.vendorId);
    if (!vendor) throw notFound("Vendor");
    if (vendor.status !== "APPROVED") throw conflict("vendor_unavailable", "Vendor is not accepting orders");
    const now = this.d.clock.now();
    const id = randomUUID();
    const items = input.items.map((i) => ({
      id: randomUUID(), orderId: id, name: i.name, quantity: i.quantity, unitPriceKobo: vendor.unitPriceKobo,
    }));
    let subtotal: number;
    try {
      subtotal = sumKobo(items.map((i) => lineTotal(i.unitPriceKobo, i.quantity)));
      computeSplit(subtotal, this.d.config.deliveryFeeKobo, this.splitParams); // range validation only
    } catch (e) {
      throw badRequest("invalid_amount", (e as Error).message);
    }
    const delivery = this.d.config.deliveryFeeKobo;
    return this.d.store.createOrder({
      id, customerId: customer.id, vendorId: vendor.id, courierId: null, status: "PENDING_PAYMENT",
      subtotalKobo: subtotal, deliveryFeeKobo: delivery, totalKobo: subtotal + delivery,
      dropoffAddress: input.dropoff.address, dropoffLat: input.dropoff.lat, dropoffLng: input.dropoff.lng,
      acceptDeadline: null, cancelReason: null, version: 1, createdAt: now, updatedAt: now, items,
    });
  }

  async cancel(customer: User, id: string): Promise<Order> {
    const order = await this.getFor(customer, id);
    if (customer.role !== "CUSTOMER") throw forbidden();
    const updated = await this.d.store.transitionOrder(order.id, ["PENDING_PAYMENT"], { status: "CANCELLED", cancelReason: "cancelled by customer" }, this.d.clock.now());
    if (!updated) throw conflict("invalid_state", "Only unpaid orders can be cancelled");
    this.emit(updated, "order:update");
    return updated;
  }

  async initializePayment(customer: User, id: string): Promise<{ reference: string; authorizationUrl: string }> {
    const order = await this.getFor(customer, id);
    if (customer.role !== "CUSTOMER") throw forbidden();
    if (order.status !== "PENDING_PAYMENT") throw conflict("invalid_state", "Order is not awaiting payment");
    const existing = await this.d.store.getPaymentByOrder(id);
    if (existing && existing.status === "PENDING" && existing.authorizationUrl) {
      return { reference: existing.reference, authorizationUrl: existing.authorizationUrl };
    }
    const reference = `lm_${order.id.replace(/-/g, "")}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const { authorizationUrl } = await this.d.gateway.initialize({
      email: customer.email, amountKobo: order.totalKobo, reference, callbackUrl: this.d.config.paystackCallbackUrl, orderId: order.id,
    });
    try {
      await this.d.store.createPayment({
        id: randomUUID(), orderId: order.id, reference, amountKobo: order.totalKobo, status: "PENDING",
        authorizationUrl, gatewayTransactionId: null, paidAt: null, createdAt: this.d.clock.now(),
      });
    } catch (err) {
      // A concurrent call won the unique pending-payment slot. Return its reference so the customer pays only one.
      if (err instanceof HttpError && err.code === "payment_pending") {
        const winner = await this.d.store.getPaymentByOrder(id);
        if (winner && winner.status === "PENDING" && winner.authorizationUrl) {
          return { reference: winner.reference, authorizationUrl: winner.authorizationUrl };
        }
      }
      throw err;
    }
    return { reference, authorizationUrl };
  }

  // ---------- payment confirmation (called inside the webhook transaction) ----------

  async confirmPayment(s: Store, payment: Payment, gatewayTxId: string | null): Promise<{ order: Order; refund: Refund | null }> {
    const now = this.d.clock.now();
    await s.updatePayment(payment.id, { status: "PAID", gatewayTransactionId: gatewayTxId, paidAt: now });
    const order = await s.getOrder(payment.orderId);
    if (!order) throw notFound("Order");
    await post(s, order.id, paymentLines(order, payment.amountKobo), now);

    if (order.status === "PENDING_PAYMENT") {
      const deadline = new Date(now.getTime() + this.d.config.vendorAcceptTimeoutMs);
      const updated = await s.transitionOrder(order.id, ["PENDING_PAYMENT"], { status: "AWAITING_VENDOR", acceptDeadline: deadline }, now);
      if (!updated) throw conflict("order_state_changed");
      return { order: updated, refund: null };
    }
    if (order.status === "CANCELLED") {
      const r = await this.refundInTx(s, order, ["CANCELLED"], "LATE_PAYMENT", "payment received after cancellation", null);
      return { order: r.order, refund: r.refund };
    }
    await s.addAudit({
      id: randomUUID(), actorId: null, action: "payment.unexpected_state", entityType: "order", entityId: order.id,
      metadata: { status: order.status, reference: payment.reference }, createdAt: now,
    });
    return { order, refund: null };
  }

  /** Publishes events and submits the refund to the gateway once the transaction has committed. */
  async afterPayment(r: { order: Order; refund: Refund | null }): Promise<void> {
    this.emit(r.order, "order:update");
    if (r.order.status === "AWAITING_VENDOR") this.emit(r.order, "order:new");
    if (r.refund) await this.submitRefund(r.refund);
  }

  // ---------- vendor ----------

  private async vendorOrder(user: User, id: string) {
    if (user.role !== "VENDOR") throw forbidden();
    const vendor = await this.d.store.getVendorByOwner(user.id);
    if (!vendor || vendor.status !== "APPROVED") throw forbidden("Vendor account is not approved");
    const order = await this.d.store.getOrder(id);
    if (!order) throw notFound("Order");
    if (order.vendorId !== vendor.id) throw forbidden("Order belongs to another vendor");
    return order;
  }

  private async step(order: Order, from: OrderStatus, to: OrderStatus, patch: Parameters<Store["transitionOrder"]>[2] = {}): Promise<Order> {
    const updated = await this.d.store.transitionOrder(order.id, [from], { status: to, ...patch }, this.d.clock.now());
    if (!updated) throw conflict("invalid_state", `Order cannot move from ${order.status} to ${to}`);
    this.emit(updated, "order:update");
    return updated;
  }

  async vendorAccept(user: User, id: string): Promise<Order> {
    const order = await this.vendorOrder(user, id);
    const now = this.d.clock.now();
    if (order.status === "AWAITING_VENDOR" && order.acceptDeadline && order.acceptDeadline.getTime() <= now.getTime()) {
      await this.expireOne(order); // deadline passed: refund instead of accepting
      throw conflict("accept_window_expired", "The acceptance window has expired and the order was refunded");
    }
    return this.step(order, "AWAITING_VENDOR", "ACCEPTED");
  }

  async vendorReject(user: User, id: string, reason: string): Promise<Order> {
    const order = await this.vendorOrder(user, id);
    return this.refundAndPublish(order, ["AWAITING_VENDOR"], "AUTO_REJECT", `rejected by vendor: ${reason}`, user.id);
  }

  async vendorStart(user: User, id: string) { return this.step(await this.vendorOrder(user, id), "ACCEPTED", "IN_PROGRESS"); }
  async vendorReady(user: User, id: string) { return this.step(await this.vendorOrder(user, id), "IN_PROGRESS", "READY_FOR_PICKUP"); }

  // ---------- courier ----------

  private async approvedCourier(user: User) {
    if (user.role !== "COURIER") throw forbidden();
    const c = await this.d.store.getCourierByUser(user.id);
    if (!c || c.status !== "APPROVED") throw forbidden("Courier account is not approved");
    return c;
  }

  async courierClaim(user: User, id: string): Promise<Order> {
    await this.approvedCourier(user);
    const order = await this.d.store.getOrder(id);
    if (!order) throw notFound("Order");
    // Compare-and-set guarantees a single winner when couriers race.
    const updated = await this.d.store.transitionOrder(id, ["READY_FOR_PICKUP"], { status: "COURIER_ASSIGNED", courierId: user.id }, this.d.clock.now());
    if (!updated) throw conflict("not_claimable", "Order is not available to claim");
    this.emit(updated, "order:update");
    return updated;
  }

  private async courierOrder(user: User, id: string): Promise<Order> {
    await this.approvedCourier(user);
    const order = await this.d.store.getOrder(id);
    if (!order) throw notFound("Order");
    if (order.courierId !== user.id) throw forbidden("Order is not assigned to you");
    return order;
  }

  async courierPickup(user: User, id: string): Promise<Order> {
    const order = await this.courierOrder(user, id);
    const updated = await this.d.store.tx(async (s) => {
      const u = await s.transitionOrder(id, ["COURIER_ASSIGNED"], { status: "OUT_FOR_DELIVERY" }, this.d.clock.now());
      if (!u) throw conflict("invalid_state", `Order cannot move from ${order.status} to OUT_FOR_DELIVERY`);
      await this.d.otp.issue(s, id);
      return u;
    });
    this.emit(updated, "order:update");
    return updated;
  }

  async courierDeliver(user: User, id: string, code: string): Promise<Order> {
    const order = await this.courierOrder(user, id);
    if (order.status !== "OUT_FOR_DELIVERY") throw conflict("invalid_state", "Order is not out for delivery");
    const result = await this.d.otp.verify(this.d.store, id, code);
    switch (result) {
      case "OK": break;
      case "INVALID": throw badRequest("invalid_otp", "Incorrect delivery code");
      case "EXPIRED": throw new HttpError(410, "otp_expired", "Delivery code expired");
      case "REPLAYED": throw conflict("otp_used", "Delivery code already used");
      case "LOCKED": throw new HttpError(429, "otp_locked", "Too many attempts, try again later");
      case "NOT_FOUND": throw notFound("Delivery code");
    }
    const now = this.d.clock.now();
    const updated = await this.d.store.tx(async (s) => {
      const u = await s.transitionOrder(id, ["OUT_FOR_DELIVERY"], { status: "DELIVERED" }, now);
      if (!u) throw conflict("invalid_state", "Order is no longer out for delivery");
      const split = computeSplit(u.subtotalKobo, u.deliveryFeeKobo, this.splitParams);
      await post(s, u.id, settlementLines(u, user.id, split), now);
      return u;
    });
    this.emit(updated, "order:update");
    return updated;
  }

  /** Customer can re-read the delivery code to show the courier. */
  async deliveryCodeFor(customer: User, id: string): Promise<string> {
    const order = await this.getFor(customer, id);
    if (customer.role !== "CUSTOMER") throw forbidden();
    if (order.status !== "OUT_FOR_DELIVERY") throw conflict("invalid_state", "No active delivery code");
    const code = await this.d.otp.reveal(this.d.store, id);
    if (!code) throw conflict("otp_unavailable", "Delivery code is expired or used");
    return code;
  }

  async courierLocation(user: User, lat: number, lng: number): Promise<{ accepted: boolean }> {
    await this.approvedCourier(user);
    const ok = await this.d.cache.setIfAbsent(`courier-loc:${user.id}`, this.d.config.courierLocationMinIntervalMs);
    if (!ok) return { accepted: false };
    await this.d.store.updateCourierLocation(user.id, lat, lng, this.d.clock.now());
    const active = await this.d.store.listOrders({ courierId: user.id, statuses: ["COURIER_ASSIGNED", "OUT_FOR_DELIVERY"] });
    for (const o of active) {
      this.d.publish({ rooms: [room.order(o.id), room.customer(o.customerId)], event: "courier:location", data: { orderId: o.id, lat, lng, at: this.d.clock.now().toISOString() } });
    }
    return { accepted: true };
  }

  // ---------- refunds and timeouts ----------

  private async refundInTx(s: Store, order: Order, from: OrderStatus[], kind: RefundKind, reason: string, actorId: string | null) {
    const now = this.d.clock.now();
    const payment = await s.getPaidPaymentByOrder(order.id);
    if (!payment) throw conflict("not_paid", "Order has no confirmed payment");
    const updated = await s.transitionOrder(order.id, from, { status: "REFUNDED", cancelReason: reason }, now);
    if (!updated) throw conflict("invalid_state", "Order state changed, refund not applied");
    await post(s, order.id, refundLines(order, payment.amountKobo, reason), now);
    const refund = await s.createRefund({
      id: randomUUID(), orderId: order.id, paymentId: payment.id, amountKobo: payment.amountKobo, reason, kind,
      status: "RECORDED", requestedBy: actorId, gatewayRef: null, createdAt: now,
    });
    await s.addAudit({
      id: randomUUID(), actorId, action: `order.refund.${kind.toLowerCase()}`, entityType: "order", entityId: order.id,
      metadata: { amountKobo: payment.amountKobo, reason, previousStatus: order.status }, createdAt: now,
    });
    return { order: updated, refund };
  }

  /** Submits a RECORDED or FAILED refund to the gateway. Returns the resulting status. */
  async submitRefund(refund: Refund): Promise<Refund["status"]> {
    const payment = await this.d.store.getPayment(refund.paymentId);
    if (!payment) return refund.status;
    try {
      const r = await this.d.gateway.refund({ reference: payment.reference, amountKobo: refund.amountKobo });
      await this.d.store.updateRefund(refund.id, { status: "SUBMITTED", gatewayRef: r.gatewayRef });
      return "SUBMITTED";
    } catch (err) {
      await this.d.store.updateRefund(refund.id, { status: "FAILED" });
      this.d.logger.error({ err, refundId: refund.id, orderId: refund.orderId }, "gateway refund submission failed; the worker will retry");
      return "FAILED";
    }
  }

  /**
   * Worker sweep: re-submits refunds that are FAILED, or RECORDED because the process died
   * before the gateway call. Refunds younger than `refundRetryMinAgeMs` are skipped so a
   * request that is still submitting is not raced. Returns the number now SUBMITTED.
   */
  async retryRefunds(): Promise<number> {
    const cutoff = new Date(this.d.clock.now().getTime() - this.d.config.refundRetryMinAgeMs);
    const due = await this.d.store.listRefundsByStatus(["RECORDED", "FAILED"], cutoff, 50);
    let n = 0;
    for (const r of due) if ((await this.submitRefund(r)) === "SUBMITTED") n++;
    return n;
  }

  /** Admin retry of one unsettled refund. */
  async adminRetryRefund(admin: User, refundId: string): Promise<Refund> {
    if (admin.role !== "ADMIN") throw forbidden();
    const refund = await this.d.store.getRefund(refundId);
    if (!refund) throw notFound("Refund");
    if (refund.status === "SUBMITTED") throw conflict("already_submitted", "Refund was already submitted to the gateway");
    await this.submitRefund(refund);
    await this.d.store.addAudit({
      id: randomUUID(), actorId: admin.id, action: "refund.retry", entityType: "refund", entityId: refund.id,
      metadata: { orderId: refund.orderId }, createdAt: this.d.clock.now(),
    });
    return (await this.d.store.getRefund(refundId)) as Refund;
  }

  private async refundAndPublish(order: Order, from: OrderStatus[], kind: RefundKind, reason: string, actorId: string | null): Promise<Order> {
    const r = await this.d.store.tx((s) => this.refundInTx(s, order, from, kind, reason, actorId));
    this.emit(r.order, "order:update");
    await this.submitRefund(r.refund);
    return r.order;
  }

  private async expireOne(order: Order): Promise<void> {
    await this.refundAndPublish(order, ["AWAITING_VENDOR"], "AUTO_TIMEOUT", "vendor did not accept within the acceptance window", null);
  }

  /**
   * Worker sweep. Deterministic given the injected clock: refunds every order still
   * AWAITING_VENDOR whose acceptDeadline is at or before now. Safe to run concurrently
   * (compare-and-set on status, unique refund per order).
   */
  async expireStale(): Promise<number> {
    const stale = await this.d.store.listExpiredAwaiting(this.d.clock.now(), 100);
    let n = 0;
    for (const o of stale) {
      try {
        await this.expireOne(o);
        n++;
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) continue; // vendor acted or another worker won
        this.d.logger.error({ err, orderId: o.id }, "failed to expire order");
      }
    }
    return n;
  }

  /** Operator-confirmed refund: caller must echo the order id in `confirm`. */
  async adminRefund(admin: User, id: string, input: { confirm: string; reason: string }): Promise<Order> {
    if (admin.role !== "ADMIN") throw forbidden();
    const order = await this.d.store.getOrder(id);
    if (!order) throw notFound("Order");
    if (input.confirm !== order.id) throw badRequest("confirmation_required", "confirm must equal the order id");
    if (!REFUNDABLE.includes(order.status)) throw conflict("not_refundable", `Orders in status ${order.status} cannot be refunded`);
    return this.refundAndPublish(order, predecessors("REFUNDED").filter((st) => REFUNDABLE.includes(st)), "ADMIN", input.reason, admin.id);
  }

  // ---------- realtime ----------

  private emit(order: Order, event: string): void {
    this.d.publish({ rooms: orderRooms(order), event, data: { order } });
    if (order.status === "READY_FOR_PICKUP" && !order.courierId) {
      this.d.publish({
        rooms: [room.couriersOnline], event: "order:available",
        data: { orderId: order.id, vendorId: order.vendorId, deliveryFeeKobo: order.deliveryFeeKobo },
      });
    }
  }
}
