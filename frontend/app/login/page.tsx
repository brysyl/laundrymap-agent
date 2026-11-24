"use client";
import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, tokenStore } from "@/lib/api";
import { submitGuard } from "@/lib/submitGuard";
import type { Role, User } from "@/lib/types";
import { ErrorText, HOME } from "@/components/Shell";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">(params.get("mode") === "register" ? "register" : "login");
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
    <main>
      <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
      <form onSubmit={submit}>
        {mode === "login" ? (
          <>
            <label htmlFor="id">Email or phone</label>
            <input id="id" value={f.identifier} onChange={set("identifier")} autoComplete="username" required />
          </>
        ) : (
          <>
            <label htmlFor="role">I am a</label>
            <select id="role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="CUSTOMER">Customer</option>
              <option value="VENDOR">Laundry vendor</option>
              <option value="COURIER">Courier</option>
            </select>
            <label htmlFor="name">Full name</label>
            <input id="name" value={f.name} onChange={set("name")} required minLength={2} />
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={f.email} onChange={set("email")} required />
            <label htmlFor="phone">Phone</label>
            <input id="phone" type="tel" value={f.phone} onChange={set("phone")} required pattern="\+?[0-9]{10,15}" />
            {role === "VENDOR" && (
              <>
                <label htmlFor="shop">Shop name</label>
                <input id="shop" value={f.shop} onChange={set("shop")} required />
                <label htmlFor="addr">Shop address</label>
                <input id="addr" value={f.address} onChange={set("address")} required />
                <label htmlFor="price">Price per item (NGN)</label>
                <input id="price" type="number" min="1" step="1" value={f.price} onChange={set("price")} required />
                <p className="muted">Your shop location is taken from this device. Allow location access when asked.</p>
              </>
            )}
          </>
        )}
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" value={f.password} onChange={set("password")} required minLength={mode === "register" ? 10 : 1} autoComplete={mode === "login" ? "current-password" : "new-password"} />
        <ErrorText error={error} />
        <div className="row" style={{ marginTop: "1rem" }}>
          <button type="submit" disabled={busy}>{busy ? "Please wait..." : mode === "login" ? "Sign in" : "Register"}</button>
          <button type="button" className="ghost" onClick={() => setMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "Create account" : "I have an account"}
          </button>
        </div>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<main><p>Loading...</p></main>}><LoginForm /></Suspense>;
}
