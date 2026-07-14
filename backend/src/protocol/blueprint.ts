import {
  applyParamsToScript,
  resolveScriptHash,
  serializePlutusScript,
} from "@meshsdk/core";
import { createRequire } from "node:module";
import type { AppConfig } from "../config.js";

/**
 * Loads the compiled Aiken blueprint (CIP-57) and derives:
 *  - the order validator (unparameterized) script CBOR + hash
 *  - the beacon policy (parameterized by the order validator hash) + policy id
 *  - per-owner order addresses (validator payment credential + owner staking
 *    credential — the CIP-0089 personal-address pattern)
 *
 * Reproducibility is verified: Mesh's applyParamsToScript produces the SAME
 * policy id as `aiken blueprint apply` (asserted in blueprint.test.ts).
 * Regenerate src/protocol/plutus.json with `npm run sync-blueprint` after any
 * contract change.
 */

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const blueprint = require("./plutus.json") as {
  validators: { title: string; compiledCode: string; hash: string }[];
};

const PREPROD_NETWORK_ID = 0;

export interface ProtocolScripts {
  orderValidatorCbor: string;
  orderValidatorHash: string;
  beaconPolicyCbor: string;
  beaconPolicyId: string;
  /** Order address for a given owner staking key hash (bech32, preprod). */
  orderAddressFor(ownerStakeKeyHash: string): string;
}

export function loadProtocolScripts(cfg?: Pick<
  AppConfig,
  "ORDER_VALIDATOR_HASH" | "BEACON_POLICY_ID"
>): ProtocolScripts {
  const orderValidator = blueprint.validators.find(
    (v) => v.title === "order.order.spend"
  );
  const beaconPolicy = blueprint.validators.find(
    (v) => v.title === "beacon.beacon.mint"
  );
  if (!orderValidator || !beaconPolicy) {
    throw new Error(
      "blueprint: missing order.order.spend / beacon.beacon.mint — run `npm run sync-blueprint` after `aiken build`"
    );
  }

  // The order validator takes no parameters; applying an empty list yields
  // the final (double-CBOR-wrapped) script.
  const orderValidatorCbor = applyParamsToScript(
    orderValidator.compiledCode,
    []
  );
  const orderValidatorHash = resolveScriptHash(orderValidatorCbor, "V3");
  if (orderValidatorHash !== orderValidator.hash) {
    throw new Error(
      `blueprint: resolved order validator hash ${orderValidatorHash} != blueprint hash ${orderValidator.hash}`
    );
  }

  const beaconPolicyCbor = applyParamsToScript(
    beaconPolicy.compiledCode,
    [{ bytes: orderValidatorHash }],
    "JSON"
  );
  const beaconPolicyId = resolveScriptHash(beaconPolicyCbor, "V3");

  // Optional env cross-checks: a stale build must not silently serve
  // different scripts than the operator expects.
  if (cfg?.ORDER_VALIDATOR_HASH && cfg.ORDER_VALIDATOR_HASH !== orderValidatorHash) {
    throw new Error(
      `ORDER_VALIDATOR_HASH env (${cfg.ORDER_VALIDATOR_HASH}) != blueprint (${orderValidatorHash})`
    );
  }
  if (cfg?.BEACON_POLICY_ID && cfg.BEACON_POLICY_ID !== beaconPolicyId) {
    throw new Error(
      `BEACON_POLICY_ID env (${cfg.BEACON_POLICY_ID}) != derived (${beaconPolicyId})`
    );
  }

  return {
    orderValidatorCbor,
    orderValidatorHash,
    beaconPolicyCbor,
    beaconPolicyId,
    orderAddressFor(ownerStakeKeyHash: string): string {
      return serializePlutusScript(
        { code: orderValidatorCbor, version: "V3" },
        ownerStakeKeyHash,
        PREPROD_NETWORK_ID,
        false
      ).address;
    },
  };
}
