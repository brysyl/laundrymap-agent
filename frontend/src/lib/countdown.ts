/** Seconds left until `deadlineIso`, using a server clock offset. Never negative. */
export function secondsLeft(deadlineIso: string | null, nowMs: number, serverOffsetMs = 0): number {
  if (!deadlineIso) return 0;
  const t = Date.parse(deadlineIso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t - (nowMs + serverOffsetMs)) / 1000));
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function offsetFromServerTime(serverTimeIso: string, clientNowMs: number): number {
  const t = Date.parse(serverTimeIso);
  return Number.isNaN(t) ? 0 : t - clientNowMs;
}
