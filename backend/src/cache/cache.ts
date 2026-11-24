import type { Clock } from "../types";

export interface Cache {
  ping(): Promise<void>;
  /** Sets the key only if absent. Returns true if this call set it. */
  setIfAbsent(key: string, ttlMs: number): Promise<boolean>;
}

export class MemoryCache implements Cache {
  private keys = new Map<string, number>();
  constructor(private readonly clock: Clock) {}
  async ping() {}
  async setIfAbsent(key: string, ttlMs: number) {
    const now = this.clock.now().getTime();
    const exp = this.keys.get(key);
    if (exp !== undefined && exp > now) return false;
    this.keys.set(key, now + ttlMs);
    return true;
  }
}
