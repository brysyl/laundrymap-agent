"use client";
import { use, useCallback, useState } from "react";
import { api } from "@/lib/api";
import { formatNaira } from "@/lib/money";
import { submitGuard } from "@/lib/submitGuard";
import { useLive } from "@/lib/useLive";
import type { Order } from "@/lib/types";
import { ErrorText, Shell, useUser } from "@/components/Shell";

interface Sync { order: Order; payment: { reference: string; status: string } | null }

export default function TrackOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useUser("CUSTOMER");
  const [data, setData] = useState<Sync | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const s = await api<Sync>(`/api/orders/${id}/sync`);
    setData(s);
    if (s.order.status === "OUT_FOR_DELIVERY") {
      try { setCode((await api<{ code: string }>(`/api/orders/${id}/delivery-code`)).code); } catch { /* not available yet */ }
    } else setCode(null);
  }, [id]);
  useLive(refresh, () => [id]);

  const pay = async () => {
    setError("");
    setBusy(true);
    try {
      const r = await submitGuard.run(`pay:${id}`, (key) => api<{ authorizationUrl: string }>(`/api/orders/${id}/pay`, { method: "POST", idempotencyKey: key }));
      const url = new URL(r.authorizationUrl);
      if (url.protocol !== "https:") throw new Error("Unexpected payment URL");
      window.location.assign(url.toString());
    } catch (e) { setError(e instanceof Error ? e.message : "Payment could not start"); setBusy(false); }
  };
  const cancel = async () => {
    setError("");
    try {
      await submitGuard.run(`cancel:${id}`, (key) => api(`/api/orders/${id}/cancel`, { method: "POST", idempotencyKey: key }));
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not cancel"); }
  };

  const o = data?.order;
  return (
    <Shell title="Track order" user={user}>
      <ErrorText error={error} />
      {!o ? <p>Loading...</p> : (
        <>
          <div className="card">
            <div className="row between"><strong>{formatNaira(o.totalKobo)}</strong><span className="badge">{o.status}</span></div>
            <ul>{o.items.map((i) => <li key={i.id}>{i.quantity} x {i.name}</li>)}</ul>
            <div className="muted">Delivery to {o.dropoffAddress}. Delivery fee {formatNaira(o.deliveryFeeKobo)}.</div>
            {o.status === "AWAITING_VENDOR" && <p>Waiting for the vendor to accept (up to 2 minutes). You are refunded automatically if they do not.</p>}
            {o.status === "REFUNDED" && <p>Your payment was refunded.</p>}
          </div>
          {o.status === "PENDING_PAYMENT" && (
            <div className="row">
              <button onClick={pay} disabled={busy}>{busy ? "Opening payment..." : `Pay ${formatNaira(o.totalKobo)}`}</button>
              <button className="ghost" onClick={cancel}>Cancel</button>
            </div>
          )}
          {code && (
            <div className="card">
              <p>Give this code to the courier only when your laundry arrives:</p>
              <div className="otp" aria-label="Delivery code">{code}</div>
            </div>
          )}
          {data?.payment && <p className="muted">Payment {data.payment.status.toLowerCase()} (ref {data.payment.reference})</p>}
        </>
      )}
    </Shell>
  );
}
