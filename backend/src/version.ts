import { readFileSync } from "node:fs";

/**
 * App version, read from backend/package.json at boot. Works both from
 * src/ (tsx, vitest) and dist/ (production build) since each sits one
 * level below the package root. Surfaced on /health and /protocol/config
 * so self-hosters can report exactly what they are running.
 */
export const APP_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;
