import { createHash } from "node:crypto";

/**
 * Beacon token-name derivation — byte-for-byte mirror of
 * contracts/lib/p2p_dex/beacons.ak (mvp-contract-decisions.md §3).
 * The known-answer tests in beacons.test.ts assert the same digests as the
 * Aiken test suite; change both implementations together or neither.
 */

export interface AssetClassHex {
  /** hex, 56 chars (28 bytes); "" for ADA */
  policyId: string;
  /** hex; "" for ADA */
  assetNameHex: string;
}

export const ADA: AssetClassHex = { policyId: "", assetNameHex: "" };

export const ORDER_BEACON_NAME_HEX = Buffer.from("order").toString("hex"); // 6f72646572

export function isAda(a: AssetClassHex): boolean {
  return a.policyId === "" && a.assetNameHex === "";
}

function assetId(a: AssetClassHex): Buffer {
  return Buffer.from(a.policyId + a.assetNameHex, "hex");
}

function lengthPrefixed(id: Buffer): Buffer {
  return Buffer.concat([Buffer.from([id.length]), id]);
}

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

/** Undirected: same name whichever side is offered. */
export function pairBeaconName(a: AssetClassHex, b: AssetClassHex): string {
  const ia = assetId(a);
  const ib = assetId(b);
  const [lo, hi] = Buffer.compare(ia, ib) <= 0 ? [ia, ib] : [ib, ia];
  return sha256(
    Buffer.concat([Buffer.from([0x00]), lengthPrefixed(lo), lengthPrefixed(hi)])
  );
}

export function offerBeaconName(offer: AssetClassHex): string {
  return sha256(Buffer.concat([Buffer.from([0x01]), assetId(offer)]));
}

export function askBeaconName(ask: AssetClassHex): string {
  return sha256(Buffer.concat([Buffer.from([0x02]), assetId(ask)]));
}

/** The owner's 28-byte staking key hash, verbatim (hex in = hex out). */
export function ownerBeaconName(ownerKeyHashHex: string): string {
  return ownerKeyHashHex.toLowerCase();
}

export interface BeaconNames {
  order: string;
  pair: string;
  offer: string;
  ask: string;
  owner: string;
}

export function deriveBeaconNames(
  offer: AssetClassHex,
  ask: AssetClassHex,
  ownerKeyHashHex: string
): BeaconNames {
  return {
    order: ORDER_BEACON_NAME_HEX,
    pair: pairBeaconName(offer, ask),
    offer: offerBeaconName(offer),
    ask: askBeaconName(ask),
    owner: ownerBeaconName(ownerKeyHashHex),
  };
}

/** "policyHex.assetNameHex" | "lovelace" — the API-level asset id. */
export function toApiAssetId(a: AssetClassHex): string {
  return isAda(a) ? "lovelace" : `${a.policyId}.${a.assetNameHex}`;
}

export function fromApiAssetId(id: string): AssetClassHex {
  if (id === "lovelace") return ADA;
  const [policyId, assetNameHex = ""] = id.split(".");
  if (!policyId || !/^[0-9a-f]{56}$/.test(policyId))
    throw new Error(`invalid asset id: ${id}`);
  if (!/^[0-9a-f]*$/.test(assetNameHex) || assetNameHex.length > 64)
    throw new Error(`invalid asset name in: ${id}`);
  return { policyId, assetNameHex };
}

/** Canonical undirected pair id: sorted API asset ids joined by "_". */
export function toPairId(a: AssetClassHex, b: AssetClassHex): string {
  const [x, y] = [toApiAssetId(a), toApiAssetId(b)].sort();
  return `${x}_${y}`;
}
