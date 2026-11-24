import type { ConnState } from "./realtimeSync";

export interface ConnSnapshot { online: boolean; realtime: ConnState; queued: number }

let snap: ConnSnapshot = { online: true, realtime: "disconnected", queued: 0 };
const listeners = new Set<() => void>();

export const connectionStore = {
  get: (): ConnSnapshot => snap,
  server: (): ConnSnapshot => ({ online: true, realtime: "disconnected", queued: 0 }),
  set(patch: Partial<ConnSnapshot>) {
    snap = { ...snap, ...patch };
    listeners.forEach((l) => l());
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

/** Banner text, or null when everything is fine. */
export function bannerMessage(s: ConnSnapshot): { tone: "offline" | "warn"; text: string } | null {
  if (!s.online) return { tone: "offline", text: s.queued > 0 ? `You are offline. ${s.queued} action(s) will be sent when you reconnect.` : "You are offline. Showing the last loaded data." };
  if (s.realtime === "reconnecting") return { tone: "warn", text: "Reconnecting to live updates..." };
  if (s.queued > 0) return { tone: "warn", text: `Sending ${s.queued} queued action(s)...` };
  return null;
}
