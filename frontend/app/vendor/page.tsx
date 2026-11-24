"use client";
import { useCallback, useEffect, useState } from "react";
import { action, api } from "@/lib/api";
import { formatClock, offsetFromServerTime, secondsLeft } from "@/lib/countdown";
import { formatNaira } from "@/lib/money";
import { submitGuard } from "@/lib/submitGuard";
import { useLive } from "@/lib/useLive";
import type { Order } from "@/lib/types";
import { ErrorText, Shell, useUser } from "@/components/Shell";

function Countdown({ deadline, offset }: { deadline: string | null; offset: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const left = secondsLeft(deadline, now, offset);
  return <strong aria-live="off">{left > 0 ? `${formatClock(left)} left to respond` : "Time is up"}</strong>;
}

const NEXT: Record<string, { label: string; path: string } | undefined> = {
  ACCEPTED: { label: "Start washing", path: "start" },
  IN_PROGRESS: { label: "Mark ready for pickup", path: "ready" },
};

export default function VendorDashboard() {
  const user = useUser("VENDOR");
  const [orders, setOrders] = useState<Order[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const r = await api<{ orders: Order[]; serverTime: string }>("/api/me/orders");
    setOrders(r.orders);
    setOffset(offsetFromServerTime(r.serverTime, Date.now()));
  }, []);
  useLive(refresh);

  const act = async (o: Order, verb: string, body?: unknown) => {
    setError(""); setNotice("");
    try {
      const r = await submitGuard.run(`vendor:${o.id}:${verb}`, (key) => action(`/api/vendor/orders/${o.id}/${verb}`, key, body));
      if (r.queued) setNotice("You are offline. This will be sent when you reconnect.");
      else await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); await refresh().catch(() => undefined); }
  };

  const pending = orders.filter((o) => o.status === "AWAITING_VENDOR");
  const active = orders.filter((o) => ["ACCEPTED", "IN_PROGRESS", "READY_FOR_PICKUP", "COURIER_ASSIGNED", "OUT_FOR_DELIVERY"].includes(o.status));
  const delivered = orders.filter((o) => o.status === "DELIVERED");
  // Gross item revenue of completed orders. Net payable balances are in the admin ledger.
  const earnings = delivered.reduce((sum, o) => sum + o.subtotalKobo, 0);

  return (
    <Shell title="Vendor dashboard" user={user}>
      <ErrorText error={error} />
      {notice && <p role="status">{notice}</p>}
      <div className="card"><div className="muted">Completed orders: {delivered.length}</div><strong>Order value delivered: {formatNaira(earnings)}</strong><div className="muted">Platform fee is deducted at settlement.</div></div>
      <h2>Needs your response</h2>
      {pending.length === 0 && <p className="muted">No new orders.</p>}
      {pending.map((o) => (
        <div key={o.id} className="card">
          <Countdown deadline={o.acceptDeadline} offset={offset} />
          <ul>{o.items.map((i) => <li key={i.id}>{i.quantity} x {i.name}</li>)}</ul>
          <div>{formatNaira(o.subtotalKobo)}</div>
          <div className="row">
            <button onClick={() => act(o, "accept")} disabled={submitGuard.isBusy(`vendor:${o.id}:accept`)}>Accept</button>
            <button className="danger" onClick={() => act(o, "reject", { reason: "vendor unavailable" })}>Reject</button>
          </div>
        </div>
      ))}
      <h2>In progress</h2>
      {active.map((o) => (
        <div key={o.id} className="card">
          <div className="row between"><span>{o.items.map((i) => `${i.quantity} x ${i.name}`).join(", ")}</span><span className="badge">{o.status}</span></div>
          {NEXT[o.status] && <button onClick={() => act(o, NEXT[o.status]!.path)}>{NEXT[o.status]!.label}</button>}
        </div>
      ))}
      {active.length === 0 && <p className="muted">Nothing in progress.</p>}
    </Shell>
  );
}
