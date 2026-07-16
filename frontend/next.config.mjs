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
  // Same-origin API proxying lives in app/backend/[...path]/route.ts — a
  // route handler, NOT a rewrite here, because rewrites are frozen into the
  // build manifest at `next build` time while BACKEND_INTERNAL_URL must be
  // read at runtime (docker compose sets it to http://backend:3001).
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
