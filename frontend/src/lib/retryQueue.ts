/**
 * Small persistent retry queue for requests that are safe to repeat.
 * Only an allowlist of idempotent state transitions may be queued. Payment
 * initialisation, order creation, OTP delivery and admin money actions are
 * never queued: they must be submitted while online and confirmed by the user.
 */
export interface QueuedRequest {
  id: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /** Client-side dedupe key. It is not sent to the server, which has no idempotency-key support. */
  idempotencyKey: string;
  /** The user who queued the request. Items never replay under a different user. */
  userId: string;
  attempts: number;
  createdAt: number;
}

export interface QueueStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem?(k: string): void;
}

export type Sender = (r: QueuedRequest) => Promise<{ status: number }>;

const QUEUEABLE: RegExp[] = [
  /^\/api\/vendor\/orders\/[0-9a-f-]{36}\/(accept|reject|start|ready)$/,
  /^\/api\/courier\/orders\/[0-9a-f-]{36}\/(claim|pickup)$/,
];

export function isQueueable(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && QUEUEABLE.some((re) => re.test(path));
}

/** Retry on network failure, timeouts, rate limits and 5xx. Other 4xx are final. */
export function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function backoffMs(attempts: number, base = 1000, cap = 60_000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
}

export const MAX_ATTEMPTS = 6;
export const QUEUE_STORAGE_KEY = "laundrymap.retryQueue.v1";

export class RetryQueue {
  private items: QueuedRequest[] = [];
  private flushing = false;

  constructor(
    private readonly send: Sender,
    private readonly storage?: QueueStorage,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  get size(): number {
    return this.items.length;
  }

  snapshot(): QueuedRequest[] {
    return this.items.map((i) => ({ ...i }));
  }

  /** Returns false (and queues nothing) if the request is not on the allowlist. */
  enqueue(r: Omit<QueuedRequest, "attempts" | "createdAt">): boolean {
    if (!isQueueable(r.method, r.path)) return false;
    if (this.items.some((i) => i.idempotencyKey === r.idempotencyKey || (i.method === r.method && i.path === r.path))) return true;
    this.items.push({ ...r, attempts: 0, createdAt: this.now() });
    this.persist();
    return true;
  }

  /** Forgets every queued request, in memory and in storage. Call on sign-out. */
  clear(): void {
    this.items = [];
    try {
      this.storage?.removeItem?.(QUEUE_STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  /**
   * Sends queued requests in order. Stops at the first retryable failure.
   * When `currentUserId` is given, requests queued by anyone else are discarded unsent.
   */
  async flush(currentUserId?: string | null): Promise<{ sent: number; dropped: number; remaining: number }> {
    if (this.flushing) return { sent: 0, dropped: 0, remaining: this.items.length };
    let foreign = 0;
    if (currentUserId !== undefined) {
      const mine = this.items.filter((i) => i.userId === currentUserId);
      foreign = this.items.length - mine.length;
      if (foreign > 0) { this.items = mine; this.persist(); }
    }
    this.flushing = true;
    let sent = 0;
    let dropped = foreign;
    try {
      while (this.items.length > 0) {
        const head = this.items[0]!;
        let retry = false;
        try {
          const { status } = await this.send(head);
          retry = shouldRetryStatus(status);
        } catch {
          retry = true;
        }
        if (!retry) {
          this.items.shift();
          sent++;
        } else {
          head.attempts++;
          if (head.attempts >= MAX_ATTEMPTS) {
            this.items.shift();
            dropped++;
          } else {
            this.persist();
            break;
          }
        }
        this.persist();
      }
    } finally {
      this.flushing = false;
    }
    return { sent, dropped, remaining: this.items.length };
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(QUEUE_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) this.items = parsed.filter((i): i is QueuedRequest => !!i && typeof i.path === "string" && typeof i.userId === "string" && isQueueable(i.method, i.path));
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    try {
      this.storage?.setItem(QUEUE_STORAGE_KEY, JSON.stringify(this.items));
    } catch {
      /* storage full or unavailable: queue stays in memory */
    }
  }
}
