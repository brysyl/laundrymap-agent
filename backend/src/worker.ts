import type { Logger } from "./logger";
import type { OrderService } from "./services/orders";

/** Periodically sweeps vendor-acceptance timeouts and retries unsettled refunds. The logic lives in OrderService. */
export function startWorker(orders: OrderService, logger: Logger, intervalMs: number): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await orders.expireStale();
      if (n > 0) logger.info({ expired: n }, "expired unaccepted orders");
    } catch (err) {
      logger.error({ err }, "worker sweep failed");
    }
    try {
      const r = await orders.retryRefunds();
      if (r > 0) logger.info({ refunded: r }, "re-submitted refunds to the gateway");
    } catch (err) {
      logger.error({ err }, "refund retry sweep failed");
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), intervalMs);
  t.unref();
  return () => clearInterval(t);
}
