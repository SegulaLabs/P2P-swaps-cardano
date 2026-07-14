import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";

/**
 * GET /assets/:assetId — display metadata (ticker/name/decimals) for the UI.
 * assetId = "lovelace" | "policyHex.nameHex". Cosmetic only: decimals and
 * names come from the token registry / on-chain metadata via Blockfrost with
 * a printable-ASCII fallback, and are NEVER used for on-chain amount math.
 */
export async function assetsRoutes(
  app: FastifyInstance,
  { deps }: { deps: AppDeps }
) {
  app.get<{ Params: { assetId: string } }>(
    "/assets/:assetId",
    async (req, reply) => {
      const id = req.params.assetId.toLowerCase();
      if (!/^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/.test(id))
        return reply.code(400).send({ error: "invalid asset id" });
      return deps.assetMetadata.getAssetInfo(id);
    }
  );
}
