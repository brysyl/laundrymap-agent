"use client";
import { useCallback, useEffect, useRef } from "react";
import { connectRealtime } from "./socket";
import { connectionStore } from "./connectionStore";

/**
 * Keeps a page fresh: socket events and every (re)connect trigger `refresh`
 * (a REST fetch), with a slow poll as a fallback when the socket is unavailable.
 */
export function useLive(refresh: () => Promise<void> | void, orderIds: () => string[] = () => [], pollMs = 20_000) {
  const refreshRef = useRef(refresh);
  const idsRef = useRef(orderIds);
  refreshRef.current = refresh;
  idsRef.current = orderIds;
  const run = useCallback(() => { void Promise.resolve(refreshRef.current()).catch(() => undefined); }, []);

  useEffect(() => {
    run();
    const stop = connectRealtime(
      { onSync: run, onEvent: run, onState: (s) => connectionStore.set({ realtime: s }) },
      () => idsRef.current(),
    );
    const timer = setInterval(() => { if (document.visibilityState === "visible") run(); }, pollMs);
    const onOnline = () => run();
    window.addEventListener("online", onOnline);
    return () => { stop(); clearInterval(timer); window.removeEventListener("online", onOnline); };
  }, [run, pollMs]);
}
