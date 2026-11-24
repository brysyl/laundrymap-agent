"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { bannerMessage, connectionStore } from "@/lib/connectionStore";
import { getQueue, tokenStore } from "@/lib/api";
import { submitGuard } from "@/lib/submitGuard";
import { canApplyUpdate } from "@/lib/swPolicy";

export function PwaClient() {
  const snap = useSyncExternalStore(connectionStore.subscribe, connectionStore.get, connectionStore.server);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [hint, setHint] = useState("");

  // Online/offline tracking and retry-queue flushing.
  useEffect(() => {
    const queue = getQueue();
    const sync = () => connectionStore.set({ online: navigator.onLine, queued: queue.size });
    const flush = async () => {
      if (!navigator.onLine || queue.size === 0) return sync();
      await queue.flush(tokenStore.user()?.id ?? null);
      sync();
    };
    const onOnline = () => { sync(); void flush(); };
    sync();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", sync);
    const timer = setInterval(() => void flush(), 15_000);
    void flush();
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", sync); clearInterval(timer); };
  }, []);

  // Service worker registration and update detection.
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    let cancelled = false;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then((reg) => {
      if (cancelled) return;
      if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) setWaiting(w);
        });
      });
      const check = () => void reg.update().catch(() => undefined);
      const timer = setInterval(check, 60 * 60 * 1000);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
      return () => clearInterval(timer);
    }).catch(() => undefined);
    return () => { cancelled = true; navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange); };
  }, []);

  const apply = () => {
    if (!canApplyUpdate(submitGuard.isBusy(), getQueue().size)) {
      setHint("Finish what you are doing first, then tap Update again.");
      return;
    }
    waiting?.postMessage({ type: "SKIP_WAITING" });
  };

  const banner = bannerMessage(snap);
  return (
    <>
      {banner && <div role="status" className={`banner ${banner.tone}`}>{banner.text}</div>}
      {waiting && (
        <div role="alert" className="update">
          <span>A new version of Laundry-Map is available. {hint}</span>
          <button onClick={apply}>Update</button>
          <button className="ghost" onClick={() => setWaiting(null)}>Later</button>
        </div>
      )}
    </>
  );
}
