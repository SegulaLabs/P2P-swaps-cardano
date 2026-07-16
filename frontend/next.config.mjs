import { readFileSync } from "node:fs";

// Release version, shown in the site footer so self-hosters know what
// they are running (matches the backend's /health appVersion).
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
  // Same-origin API proxy: the browser calls /backend/* on this server and
  // never needs to know the backend's address (no CORS, works under any
  // hostname/IP). BACKEND_INTERNAL_URL is read at SERVER START, not baked
  // into the bundle — in docker compose it's http://backend:3001.
  async rewrites() {
    const backend =
      process.env.BACKEND_INTERNAL_URL || "http://localhost:3001";
    return [{ source: "/backend/:path*", destination: `${backend}/:path*` }];
  },
  // @meshsdk/core ships WebAssembly (cardano-serialization internals).
  webpack: (config) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };
    return config;
  },
};

export default nextConfig;
