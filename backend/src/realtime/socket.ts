import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import type { Container } from "../container";
import { HttpError } from "../errors";
import type { User } from "../types";
import type { Publisher } from "./events";
import { SESSION_REVOKED, room } from "./events";

export interface Realtime {
  publish: Publisher;
  attach(http: HttpServer, c: Container, opts?: { adapter?: unknown }): Server;
}

/**
 * Publisher and server are created separately because services need `publish`
 * before the HTTP server exists. Messages before `attach` are dropped.
 */
export function createRealtime(): Realtime {
  let io: Server | null = null;
  return {
    publish: (m) => {
      if (!io) return;
      if (m.event === SESSION_REVOKED) {
        io.in(m.rooms).disconnectSockets(true); // adapter-aware, so it also reaches other instances
        return;
      }
      io.to(m.rooms).emit(m.event, m.data);
    },
    attach(http, c, opts) {
      io = new Server(http, {
        cors: { origin: c.config.corsOrigins, credentials: true },
        // Auth is in the handshake payload only. Never accept tokens from the URL query.
        serveClient: false,
      });
      if (opts?.adapter) io.adapter(opts.adapter as Parameters<Server["adapter"]>[0]);

      io.use((socket, next) => {
        const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
        if (typeof token !== "string" || token.length === 0) return next(new Error("unauthorized"));
        c.auth.authenticate(token).then(
          (user) => {
            socket.data.user = user;
            const exp = (jwt.decode(token) as { exp?: number } | null)?.exp;
            socket.data.expiresAtMs = typeof exp === "number" ? exp * 1000 : Date.now();
            next();
          },
          (err: unknown) => next(new Error(err instanceof HttpError && err.status === 403 ? "forbidden" : "unauthorized")),
        );
      });

      io.on("connection", (socket) => {
        void onConnect(socket, c).catch((err) => { c.logger.error({ err }, "socket setup failed"); socket.disconnect(true); });
      });
      return io;
    },
  };
}

async function onConnect(socket: Socket, c: Container): Promise<void> {
  const user = socket.data.user as User;
  // Authorization is checked at handshake, so end the session when the token expires.
  const remaining = Math.min(Math.max((socket.data.expiresAtMs as number) - Date.now(), 0), 2 ** 31 - 1);
  const expiry = setTimeout(() => socket.disconnect(true), remaining);
  socket.on("disconnect", () => clearTimeout(expiry));
  await socket.join(room.user(user.id));
  // Base rooms are derived from identity on the server. Clients cannot choose them.
  if (user.role === "CUSTOMER") await socket.join(room.customer(user.id));
  if (user.role === "ADMIN") await socket.join(room.admin);
  if (user.role === "VENDOR") {
    const v = await c.store.getVendorByOwner(user.id);
    if (v?.status === "APPROVED") await socket.join(room.vendor(v.id));
  }
  if (user.role === "COURIER") {
    await socket.join(room.courier(user.id));
    const courier = await c.store.getCourierByUser(user.id);
    if (courier?.status === "APPROVED") await socket.join(room.couriersOnline);
  }

  const joinSchema = z.object({ orderId: z.string().uuid() });
  socket.on("order:join", async (payload: unknown, ack?: (r: unknown) => void) => {
    const reply = typeof ack === "function" ? ack : () => undefined;
    const parsed = joinSchema.safeParse(payload);
    if (!parsed.success) return reply({ ok: false, error: "invalid_order_id" });
    try {
      // Re-load the user so suspension or role changes apply to new joins.
      const fresh = await c.auth.reloadActive(user.id);
      const order = await c.orders.getFor(fresh, parsed.data.orderId);
      await socket.join(room.order(order.id));
      reply({ ok: true, order, serverTime: c.clock.now().toISOString() });
    } catch (err) {
      reply({ ok: false, error: err instanceof HttpError ? err.code : "internal_error" });
    }
  });
  socket.on("order:leave", async (payload: unknown) => {
    const parsed = joinSchema.safeParse(payload);
    if (parsed.success) await socket.leave(room.order(parsed.data.orderId));
  });
}
