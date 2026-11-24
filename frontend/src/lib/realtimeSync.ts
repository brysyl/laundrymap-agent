/** Minimal socket surface used by the client, so tests can pass a fake. */
export interface SocketLike {
  on(event: string, fn: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
  disconnect(): unknown;
}

export type ConnState = "connected" | "reconnecting" | "disconnected";

export interface RealtimeHandlers {
  /** Called after every (re)connect so the caller can reconcile with REST state. */
  onSync: () => void;
  onEvent: (event: string, data: unknown) => void;
  onState: (s: ConnState) => void;
}

export const REALTIME_EVENTS = ["order:update", "order:new", "order:available", "courier:location"];

export function wireSocket(socket: SocketLike, h: RealtimeHandlers, orderIds: () => string[] = () => []): () => void {
  socket.on("connect", () => {
    h.onState("connected");
    // Rooms are lost on reconnect: re-join, then reconcile through REST (events may have been missed).
    for (const id of orderIds()) socket.emit("order:join", { orderId: id }, () => undefined);
    h.onSync();
  });
  socket.on("disconnect", () => h.onState("reconnecting"));
  socket.on("connect_error", () => h.onState("reconnecting"));
  for (const ev of REALTIME_EVENTS) socket.on(ev, (data: unknown) => h.onEvent(ev, data));
  return () => { socket.disconnect(); h.onState("disconnected"); };
}
