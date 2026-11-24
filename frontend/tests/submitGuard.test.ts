import { describe, expect, it } from "vitest";
import { SubmitGuard } from "../src/lib/submitGuard";
import { MAX_ATTEMPTS, QUEUE_STORAGE_KEY, RetryQueue, backoffMs, isQueueable, shouldRetryStatus, type QueueStorage } from "../src/lib/retryQueue";
import { canApplyUpdate } from "../src/lib/swPolicy";

const ID = "11111111-1111-4111-8111-111111111111";
const memStorage = (): QueueStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
};

describe("SubmitGuard", () => {
  it("shares one in-flight request for double submits", async () => {
    let n = 0; let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const g = new SubmitGuard(() => "key-" + ++n);
    const calls: string[] = [];
    const fn = async (k: string) => { calls.push(k); await gate; return "ok"; };
    const a = g.run("pay:1", fn); const b = g.run("pay:1", fn);
    expect(g.isBusy("pay:1")).toBe(true);
    release();
    expect(await a).toBe("ok"); expect(await b).toBe("ok");
    expect(calls).toEqual(["key-1"]);
    expect(g.isBusy()).toBe(false);
  });

  it("reuses the idempotency key after a failure and rotates after success", async () => {
    let n = 0; const g = new SubmitGuard(() => "key-" + ++n);
    const seen: string[] = [];
    await expect(g.run("s", async (k) => { seen.push(k); throw new Error("net"); })).rejects.toThrow();
    await g.run("s", async (k) => { seen.push(k); });
    await g.run("s", async (k) => { seen.push(k); });
    expect(seen).toEqual(["key-1", "key-1", "key-2"]);
  });

  it("keeps scopes independent", async () => {
    const g = new SubmitGuard();
    const keys: string[] = [];
    await Promise.all([g.run("a", async (k) => { keys.push(k); }), g.run("b", async (k) => { keys.push(k); })]);
    expect(new Set(keys).size).toBe(2);
  });

  it("notifies subscribers", async () => {
    const g = new SubmitGuard(); let c = 0;
    g.subscribe(() => { c++; });
    await g.run("x", async () => 1);
    expect(c).toBe(2);
  });
});

describe("RetryQueue", () => {
  it("only accepts allowlisted idempotent requests", () => {
    expect(isQueueable("POST", `/api/vendor/orders/${ID}/accept`)).toBe(true);
    expect(isQueueable("POST", `/api/courier/orders/${ID}/claim`)).toBe(true);
    for (const p of [`/api/orders/${ID}/pay`, "/api/orders", `/api/courier/orders/${ID}/deliver`, `/api/admin/orders/${ID}/refund`, "/api/admin/payouts", "/api/auth/login"]) {
      expect(isQueueable("POST", p), p).toBe(false);
    }
    expect(isQueueable("GET", `/api/vendor/orders/${ID}/accept`)).toBe(false);
    const q = new RetryQueue(async () => ({ status: 200 }));
    expect(q.enqueue({ id: "1", method: "POST", path: `/api/orders/${ID}/pay`, idempotencyKey: "k", userId: "u1" })).toBe(false);
    expect(q.size).toBe(0);
  });

  it("dedupes, flushes in order and persists", async () => {
    const st = memStorage(); const sent: string[] = [];
    const q = new RetryQueue(async (r) => { sent.push(r.path); return { status: 200 }; }, st);
    const p1 = `/api/vendor/orders/${ID}/accept`; const p2 = `/api/courier/orders/${ID}/claim`;
    q.enqueue({ id: "a", method: "POST", path: p1, idempotencyKey: "k1", userId: "u1" });
    q.enqueue({ id: "a2", method: "POST", path: p1, idempotencyKey: "k1b", userId: "u1" }); // same action, ignored
    q.enqueue({ id: "b", method: "POST", path: p2, idempotencyKey: "k2", userId: "u1" });
    expect(q.size).toBe(2);
    expect(new RetryQueue(async () => ({ status: 200 }), st).size).toBe(2); // reload from storage
    expect(await q.flush()).toEqual({ sent: 2, dropped: 0, remaining: 0 });
    expect(sent).toEqual([p1, p2]);
  });

  it("keeps the request on network error or 5xx and drops on final 4xx", async () => {
    let mode: "throw" | 503 | 409 = "throw";
    const q = new RetryQueue(async () => { if (mode === "throw") throw new Error("offline"); return { status: mode }; });
    q.enqueue({ id: "a", method: "POST", path: `/api/vendor/orders/${ID}/accept`, idempotencyKey: "k", userId: "u1" });
    expect((await q.flush()).remaining).toBe(1);
    mode = 503; expect((await q.flush()).remaining).toBe(1);
    expect(q.snapshot()[0]!.attempts).toBe(2);
    mode = 409; expect(await q.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });

  it("gives up after MAX_ATTEMPTS", async () => {
    const q = new RetryQueue(async () => ({ status: 500 }));
    q.enqueue({ id: "a", method: "POST", path: `/api/vendor/orders/${ID}/accept`, idempotencyKey: "k", userId: "u1" });
    let last = { sent: 0, dropped: 0, remaining: 1 };
    for (let i = 0; i < MAX_ATTEMPTS; i++) last = await q.flush();
    expect(last).toEqual({ sent: 0, dropped: 1, remaining: 0 });
  });

  it("clear() empties the queue and its storage so nothing replays after sign-out", async () => {
    const st = memStorage(); const sent: string[] = [];
    const q = new RetryQueue(async (r) => { sent.push(r.path); return { status: 200 }; }, st);
    q.enqueue({ id: "a", method: "POST", path: `/api/vendor/orders/${ID}/accept`, idempotencyKey: "k", userId: "u1" });
    expect(st.data.has(QUEUE_STORAGE_KEY)).toBe(true);
    q.clear();
    expect(q.size).toBe(0);
    expect(st.data.has(QUEUE_STORAGE_KEY)).toBe(false);
    expect(new RetryQueue(async () => ({ status: 200 }), st).size).toBe(0);
    await q.flush();
    expect(sent).toEqual([]);
  });

  it("never replays another user's queued requests", async () => {
    const st = memStorage(); const sent: string[] = [];
    const q = new RetryQueue(async (r) => { sent.push(r.userId); return { status: 200 }; }, st);
    q.enqueue({ id: "a", method: "POST", path: `/api/vendor/orders/${ID}/accept`, idempotencyKey: "k1", userId: "alice" });
    q.enqueue({ id: "b", method: "POST", path: `/api/courier/orders/${ID}/claim`, idempotencyKey: "k2", userId: "bob" });
    expect(await q.flush("bob")).toEqual({ sent: 1, dropped: 1, remaining: 0 });
    expect(sent).toEqual(["bob"]);
    q.enqueue({ id: "c", method: "POST", path: `/api/vendor/orders/${ID}/start`, idempotencyKey: "k3", userId: "alice" });
    expect(await q.flush(null)).toEqual({ sent: 0, dropped: 1, remaining: 0 });
  });

  it("drops stored entries that have no user id", () => {
    const st = memStorage();
    st.setItem(QUEUE_STORAGE_KEY, JSON.stringify([{ id: "x", method: "POST", path: `/api/vendor/orders/${ID}/accept`, idempotencyKey: "k", attempts: 0, createdAt: 0 }]));
    expect(new RetryQueue(async () => ({ status: 200 }), st).size).toBe(0);
  });

  it("ignores tampered stored entries", () => {
    const st = memStorage();
    st.setItem("laundrymap.retryQueue.v1", JSON.stringify([{ id: "x", method: "POST", path: "/api/admin/payouts", idempotencyKey: "k", userId: "u1", attempts: 0, createdAt: 0 }]));
    expect(new RetryQueue(async () => ({ status: 200 }), st).size).toBe(0);
  });

  it("status and backoff helpers", () => {
    expect([408, 429, 500, 503].every(shouldRetryStatus)).toBe(true);
    expect([200, 400, 401, 403, 404, 409].some(shouldRetryStatus)).toBe(false);
    expect([1, 2, 3, 10].map((a) => backoffMs(a))).toEqual([1000, 2000, 4000, 60000]);
  });
});

describe("update policy", () => {
  it("blocks updates during active submissions or queued work", () => {
    expect(canApplyUpdate(true, 0)).toBe(false);
    expect(canApplyUpdate(false, 2)).toBe(false);
    expect(canApplyUpdate(false, 0)).toBe(true);
  });
});
