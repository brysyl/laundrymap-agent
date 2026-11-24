import type { Redis } from "ioredis";
import type { Cache } from "./cache";

export class RedisCache implements Cache {
  constructor(private readonly redis: Redis, private readonly prefix = "lm:") {}
  async ping() {
    await this.redis.ping();
  }
  async setIfAbsent(key: string, ttlMs: number) {
    const r = await this.redis.set(this.prefix + key, "1", "PX", Math.max(1, Math.floor(ttlMs)), "NX");
    return r === "OK";
  }
}
