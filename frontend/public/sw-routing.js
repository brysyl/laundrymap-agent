/* Pure routing and cache-name logic for sw.js. Loaded with importScripts in the
 * service worker and with require() in unit tests. No browser APIs used here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SwRouting = api;
})(typeof self !== "undefined" ? self : this, function () {
  const VERSION = "v1";
  const CACHE_PREFIX = "laundrymap-";
  const STATIC_CACHE = CACHE_PREFIX + "static-" + VERSION;
  const SHELL_CACHE = CACHE_PREFIX + "shell-" + VERSION;
  const CURRENT_CACHES = [STATIC_CACHE, SHELL_CACHE];
  const OFFLINE_URL = "/offline";
  const PRECACHE_URLS = [
    OFFLINE_URL,
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-192.png",
    "/icons/icon-maskable-512.png",
    "/icons/apple-touch-icon.png",
  ];

  /** Paths that must always hit the network and never be stored. */
  const NETWORK_ONLY_PREFIXES = ["/api/", "/socket.io/", "/auth/", "/_next/data/"];
  const NETWORK_ONLY_EXACT = ["/api", "/socket.io", "/sw.js", "/sw-routing.js"];
  const SHELL_PREFIXES = ["/icons/"];
  const SHELL_EXACT = ["/manifest.webmanifest", "/favicon.ico", OFFLINE_URL];

  /**
   * Decide how the service worker handles a request.
   * @param {{url: string, method: string, mode?: string}} req
   * @param {string} origin the service worker's own origin
   * @returns {"passthrough"|"network-only"|"cache-first"|"stale-while-revalidate"|"navigate"}
   */
  function classifyRequest(req, origin) {
    let url;
    try { url = new URL(req.url, origin); } catch (e) { return "passthrough"; }
    if (url.origin !== origin) return "passthrough"; // cross-origin API/socket hosts are never touched
    const path = url.pathname;
    if (NETWORK_ONLY_EXACT.indexOf(path) !== -1) return "network-only";
    for (const p of NETWORK_ONLY_PREFIXES) if (path.indexOf(p) === 0) return "network-only";
    if (req.method !== "GET") return "network-only";
    if (path.indexOf("/_next/static/") === 0) return "cache-first";
    if (req.mode === "navigate") return "navigate";
    if (SHELL_EXACT.indexOf(path) !== -1) return "stale-while-revalidate";
    for (const p of SHELL_PREFIXES) if (path.indexOf(p) === 0) return "stale-while-revalidate";
    return "passthrough";
  }

  /** Caches belonging to this app but not to the current version. */
  function staleCacheNames(names) {
    return names.filter(function (n) { return n.indexOf(CACHE_PREFIX) === 0 && CURRENT_CACHES.indexOf(n) === -1; });
  }

  /** Only successful same-origin basic responses are stored. */
  function isCacheableResponse(res) {
    return !!res && res.status === 200 && (res.type === "basic" || res.type === "default");
  }

  return { VERSION, STATIC_CACHE, SHELL_CACHE, CURRENT_CACHES, OFFLINE_URL, PRECACHE_URLS, classifyRequest, staleCacheNames, isCacheableResponse };
});
