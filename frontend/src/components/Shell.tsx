"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { tokenStore } from "@/lib/api";
import type { Role, User } from "@/lib/types";

export const HOME: Record<Role, string> = { CUSTOMER: "/customer", VENDOR: "/vendor", COURIER: "/courier", ADMIN: "/admin" };

/** Client-side guard for UX only. The API enforces roles on every request. */
export function useUser(required?: Role): User | null {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    const u = tokenStore.user();
    if (!u || !tokenStore.get()) { router.replace("/login"); return; }
    if (required && u.role !== required) { router.replace(HOME[u.role]); return; }
    setUser(u);
  }, [router, required]);
  return user;
}

export function Shell({ title, user, children }: { title: string; user: User | null; children: ReactNode }) {
  const router = useRouter();
  return (
    <main>
      <header className="top">
        <Link href="/" className="brand">Laundry-Map</Link>
        {user && (
          <button className="ghost" onClick={() => { tokenStore.clear(); router.replace("/login"); }}>Sign out ({user.name})</button>
        )}
      </header>
      <h1>{title}</h1>
      {user ? children : <p>Loading...</p>}
    </main>
  );
}

export function ErrorText({ error }: { error: string }) {
  return error ? <p role="alert" className="error">{error}</p> : null;
}
