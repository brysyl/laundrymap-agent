import type { Metadata } from "next";

export const metadata: Metadata = { title: "Offline" };

export default function Offline() {
  return (
    <main>
      <h1>You are offline</h1>
      <p>Laundry-Map needs a connection to load this page. Check your network and try again.</p>
      <p className="muted">Orders you already submitted are safe. Live status refreshes when you are back online.</p>
      <a href="/"><button>Try again</button></a>
    </main>
  );
}
