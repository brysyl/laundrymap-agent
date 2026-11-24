/**
 * Prevents duplicate submissions of the same intent (for example "create order"
 * or "pay order X"). While a submission with a given scope is in flight, further
 * calls share its promise. The idempotency key for a scope is kept after a
 * failure so a retry is recognised by the server as the same intent, and cleared
 * after success.
 */
export type KeyFactory = () => string;

export const defaultKey: KeyFactory = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export class SubmitGuard {
  private inflight = new Map<string, Promise<unknown>>();
  private keys = new Map<string, string>();
  private listeners = new Set<() => void>();

  constructor(private readonly newKey: KeyFactory = defaultKey) {}

  keyFor(scope: string): string {
    let k = this.keys.get(scope);
    if (!k) {
      k = this.newKey();
      this.keys.set(scope, k);
    }
    return k;
  }

  isBusy(scope?: string): boolean {
    return scope === undefined ? this.inflight.size > 0 : this.inflight.has(scope);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  run<T>(scope: string, fn: (idempotencyKey: string) => Promise<T>): Promise<T> {
    const existing = this.inflight.get(scope);
    if (existing) return existing as Promise<T>;
    const key = this.keyFor(scope);
    const p = (async () => {
      try {
        const r = await fn(key);
        this.keys.delete(scope);
        return r;
      } finally {
        this.inflight.delete(scope);
        this.listeners.forEach((l) => l());
      }
    })();
    this.inflight.set(scope, p);
    this.listeners.forEach((l) => l());
    return p;
  }
}

export const submitGuard = new SubmitGuard();
