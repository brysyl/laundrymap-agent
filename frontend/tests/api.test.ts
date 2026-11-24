// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ID = "11111111-1111-4111-8111-111111111111";

function installWindow() {
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
  vi.stubGlobal("window", { localStorage, location: { pathname: "/", assign: vi.fn() } });
  return data;
}

describe("api client", () => {
  let data: Map<string, string>;
  beforeEach(() => { vi.resetModules(); data = installWindow(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("does not send an Idempotency-Key header, since the backend ignores it", async () => {
    const { tokenStore, action } = await import("../src/lib/api");
    tokenStore.set("tok", { id: "u1" } as never);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await action(`/api/vendor/orders/${ID}/accept`, "key-1");
    const headers = (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("idempotency-key");
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("queues offline actions with the signed-in user id and clears them on sign-out", async () => {
    const { tokenStore, action, getQueue } = await import("../src/lib/api");
    tokenStore.set("tok", { id: "u1" } as never);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await action(`/api/vendor/orders/${ID}/accept`, "key-1")).toEqual({ queued: true });
    expect(getQueue().snapshot()[0]).toMatchObject({ userId: "u1" });
    expect(data.get("laundrymap.retryQueue.v1")).toBeTruthy();

    tokenStore.clear();
    expect(getQueue().size).toBe(0);
    expect(data.has("laundrymap.retryQueue.v1")).toBe(false);
    expect(tokenStore.get()).toBeNull();
  });

  it("does not queue when nobody is signed in", async () => {
    const { action, getQueue } = await import("../src/lib/api");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(action(`/api/vendor/orders/${ID}/accept`, "key-1")).rejects.toThrow();
    expect(getQueue().size).toBe(0);
  });
});
