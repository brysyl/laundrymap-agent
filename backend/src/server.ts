import { createServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { RedisCache } from "./cache/redis";
import { MemoryCache, type Cache } from "./cache/cache";
import { ConfigError, loadConfig } from "./config";
import { buildContainer } from "./container";
import { createApp } from "./http/app";
import { createLogger } from "./logger";
import { migrate } from "./migrate";
import { createRealtime } from "./realtime/socket";
import { FakeGateway, PaystackGateway, type PaymentGateway } from "./services/gateway";
import { seedKaruMararaba } from "./services/vendors";
import { MemoryStore } from "./store/memory";
import { createPostgresStore } from "./store/postgres";
import type { Store } from "./store/store";
import { systemClock } from "./types";
import { startWorker } from "./worker";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger(config.logLevel);

  let pool: Pool | null = null;
  let store: Store;
  if (config.databaseUrl) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
    pool.on("error", (err) => logger.error({ err }, "pg pool error"));
    const applied = await migrate(pool);
    if (applied.length) logger.info({ applied }, "migrations applied");
    store = createPostgresStore(pool);
  } else {
    logger.warn("DATABASE_URL not set: using in-memory store (data is lost on restart)");
    store = new MemoryStore();
  }

  let redis: Redis | null = null;
  let redisSub: Redis | null = null;
  let cache: Cache;
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
    redis.on("error", (err) => logger.error({ err }, "redis error"));
    redisSub = redis.duplicate();
    redisSub.on("error", (err) => logger.error({ err }, "redis sub error"));
    cache = new RedisCache(redis);
  } else {
    cache = new MemoryCache(systemClock);
  }

  const gateway: PaymentGateway = config.paystackSecretKey ? new PaystackGateway(config.paystackSecretKey) : new FakeGateway();
  if (!config.paystackSecretKey) logger.warn("PAYSTACK_SECRET_KEY not set: payments use a fake gateway");

  const realtime = createRealtime();
  const container = buildContainer({ config, store, cache, gateway, clock: systemClock, logger, publish: realtime.publish });

  if (config.admin) await container.auth.ensureAdmin(config.admin);
  if (config.seedDemo) logger.info({ seeded: await seedKaruMararaba(store, systemClock) }, "demo seed");

  const http = createServer(createApp(container));
  const io = realtime.attach(http, container, redis && redisSub ? { adapter: createAdapter(redis, redisSub) } : undefined);
  const stopWorker = startWorker(container.orders, logger, config.workerIntervalMs);

  http.listen(config.port, () => logger.info({ port: config.port, env: config.env }, "laundrymap backend listening"));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => { logger.error("forced exit after timeout"); process.exit(1); }, 15_000);
    force.unref();
    try {
      stopWorker();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
      await pool?.end();
      redis?.disconnect();
      redisSub?.disconnect();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
