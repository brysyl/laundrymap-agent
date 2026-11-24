import type { Logger } from "./logger";
import type { OrderService } from "./services/orders";

/** Periodically sweeps vendor-acceptance timeouts. The logic itself lives in OrderService.expireStale. */
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
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), intervalMs);
  t.unref();
  return () => clearInterval(t);
}
