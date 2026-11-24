"use client";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { formatNaira } from "@/lib/money";
import { submitGuard } from "@/lib/submitGuard";
import { useLive } from "@/lib/useLive";
import type { Order } from "@/lib/types";
import { ErrorText, Shell, useUser } from "@/components/Shell";

interface Row { id: string; name?: string; userId?: string; status: string }
interface LedgerEntry { id: string; account: string; direction: string; amountKobo: number; type: string; createdAt: string }
interface System { env: string; counts: Record<string, number>; ledger: { debitsKobo: string; creditsKobo: string; balanced: boolean }; revenueKobo: string }
interface Refund { id: string; orderId: string; amountKobo: number; kind: string; status: string; reason: string }

export default function AdminPage() {
  const user = useUser("ADMIN");
  const [vendors, setVendors] = useState<Row[]>([]);
  const [couriers, setCouriers] = useState<Row[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [system, setSystem] = useState<System | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [v, c, o, r, l, s] = await Promise.all([
      api<{ vendors: Row[] }>("/api/admin/vendors"),
      api<{ couriers: Row[] }>("/api/admin/couriers"),
      api<{ orders: Order[] }>("/api/me/orders"),
      api<{ refunds: Refund[] }>("/api/admin/refunds"),
      api<{ entries: LedgerEntry[] }>("/api/admin/ledger?limit=50"),
      api<System>("/api/admin/system"),
    ]);
    setVendors(v.vendors); setCouriers(c.couriers); setOrders(o.orders); setRefunds(r.refunds); setLedger(l.entries); setSystem(s);
  }, []);
  useLive(refresh, () => [], 30_000);

  const run = async (scope: string, path: string, body?: unknown) => {
    setError("");
    try {
      await submitGuard.run(scope, (key) => api(path, { method: "POST", body, idempotencyKey: key }));
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
  };

  const refund = (o: Order) => {
    const reason = window.prompt(`Refund ${formatNaira(o.totalKobo)} for order ${o.id}? Enter a reason (min 5 characters):`);
    if (!reason) return;
    if (window.prompt("Type the order id to confirm this refund:") !== o.id) { setError("Order id did not match. Refund not sent."); return; }
    void run(`refund:${o.id}`, `/api/admin/orders/${o.id}/refund`, { confirm: o.id, reason });
  };

  const approvals = (title: string, kind: "vendors" | "couriers", rows: Row[]) => (
    <>
      <h2>{title}</h2>
      {rows.length === 0 && <p className="muted">None.</p>}
      {rows.map((r) => (
        <div key={r.id} className="card row between">
          <span>{r.name ?? r.userId} <span className="badge">{r.status}</span></span>
          <span className="row">
            {r.status !== "APPROVED" && <button onClick={() => run(`${kind}:${r.id}:approve`, `/api/admin/${kind}/${r.id}/approve`)}>Approve</button>}
            {r.status !== "SUSPENDED" && <button className="danger" onClick={() => run(`${kind}:${r.id}:suspend`, `/api/admin/${kind}/${r.id}/suspend`)}>Suspend</button>}
          </span>
        </div>
      ))}
    </>
  );

  return (
    <Shell title="Admin" user={user}>
      <ErrorText error={error} />
      {system && (
        <div className="card">
          <div>Environment: {system.env}. Ledger {system.ledger.balanced ? "balanced" : "UNBALANCED"} (debits {system.ledger.debitsKobo}, credits {system.ledger.creditsKobo} kobo).</div>
          <div className="muted">Platform revenue: {formatNaira(Number(system.revenueKobo))}. {Object.entries(system.counts).map(([k, v]) => `${k}: ${v}`).join(", ")}</div>
        </div>
      )}
      {approvals("Vendors", "vendors", vendors)}
      {approvals("Couriers", "couriers", couriers)}
      <h2>Orders</h2>
      {orders.slice(0, 50).map((o) => (
        <div key={o.id} className="card row between">
          <span>{formatNaira(o.totalKobo)} <span className="badge">{o.status}</span><br /><small className="muted">{o.id}</small></span>
          {["AWAITING_VENDOR", "ACCEPTED", "IN_PROGRESS", "READY_FOR_PICKUP", "COURIER_ASSIGNED", "OUT_FOR_DELIVERY"].includes(o.status) && <button className="danger" onClick={() => refund(o)}>Refund</button>}
        </div>
      ))}
      <h2>Refunds</h2>
      {refunds.length === 0 && <p className="muted">No refunds.</p>}
      {refunds.map((r) => <div key={r.id} className="card">{formatNaira(r.amountKobo)} {r.kind} <span className="badge">{r.status}</span><div className="muted">{r.reason}</div></div>)}
      <h2>Ledger (latest)</h2>
      <table>
        <thead><tr><th>Type</th><th>Account</th><th>Dir</th><th>Amount</th></tr></thead>
        <tbody>{ledger.map((e) => <tr key={e.id}><td>{e.type}</td><td>{e.account}</td><td>{e.direction}</td><td>{formatNaira(e.amountKobo)}</td></tr>)}</tbody>
      </table>
    </Shell>
  );
}
