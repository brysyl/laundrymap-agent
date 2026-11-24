export type AuthMode = "login" | "register";

/** Resolve the auth mode from a ?mode value, falling back to the route pathname. */
export function parseAuthMode(value?: string | string[] | null, pathname?: string | null): AuthMode {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === "register") return "register";
  if (v === "login") return "login";
  if (pathname && pathname.replace(/\/+$/, "") === "/register") return "register";
  return "login";
}

export function authHref(mode: AuthMode): string {
  return mode === "register" ? "/auth?mode=register" : "/auth";
}
