import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { ORDER_BEACON_NAME_HEX } from "../protocol/beacons.js";
import type { ProtocolConfig, ReferenceScriptInfo } from "../types.js";
import { APP_VERSION } from "../version.js";

/**
 * GET /protocol/config             — validator hash, beacon policy, version
 * GET /protocol/reference-scripts  — CIP-33 locations (empty until deployed)
 */
export async function protocolRoutes(
  app: FastifyInstance,
  { deps }: { deps: AppDeps }
) {
  app.get("/protocol/config", async (): Promise<ProtocolConfig> => {
    return {
      network: "preprod",
      appVersion: APP_VERSION,
      protocolVersion: deps.config.PROTOCOL_VERSION,
      orderValidatorHash: deps.scripts.orderValidatorHash,
      beaconPolicyId: deps.scripts.beaconPolicyId,
      orderBeaconNameHex: ORDER_BEACON_NAME_HEX,
      depositLovelace: deps.config.ORDER_DEPOSIT_LOVELACE.toString(),
      maxOrdersPerTx: deps.config.MAX_ORDERS_PER_TX,
      partialFillsSupported: true,
      derivationScheme:
        "sha2_256; pair=0x00+len-prefixed sorted asset ids (undirected), offer=0x01+id, ask=0x02+id, owner=stake key hash verbatim, order='order' (mvp-contract-decisions.md §3)",
    };
  });

  app.get("/protocol/reference-scripts", async () => {
    const refs: ReferenceScriptInfo[] = [];
    if (deps.config.REFERENCE_SCRIPT_TX_ID) {
      refs.push({
        scriptHash: deps.scripts.orderValidatorHash,
        purpose: "order-validator",
        utxoRef: `${deps.config.REFERENCE_SCRIPT_TX_ID}#${deps.config.REFERENCE_SCRIPT_INDEX}`,
      });
    }
    return { referenceScripts: refs };
  });
}
