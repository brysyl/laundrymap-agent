"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { authHref } from "@/lib/authRoutes";
import { formatNaira } from "@/lib/money";
import { DEMO_VENDORS, SERVICE_LABELS, type DemoVendor, type ServiceType } from "@/lib/demoVendors";
import {
  ORDER_STEPS, PICKUP_SLOTS, estimateTotal, filterVendors, nextStep, prevStep, sortVendors, vendorPrice,
  type OrderStep, type ServiceFilter, type SortKey,
} from "@/lib/demoFilter";

const SERVICES = Object.keys(SERVICE_LABELS) as ServiceType[];
const STEP_LABELS: Record<OrderStep, string> = { service: "Service", items: "Items", slot: "Pickup slot", review: "Review" };

function DemoBadge() {
  return <span className="demo-badge">Demo Data</span>;
}

export default function LaundryMap() {
  const [service, setService] = useState<ServiceFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("eta");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flow, setFlow] = useState<{ step: OrderStep; service: ServiceType; items: number; slot: string; done: boolean } | null>(null);

  const vendors = useMemo(() => sortVendors(filterVendors(DEMO_VENDORS, service, search), sort, service), [service, search, sort]);
  const selected: DemoVendor | undefined = vendors.find((v) => v.id === selectedId);

  function select(id: string) {
    setSelectedId(id);
    setFlow(null);
  }

  function startFlow(v: DemoVendor) {
    const first = service !== "all" && v.services.includes(service) ? service : v.services[0] ?? "wash-fold";
    setFlow({ step: "service", service: first, items: 5, slot: PICKUP_SLOTS[0], done: false });
  }

  const total = selected && flow ? estimateTotal(selected, flow.service, flow.items) : null;

  return (
    <section className="demo-map" aria-labelledby="demo-map-title">
      <div className="row between">
        <h2 id="demo-map-title" className="demo-title">Explore the Laundry Map</h2>
        <DemoBadge />
      </div>
      <p className="muted">Sample vendors around Karu, Mararaba and the Abuja border. Explore without signing in. Nothing here is live and no order is placed.</p>

      <div className="demo-controls">
        <div>
          <label htmlFor="demo-search">Search vendor or area</label>
          <input id="demo-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. Karu, Nyanya" autoComplete="off" />
        </div>
        <div>
          <label htmlFor="demo-sort">Sort by</label>
          <select id="demo-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="eta">Fastest pickup (ETA)</option>
            <option value="rating">Top rated</option>
            <option value="price">Lowest price</option>
          </select>
        </div>
      </div>

      <div className="demo-chips" role="group" aria-label="Filter by service">
        {(["all", ...SERVICES] as ServiceFilter[]).map((s) => (
          <button key={s} type="button" className={`chip${service === s ? " chip-on" : ""}`} aria-pressed={service === s} onClick={() => setService(s)}>
            {s === "all" ? "All" : SERVICE_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="demo-layout">
        <div className="demo-svg-wrap">
          <span className="demo-badge demo-badge-map">Demo Data</span>
          <svg viewBox="0 0 100 60" className="demo-svg" role="group" aria-label="Demo corridor map, Abuja side on the left and Karu on the right">
            <rect width="100" height="60" fill="#ecfeff" />
            <path d="M0 50 C 25 40, 35 30, 55 30 S 85 12, 100 8" stroke="#bae6fd" strokeWidth="5" fill="none" />
            <path d="M0 50 C 25 40, 35 30, 55 30 S 85 12, 100 8" stroke="#fff" strokeWidth="0.6" strokeDasharray="2 2" fill="none" />
            <text x="3" y="57" className="demo-svg-label">Abuja side</text>
            <text x="97" y="57" textAnchor="end" className="demo-svg-label">Karu - Mararaba</text>
            {vendors.map((v) => (
              <g key={v.id} transform={`translate(${v.x} ${v.y})`}>
                <foreignObject x="-3.5" y="-3.5" width="7" height="7" overflow="visible">
                  <button type="button" className={`pin${v.id === selectedId ? " pin-on" : ""}`} aria-pressed={v.id === selectedId} aria-label={`${v.name}, ${v.area}, rating ${v.rating}, ${v.etaMin} minutes`} onClick={() => select(v.id)} />
                </foreignObject>
              </g>
            ))}
          </svg>
          {vendors.length === 0 && <p className="demo-empty muted">No demo vendors match.</p>}
        </div>

        <ul className="demo-list" aria-label="Demo vendors">
          {vendors.map((v) => (
            <li key={v.id}>
              <button type="button" className={`vendor-card${v.id === selectedId ? " vendor-card-on" : ""}`} aria-pressed={v.id === selectedId} onClick={() => select(v.id)}>
                <span className="row between">
                  <strong>{v.name}</strong>
                  <DemoBadge />
                </span>
                <span className="muted">{v.area} · {v.distanceKm} km · {v.etaMin} min</span>
                <span className="vendor-meta">
                  <span>★ {v.rating} ({v.reviews})</span>
                  <span>from {formatNaira(vendorPrice(v, service))}/item</span>
                  {v.verified && <span className="tag tag-ok">Verified</span>}
                  {v.turnaround24hr && <span className="tag">24hr turnaround</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="demo-details" aria-live="polite">
        {!selected && <p className="muted">Select a pin or vendor card to see details.</p>}
        {selected && (
          <div>
            <div className="row between">
              <h3 className="demo-details-title">{selected.name}</h3>
              <DemoBadge />
            </div>
            <p className="muted">{selected.area} · {selected.distanceKm} km away · pickup in about {selected.etaMin} min · ★ {selected.rating} from {selected.reviews} reviews</p>
            <div className="vendor-meta">
              {selected.verified && <span className="tag tag-ok">Verified</span>}
              {selected.turnaround24hr && <span className="tag">24hr turnaround</span>}
            </div>
            <ul className="price-tiers" aria-label="Price tiers">
              {selected.services.map((s) => (
                <li key={s}><span>{SERVICE_LABELS[s]}</span><strong>{formatNaira(selected.prices[s] ?? 0)}/item</strong></li>
              ))}
            </ul>

            {!flow && <button type="button" onClick={() => startFlow(selected)}>Start demo pickup</button>}

            {flow && !flow.done && (
              <div className="demo-flow">
                <div className="row between">
                  <strong>Demo pickup</strong>
                  <DemoBadge />
                </div>
                <ol className="steps" aria-label="Progress">
                  {ORDER_STEPS.map((s) => (
                    <li key={s} className={s === flow.step ? "step-on" : ""} aria-current={s === flow.step ? "step" : undefined}>{STEP_LABELS[s]}</li>
                  ))}
                </ol>
                {flow.step === "service" && (
                  <div>
                    <label htmlFor="demo-flow-service">Service</label>
                    <select id="demo-flow-service" value={flow.service} onChange={(e) => setFlow({ ...flow, service: e.target.value as ServiceType })}>
                      {selected.services.map((s) => <option key={s} value={s}>{SERVICE_LABELS[s]}</option>)}
                    </select>
                  </div>
                )}
                {flow.step === "items" && (
                  <div>
                    <label htmlFor="demo-flow-items">Number of items (1 to 50)</label>
                    <input id="demo-flow-items" type="number" inputMode="numeric" min={1} max={50} value={flow.items} onChange={(e) => setFlow({ ...flow, items: Math.trunc(Number(e.target.value)) })} />
                  </div>
                )}
                {flow.step === "slot" && (
                  <div>
                    <label htmlFor="demo-flow-slot">Pickup slot</label>
                    <select id="demo-flow-slot" value={flow.slot} onChange={(e) => setFlow({ ...flow, slot: e.target.value })}>
                      {PICKUP_SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                )}
                {flow.step === "review" && (
                  <p>{flow.items} item(s), {SERVICE_LABELS[flow.service]}, pickup {flow.slot}. Estimated total <strong>{total === null ? "n/a" : formatNaira(total)}</strong> including a demo pickup fee.</p>
                )}
                {flow.step === "items" && total === null && <p className="error" role="alert">Enter a whole number from 1 to 50.</p>}
                <div className="row">
                  {flow.step !== "service" && <button type="button" className="ghost" onClick={() => setFlow({ ...flow, step: prevStep(flow.step) })}>Back</button>}
                  {flow.step !== "review" && <button type="button" disabled={flow.step === "items" && total === null} onClick={() => setFlow({ ...flow, step: nextStep(flow.step) })}>Next</button>}
                  {flow.step === "review" && <button type="button" disabled={total === null} onClick={() => setFlow({ ...flow, done: true })}>Finish demo</button>}
                  <button type="button" className="ghost" onClick={() => setFlow(null)}>Cancel</button>
                </div>
              </div>
            )}

            {flow && flow.done && (
              <div className="demo-flow demo-summary" role="status">
                <div className="row between">
                  <strong>Demo summary</strong>
                  <DemoBadge />
                </div>
                <p>{selected.name}: {flow.items} item(s), {SERVICE_LABELS[flow.service]}, pickup {flow.slot}. Estimated {total === null ? "n/a" : formatNaira(total)}.</p>
                <p className="muted">This was a demo. No order was placed and nothing was charged.</p>
                <div className="row">
                  <Link href={authHref("register")} className="btn btn-primary">Create account to order</Link>
                  <Link href="/auth" className="btn btn-ghost">Sign in / open dashboard</Link>
                  <button type="button" className="ghost" onClick={() => setFlow(null)}>Restart demo</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
