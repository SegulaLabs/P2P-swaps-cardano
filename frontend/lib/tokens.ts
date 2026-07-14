/**
 * Pure token display/amount helpers — no network, unit-tested.
 * Decimals are COSMETIC (registry metadata); all on-chain math stays in raw
 * integer units — these helpers only convert at the UI boundary.
 */

export interface AssetInfoLite {
  assetId: string;
  policyId: string;
  assetNameHex: string;
  ticker?: string;
  name?: string;
  decimals?: number;
}

/** Printable-ASCII decode of a hex asset name, else null. */
export function hexToAsciiName(hex: string): string | null {
  if (hex === "" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  if (!bytes.every((b) => b >= 0x20 && b <= 0x7e)) return null;
  return String.fromCharCode(...bytes);
}

/** Best display ticker: registry ticker > registry name > ASCII name > short hex. */
export function tickerOf(info: AssetInfoLite | null, assetId: string): string {
  if (assetId === "lovelace") return info?.ticker ?? "tADA";
  if (info?.ticker) return info.ticker;
  if (info?.name) return info.name;
  const nameHex = assetId.split(".")[1] ?? "";
  return hexToAsciiName(nameHex) ?? `${assetId.slice(0, 6)}…${nameHex.slice(-4) || "?"}`;
}

export function decimalsOf(info: AssetInfoLite | null, assetId: string): number {
  if (assetId === "lovelace") return info?.decimals ?? 6;
  return info?.decimals ?? 0;
}

/**
 * "1.5" with 6 decimals -> 1500000n. Throws on malformed input, negative,
 * or more fractional digits than the asset supports.
 */
export function toRawAmount(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("not a number");
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals)
    throw new Error(`max ${decimals} decimal place${decimals === 1 ? "" : "s"} for this asset`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 1500000n with 6 decimals -> "1.5" (no trailing zeros). */
export function fromRawAmount(raw: bigint | string, decimals: number): string {
  const value = BigInt(raw);
  if (decimals === 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/**
 * Deterministic hue for a letter-avatar so each token gets a stable color.
 *
 * FNV-1a followed by a murmur3 finalizer: assets that differ only in the last
 * byte of their name (e.g. TESTA…TESTF share a policy and differ by one hex
 * char) still land on well-separated hues, so adjacent markets are easy to
 * tell apart. A plain rolling hash put them ~1° apart — all the same colour.
 */
export function avatarHue(assetId: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < assetId.length; i++) {
    h ^= assetId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // murmur3 avalanche: spread the low-order bits (which %360 samples) across
  // the whole word so a single changed input byte reaches every output bit.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) % 360;
}
