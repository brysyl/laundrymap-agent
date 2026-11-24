"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { action, api } from "@/lib/api";
import { formatNaira } from "@/lib/money";
import { submitGuard } from "@/lib/submitGuard";
import { shouldSendLocation, type Fix } from "@/lib/throttle";
import { useLive } from "@/lib/useLive";
import type { Order } from "@/lib/types";
import { ErrorText, Shell, useUser } from "@/components/Shell";

export default function CourierJobs() {
  const user = useUser("COURIER");
  const [orders, setOrders] = useState<Order[]>([]);
  const [otp, setOtp] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lastSent = useRef<Fix | null>(null);

  const refresh = useCallback(async () => { setOrders((await api<{ orders: Order[] }>("/api/me/orders")).orders); }, []);
  useLive(refresh);

  const mine = orders.filter((o) => o.courierId === user?.id && ["COURIER_ASSIGNED", "OUT_FOR_DELIVERY"].includes(o.status));
  const open = orders.filter((o) => !o.courierId && o.status === "READY_FOR_PICKUP");
  const tracking = mine.length > 0;

  // Throttled geolocation: only while a job is active, and only when moved or heartbeat is due.
  useEffect(() => {
    if (!tracking || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (p) => {
        const fix: Fix = { lat: p.coords.latitude, lng: p.coords.longitude, at: Date.now() };
        if (!shouldSendLocation(lastSent.current, fix)) return;
        lastSent.current = fix;
        void api("/api/courier/location", { method: "POST", body: { lat: fix.lat, lng: fix.lng } }).catch(() => { lastSent.current = null; });
      },
      () => setNotice("Location is off. Turn it on so the customer can follow the delivery."),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [tracking]);

  const act = async (o: Order, verb: string) => {
    setError(""); setNotice("");
    try {
      const r = await submitGuard.run(`courier:${o.id}:${verb}`, (key) => action(`/api/courier/orders/${o.id}/${verb}`, key));
      if (r.queued) setNotice("You are offline. This will be sent when you reconnect.");
      else await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); await refresh().catch(() => undefined); }
  };
  const deliver = async (o: Order) => {
    setError("");
    try {
      await submitGuard.run(`courier:${o.id}:deliver`, (key) => api(`/api/courier/orders/${o.id}/deliver`, { method: "POST", body: { otp: otp[o.id] ?? "" }, idempotencyKey: key }));
      setOtp({ ...otp, [o.id]: "" });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Code was not accepted"); }
  };

  return (
    <Shell title="Courier jobs" user={user}>
      <ErrorText error={error} />
      {notice && <p role="status">{notice}</p>}
      <h2>My deliveries</h2>
      {mine.length === 0 && <p className="muted">No active delivery.</p>}
      {mine.map((o) => (
        <div key={o.id} className="card">
          <div className="row between"><span>{o.dropoffAddress}</span><span className="badge">{o.status}</span></div>
          {o.status === "COURIER_ASSIGNED" && <button onClick={() => act(o, "pickup")}>Picked up from vendor</button>}
          {o.status === "OUT_FOR_DELIVERY" && (
            <>
              <label htmlFor={`otp-${o.id}`}>Customer delivery code</label>
              <input id={`otp-${o.id}`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp[o.id] ?? ""} onChange={(e) => setOtp({ ...otp, [o.id]: e.target.value.replace(/\D/g, "") })} />
              <button onClick={() => deliver(o)} disabled={(otp[o.id] ?? "").length !== 6}>Confirm delivery</button>
            </>
          )}
        </div>
      ))}
      <h2>Available jobs</h2>
      {open.length === 0 && <p className="muted">No jobs ready for pickup.</p>}
      {open.map((o) => (
        <div key={o.id} className="card">
          <div>{o.dropoffAddress}</div>
          <div className="muted">Delivery fee {formatNaira(o.deliveryFeeKobo)}</div>
          <button onClick={() => act(o, "claim")}>Claim job</button>
        </div>
      ))}
    </Shell>
  );
}
