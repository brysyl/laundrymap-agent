"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatNaira } from "@/lib/money";
import { submitGuard } from "@/lib/submitGuard";
import type { Order, Vendor } from "@/lib/types";
import { ErrorText, Shell, useUser } from "@/components/Shell";
import { useLive } from "@/lib/useLive";

// Karu / Mararaba default when location is unavailable.
const DEFAULT_POS = { lat: 9.0, lng: 7.59 };

export default function CustomerHome() {
  const user = useUser("CUSTOMER");
  const router = useRouter();
  const [pos, setPos] = useState(DEFAULT_POS);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [qty, setQty] = useState(1);
  const [item, setItem] = useState("Shirts");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadVendors = useCallback(async () => {
    try {
      const r = await api<{ vendors: Vendor[] }>(`/api/vendors/nearby?lat=${pos.lat}&lng=${pos.lng}&radiusM=10000`);
      setVendors(r.vendors);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load vendors"); }
  }, [pos]);
  useEffect(() => { void loadVendors(); }, [loadVendors]);

  useLive(async () => { if (user) setOrders((await api<{ orders: Order[] }>("/api/me/orders")).orders); }, () => []);

  const locate = () => navigator.geolocation?.getCurrentPosition((p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }), () => setError("Location unavailable, showing Karu."), { timeout: 8000 });

  const place = async () => {
    if (!vendor) return;
    setError("");
    setBusy(true);
    try {
      const body = { vendorId: vendor.id, items: [{ name: item, quantity: qty }], dropoff: { address, lat: pos.lat, lng: pos.lng } };
      // Scope includes the payload so a changed order gets a new key but a double tap shares one request.
      const scope = `order:create:${JSON.stringify(body)}`;
      const r = await submitGuard.run(scope, (key) => api<{ order: Order }>("/api/orders", { method: "POST", body, idempotencyKey: key }));
      router.push(`/customer/orders/${r.order.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not place order"); } finally { setBusy(false); }
  };

  return (
    <Shell title="Find a laundry" user={user}>
      <div className="row"><button className="ghost" onClick={locate}>Use my location</button></div>
      <ErrorText error={error} />
      {vendors.length === 0 && <p className="muted">No approved vendors nearby.</p>}
      {vendors.map((v) => (
        <div key={v.id} className="card">
          <div className="row between"><strong>{v.name}</strong><span className="badge">{((v.distanceM ?? 0) / 1000).toFixed(1)} km</span></div>
          <div className="muted">{v.address} · {formatNaira(v.unitPriceKobo)} per item</div>
          <button className={vendor?.id === v.id ? "" : "ghost"} onClick={() => setVendor(v)}>{vendor?.id === v.id ? "Selected" : "Choose"}</button>
        </div>
      ))}
      {vendor && (
        <section className="card">
          <h2>Order from {vendor.name}</h2>
          <label htmlFor="item">Item</label>
          <input id="item" value={item} onChange={(e) => setItem(e.target.value)} maxLength={80} />
          <label htmlFor="qty">Quantity</label>
          <input id="qty" type="number" min={1} max={100} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(100, Math.floor(Number(e.target.value) || 1))))} />
          <label htmlFor="addr">Pickup and delivery address</label>
          <input id="addr" value={address} onChange={(e) => setAddress(e.target.value)} minLength={3} maxLength={200} />
          <p>Items: {formatNaira(vendor.unitPriceKobo * qty)} plus delivery fee added at checkout.</p>
          <button onClick={place} disabled={busy || address.trim().length < 3 || !item.trim()}>{busy ? "Placing..." : "Place order"}</button>
        </section>
      )}
      <h2>My orders</h2>
      {orders.length === 0 && <p className="muted">No orders yet.</p>}
      {orders.map((o) => (
        <Link key={o.id} href={`/customer/orders/${o.id}`} className="card" style={{ display: "block" }}>
          <div className="row between"><span>{formatNaira(o.totalKobo)}</span><span className="badge">{o.status}</span></div>
          <div className="muted">{new Date(o.createdAt).toLocaleString()}</div>
        </Link>
      ))}
    </Shell>
  );
}
