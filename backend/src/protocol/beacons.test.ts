import { describe, expect, it } from "vitest";
import {
  ADA,
  ORDER_BEACON_NAME_HEX,
  askBeaconName,
  deriveBeaconNames,
  fromApiAssetId,
  offerBeaconName,
  ownerBeaconName,
  pairBeaconName,
  toApiAssetId,
  toPairId,
} from "./beacons.js";

/**
 * Known-answer vectors — IDENTICAL to the Aiken test suite
 * (contracts/lib/tests/beacon_tests.ak). If these ever diverge, on-chain and
 * off-chain derivation have split and discovery/minting will break.
 */
const TOKEN_A = { policyId: "aa".repeat(28), assetNameHex: "544f4b41" };
const TOKEN_B = { policyId: "bb".repeat(28), assetNameHex: "544f4b42" };

describe("beacon name derivation (mirrors Aiken)", () => {
  it("order beacon is constant 'order'", () => {
    expect(ORDER_BEACON_NAME_HEX).toBe("6f72646572");
  });

  it("offer beacon known answer", () => {
    expect(offerBeaconName(TOKEN_A)).toBe(
      "4da0b8673e24f057592ba16399f9ee1107c557cf91b96d810dc90ba310f6a477"
    );
  });

  it("ask beacon known answer", () => {
    expect(askBeaconName(TOKEN_B)).toBe(
      "5caacc120b143ed0364e23caeccf4ed985dfec5acf61d8030c657589748aa2fc"
    );
  });

  it("pair beacon known answer", () => {
    expect(pairBeaconName(TOKEN_A, TOKEN_B)).toBe(
      "d3428227f1e3343b370bc58b5ef2889c9ec285a0fc09de67706b9691f206d4f9"
    );
  });

  it("pair beacon with ADA known answer", () => {
    expect(pairBeaconName(ADA, TOKEN_B)).toBe(
      "4122d58532d8480701be85a62faf1b2e3f03a18f59e0bcdee7cd9cc328c065b8"
    );
  });

  it("pair beacon is symmetric", () => {
    expect(pairBeaconName(TOKEN_A, TOKEN_B)).toBe(
      pairBeaconName(TOKEN_B, TOKEN_A)
    );
  });

  it("offer and ask prefixes differ for the same asset", () => {
    expect(offerBeaconName(TOKEN_A)).not.toBe(askBeaconName(TOKEN_A));
  });

  it("owner beacon is the verbatim key hash", () => {
    expect(ownerBeaconName("01".repeat(28))).toBe("01".repeat(28));
  });

  it("derives the full 5-name set", () => {
    const names = deriveBeaconNames(TOKEN_A, TOKEN_B, "01".repeat(28));
    expect(new Set(Object.values(names)).size).toBe(5);
  });
});

describe("asset id / pair id helpers", () => {
  it("round-trips API asset ids", () => {
    expect(toApiAssetId(fromApiAssetId("lovelace"))).toBe("lovelace");
    const id = `${"aa".repeat(28)}.544f4b41`;
    expect(toApiAssetId(fromApiAssetId(id))).toBe(id);
  });

  it("rejects malformed asset ids", () => {
    expect(() => fromApiAssetId("nonsense")).toThrow();
    expect(() => fromApiAssetId("aabb.00")).toThrow();
  });

  it("pair id is sorted and undirected", () => {
    expect(toPairId(TOKEN_A, TOKEN_B)).toBe(toPairId(TOKEN_B, TOKEN_A));
    expect(toPairId(ADA, TOKEN_B).startsWith("lovelace_")).toBe(false);
    // "lovelace" sorts after the hex policy id of TOKEN_B
    expect(toPairId(ADA, TOKEN_B).endsWith("_lovelace")).toBe(true);
  });
});
