import Link from "next/link";
import dynamic from "next/dynamic";
import { authHref } from "@/lib/authRoutes";

import { MapSkeleton } from "@/components/MapSkeleton";

const DashboardLink = dynamic(() => import("@/components/DashboardLink"));
const LaundryMap = dynamic(() => import("@/components/LaundryMap"), { loading: () => <MapSkeleton /> });

const ROLES = [
  { title: "Customer", text: "Find vendors near you, pay securely and track pickup and delivery in real time." },
  { title: "Vendor", text: "List your laundry shop, receive paid orders and manage every step of the wash." },
  { title: "Courier", text: "Pick up and deliver orders around Karu and Mararaba and confirm each handover with a code." },
];

export default function Home() {
  return (
    <>
      <header className="site-header">
        <div className="site-header-inner">
          <Link href="/" className="brand">Laundry-Map</Link>
          <nav className="row" aria-label="Account">
            <Link href={authHref("login")} className="btn btn-ghost">Sign In</Link>
            <Link href={authHref("register")} className="btn btn-primary">Get Started</Link>
          </nav>
        </div>
      </header>
      <main className="landing">
        <section className="hero">
          <h1 className="hero-title">Laundry day, handled.</h1>
          <p className="hero-sub">Find trusted laundry vendors in Karu and Mararaba, pay securely and track pickup and delivery from your phone.</p>
          <div className="row">
            <Link href={authHref("register")} className="btn btn-primary btn-lg">Get Started</Link>
            <Link href={authHref("login")} className="btn btn-ghost btn-lg">Sign In</Link>
            <DashboardLink />
          </div>
        </section>
        <LaundryMap />
        <section className="roles" aria-label="Who it is for">
          {ROLES.map((r) => (
            <article className="role-card" key={r.title}>
              <h2>{r.title}</h2>
              <p>{r.text}</p>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
