"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { tokenStore } from "@/lib/api";
import { HOME } from "@/components/Shell";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const u = tokenStore.user();
    if (u && tokenStore.get()) router.replace(HOME[u.role]);
  }, [router]);
  return (
    <main>
      <h1>Laundry-Map</h1>
      <p>Find laundry vendors near you in Karu and Mararaba, pay securely and track pickup and delivery.</p>
      <div className="row">
        <Link href="/login"><button>Sign in</button></Link>
        <Link href="/login?mode=register"><button className="ghost">Create account</button></Link>
      </div>
    </main>
  );
}
