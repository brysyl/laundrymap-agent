"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { authHref, parseAuthMode, type AuthMode } from "@/lib/authRoutes";
import { api, tokenStore } from "@/lib/api";
import { submitGuard } from "@/lib/submitGuard";
import type { Role, User } from "@/lib/types";
import { ErrorText, HOME } from "@/components/Shell";

export default function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const mode: AuthMode = parseAuthMode(params.get("mode"), pathname);
  const [showPw, setShowPw] = useState(false);
  const [role, setRole] = useState<"CUSTOMER" | "VENDOR" | "COURIER">("CUSTOMER");
  const [f, setF] = useState({ identifier: "", password: "", name: "", email: "", phone: "", shop: "", address: "", price: "1000" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await submitGuard.run(`auth:${mode}`, async (key) => {
        if (mode === "login") return api<{ user: User; token: string }>("/api/auth/login", { method: "POST", body: { identifier: f.identifier, password: f.password }, idempotencyKey: key });
        const body: Record<string, unknown> = { name: f.name, email: f.email, phone: f.phone, password: f.password, role };
        if (role === "VENDOR") {
          const pos = await new Promise<GeolocationPosition>((ok, no) => navigator.geolocation.getCurrentPosition(ok, no, { timeout: 10_000 }));
          body.vendor = { name: f.shop, address: f.address, lat: pos.coords.latitude, lng: pos.coords.longitude, unitPriceKobo: Math.round(Number(f.price) * 100) };
        }
        return api<{ user: User; token: string }>("/api/auth/register", { method: "POST", body, idempotencyKey: key });
      });
      tokenStore.set(res.token, res.user);
      router.replace(HOME[res.user.role as Role]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <Link href="/" className="brand">Laundry-Map</Link>
        <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
        <form onSubmit={submit} className="form">
          {mode === "login" ? (
            <div className="field">
              <label htmlFor="id">Email or phone</label>
              <input id="id" value={f.identifier} onChange={set("identifier")} autoComplete="username" required />
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="role">I am a</label>
                <select id="role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                  <option value="CUSTOMER">Customer</option>
                  <option value="VENDOR">Laundry vendor</option>
                  <option value="COURIER">Courier</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="name">Full name</label>
                <input id="name" value={f.name} onChange={set("name")} required minLength={2} />
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" type="email" value={f.email} onChange={set("email")} required />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone</label>
                <input id="phone" type="tel" value={f.phone} onChange={set("phone")} required pattern="\+?[0-9]{10,15}" />
              </div>
              {role === "VENDOR" && (
                <>
                  <div className="field">
                    <label htmlFor="shop">Shop name</label>
                    <input id="shop" value={f.shop} onChange={set("shop")} required />
                  </div>
                  <div className="field">
                    <label htmlFor="addr">Shop address</label>
                    <input id="addr" value={f.address} onChange={set("address")} required />
                  </div>
                  <div className="field">
                    <label htmlFor="price">Price per item (NGN)</label>
                    <input id="price" type="number" min="1" step="1" value={f.price} onChange={set("price")} required />
                  </div>
                  <p className="muted">Your shop location is taken from this device. Allow location access when asked.</p>
                </>
              )}
            </>
          )}
          <div className="field">
            <label htmlFor="pw">Password</label>
            <div className="pw-wrap">
              <input id="pw" type={showPw ? "text" : "password"} value={f.password} onChange={set("password")} required minLength={mode === "register" ? 10 : 1} autoComplete={mode === "login" ? "current-password" : "new-password"} />
              <button type="button" className="pw-toggle" aria-pressed={showPw} aria-label={showPw ? "Hide password" : "Show password"} onClick={() => setShowPw((v) => !v)}>
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <ErrorText error={error} />
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? "Please wait..." : mode === "login" ? "Sign in" : "Register"}</button>
        </form>
        <div className="auth-alt">
          <Link href={authHref(mode === "login" ? "register" : "login")} replace className="btn btn-ghost">
            {mode === "login" ? "Create account" : "I have an account"}
          </Link>
          <Link href="/" className="link-quiet">Back to home</Link>
        </div>
      </div>
    </main>
  );
}
