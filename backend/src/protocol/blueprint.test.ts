import { describe, expect, it } from "vitest";
import { deserializeAddress } from "@meshsdk/core";
import { loadProtocolScripts } from "./blueprint.js";

/**
 * Cross-tool reproducibility: the ids below were produced independently by
 * `aiken build` (validator hash) and `aiken blueprint apply` (policy id).
 * Mesh's applyParamsToScript must derive the exact same values, or every
 * on-chain/off-chain assumption breaks. Update BOTH constants after any
 * contract change (and re-run `npm run sync-blueprint`).
 */
// v3 (partial fills, docs/partial-fills.md). Prior versions:
// v2 (TakeManyOrders): 4d0a1335…94b8 / a88c60a8…c9b0 — e2e/blueprint-v2.plutus.json.
// v1 (MVP):            89389051…46ab / 264ed623…cc0a — e2e/blueprint-v1.plutus.json.
const EXPECTED_ORDER_HASH =
  "1757ecd8fdc1c3d095906f13f17acdf8262a7c2363ac69ddeb256f8b";
const EXPECTED_POLICY_ID =
  "c14dc44ed1e2025bae03895af442f2fa9d387deb526b6518b5aa8702";

describe("protocol blueprint", () => {
  const scripts = loadProtocolScripts();

  it("order validator hash matches aiken build", () => {
    expect(scripts.orderValidatorHash).toBe(EXPECTED_ORDER_HASH);
  });

  it("beacon policy id matches aiken blueprint apply", () => {
    expect(scripts.beaconPolicyId).toBe(EXPECTED_POLICY_ID);
  });

  it("order address embeds validator payment cred + owner staking cred", () => {
    const owner = "01".repeat(28);
    const addr = scripts.orderAddressFor(owner);
    expect(addr.startsWith("addr_test1")).toBe(true); // preprod, never mainnet
    const parsed = deserializeAddress(addr);
    expect(parsed.scriptHash).toBe(EXPECTED_ORDER_HASH);
    expect(parsed.stakeCredentialHash).toBe(owner);
  });

  it("env cross-check rejects mismatched hashes", () => {
    expect(() =>
      loadProtocolScripts({
        ORDER_VALIDATOR_HASH: "00".repeat(28),
        BEACON_POLICY_ID: "",
      })
    ).toThrow(/ORDER_VALIDATOR_HASH/);
    expect(() =>
      loadProtocolScripts({
        ORDER_VALIDATOR_HASH: "",
        BEACON_POLICY_ID: "00".repeat(28),
      })
    ).toThrow(/BEACON_POLICY_ID/);
  });
});
