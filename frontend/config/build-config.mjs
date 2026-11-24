// Pure helpers used by next.config.mjs. Kept separate so they can be unit tested.

/** Returns a normalized http(s) origin without trailing slash, or null when unset or invalid. */
export function normalizeTarget(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Proxies /api to the backend when a target is configured. Without a target the
 * default is the local backend, so `npm run dev` works out of the box.
 * Socket.IO is not proxied: browsers connect to NEXT_PUBLIC_SOCKET_URL directly.
 */
export function buildRewrites(target) {
  const origin = normalizeTarget(target) ?? "http://localhost:4000";
  return [{ source: "/api/:path*", destination: `${origin}/api/:path*` }];
}

export function swHeaders() {
  return [
    { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
    { key: "Content-Type", value: "application/javascript; charset=utf-8" },
    { key: "Service-Worker-Allowed", value: "/" },
  ];
}

export function securityHeaders(apiUrl, socketUrl) {
  const connect = ["'self'"];
  for (const v of [apiUrl, socketUrl]) {
    const o = normalizeTarget(v);
    if (o) {
      connect.push(o);
      connect.push(o.replace(/^http/, "ws"));
    }
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  ];
}
