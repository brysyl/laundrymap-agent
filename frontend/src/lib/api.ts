import { QUEUE_STORAGE_KEY, RetryQueue, isQueueable, type QueuedRequest } from "./retryQueue";
import type { User } from "./types";

const TOKEN_KEY = "laundrymap.token";
const USER_KEY = "laundrymap.user";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

let queue: RetryQueue | null = null;

export const tokenStore = {
  get: (): string | null => (typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_KEY)),
  user: (): User | null => {
    if (typeof window === "undefined") return null;
    try { return JSON.parse(window.localStorage.getItem(USER_KEY) ?? "null") as User | null; } catch { return null; }
  },
  set: (token: string, user: User) => { window.localStorage.setItem(TOKEN_KEY, token); window.localStorage.setItem(USER_KEY, JSON.stringify(user)); },
  /** Signs out locally. Also drops queued requests so they cannot replay under the next user's token. */
  clear: () => {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
    window.localStorage.removeItem(QUEUE_STORAGE_KEY);
    queue?.clear();
  },
};

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Used by SubmitGuard for client-side dedupe only. It is never sent: the backend has no idempotency-key support. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Requests go to the same origin; next.config rewrites /api to the backend. */
export async function rawRequest(path: string, o: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(path, { method: o.method ?? "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: o.signal, cache: "no-store" });
}

export async function api<T>(path: string, o: RequestOptions = {}): Promise<T> {
  const res = await rawRequest(path, o);
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    if (res.status === 401 && tokenStore.get()) {
      tokenStore.clear();
      if (typeof window !== "undefined" && !["/auth", "/login", "/register"].includes(window.location.pathname)) window.location.assign("/auth");
    }
    throw new ApiError(res.status, data.error ?? "error", data.message ?? data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function getQueue(): RetryQueue {
  if (!queue) {
    queue = new RetryQueue(
      async (r: QueuedRequest) => (await rawRequest(r.path, { method: r.method, body: r.body })),
      typeof window === "undefined" ? undefined : window.localStorage,
    );
  }
  return queue;
}

export type ActionResult<T> = { queued: false; data: T } | { queued: true };

/**
 * For allowlisted idempotent transitions: if the network is down the request is
 * queued and replayed when connectivity returns. Everything else just throws.
 */
export async function action<T>(path: string, idempotencyKey: string, body?: unknown): Promise<ActionResult<T>> {
  try {
    return { queued: false, data: await api<T>(path, { method: "POST", body }) };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const userId = tokenStore.user()?.id;
    if (userId && isQueueable("POST", path) && getQueue().enqueue({ id: idempotencyKey, method: "POST", path, body, idempotencyKey, userId })) return { queued: true };
    throw err;
  }
}
