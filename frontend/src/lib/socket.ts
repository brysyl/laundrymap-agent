import { io } from "socket.io-client";
import { tokenStore } from "./api";
import { wireSocket, type RealtimeHandlers } from "./realtimeSync";

/** Direct socket URL. Empty means realtime is disabled and pages poll REST instead. */
export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || process.env.NEXT_PUBLIC_API_URL || "";

export function connectRealtime(h: RealtimeHandlers, orderIds: () => string[] = () => []): () => void {
  const token = tokenStore.get();
  if (!SOCKET_URL || !token) return () => undefined;
  const socket = io(SOCKET_URL, {
    // Token goes in the handshake auth payload, never in the URL.
    auth: (cb) => cb({ token: tokenStore.get() }),
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15_000,
  });
  return wireSocket(socket, h, orderIds);
}
