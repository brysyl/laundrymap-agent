/* Laundry-Map service worker. Hand-written, no build step.
 * Strategy table lives in sw-routing.js (unit tested). */
importScripts("/sw-routing.js");

const R = self.SwRouting;

self.addEventListener("install", (event) => {
  // No skipWaiting here: an updated worker waits until the page asks for it (SKIP_WAITING message).
  event.waitUntil(
    caches.open(R.SHELL_CACHE).then((cache) => cache.addAll(R.PRECACHE_URLS.map((u) => new Request(u, { cache: "reload" })))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(R.staleCacheNames(names).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

async function cacheFirst(request) {
  const cache = await caches.open(R.STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (R.isCacheableResponse(res)) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(R.SHELL_CACHE);
  const hit = await cache.match(event.request);
  const refresh = fetch(event.request)
    .then((res) => {
      if (R.isCacheableResponse(res)) cache.put(event.request, res.clone());
      return res;
    })
    .catch(() => undefined);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  const res = await refresh;
  return res || Response.error();
}

async function navigate(request) {
  try {
    // Navigation HTML is not stored: pages can be user specific.
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(R.SHELL_CACHE);
    return (await cache.match(R.OFFLINE_URL)) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const strategy = R.classifyRequest(
    { url: event.request.url, method: event.request.method, mode: event.request.mode },
    self.location.origin,
  );
  switch (strategy) {
    case "cache-first":
      event.respondWith(cacheFirst(event.request));
      break;
    case "stale-while-revalidate":
      event.respondWith(staleWhileRevalidate(event));
      break;
    case "navigate":
      event.respondWith(navigate(event.request));
      break;
    default:
      // network-only and passthrough: do not call respondWith, the browser handles it uncached.
      break;
  }
});
