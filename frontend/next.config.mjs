import { buildRewrites, securityHeaders, swHeaders } from "./config/build-config.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return buildRewrites(process.env.API_PROXY_TARGET || process.env.NEXT_PUBLIC_API_URL);
  },
  async headers() {
    return [
      { source: "/sw.js", headers: swHeaders() },
      { source: "/sw-routing.js", headers: swHeaders() },
      { source: "/manifest.webmanifest", headers: [{ key: "Content-Type", value: "application/manifest+json" }, { key: "Cache-Control", value: "public, max-age=0, must-revalidate" }] },
      { source: "/:path*", headers: securityHeaders(process.env.NEXT_PUBLIC_API_URL, process.env.NEXT_PUBLIC_SOCKET_URL) },
    ];
  },
};

export default nextConfig;
