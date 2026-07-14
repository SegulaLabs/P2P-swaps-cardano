import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { AppConfig } from "./config.js";
import type { OrdersRepo } from "./db/orders-repo.js";
import type { ChainProvider } from "./services/chain-provider.js";
import type { TxBuilder } from "./services/tx-builder.js";
import type { OrderIndexer } from "./services/order-indexer.js";
import type { AssetMetadataService } from "./services/asset-metadata.js";
import type { ProtocolScripts } from "./protocol/blueprint.js";
import { pairsRoutes } from "./routes/pairs.js";
import { ordersRoutes } from "./routes/orders.js";
import { smartFillRoutes } from "./routes/smart-fill.js";
import { arbitrageRoutes } from "./routes/arbitrage.js";
import { protocolRoutes } from "./routes/protocol.js";
import { txRoutes } from "./routes/tx.js";
import { assetsRoutes } from "./routes/assets.js";

/**
 * App factory with injected dependencies so tests can run the full HTTP
 * surface with in-memory fakes (no DB / no provider / no network).
 * provider/txBuilder/indexer may be null (no Blockfrost key configured):
 * affected endpoints return 503 rather than pretending.
 */
export interface AppDeps {
  config: AppConfig;
  scripts: ProtocolScripts;
  repo: OrdersRepo;
  provider: ChainProvider | null;
  txBuilder: TxBuilder | null;
  indexer: OrderIndexer | null;
  assetMetadata: AssetMetadataService;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // A pair id can be two NATIVE assets ("policyId(56).nameHex(<=64)" each,
  // joined by "_") — up to ~243 chars, well over Fastify's 100-char default.
  // Without this, /pairs/:pair/orderbook 414s and the browser reports it as a
  // CORS "Failed to fetch" (the error reply predates the CORS hook).
  const app = Fastify({ logger: true, maxParamLength: 1024 });
  await app.register(cors, { origin: deps.config.CORS_ORIGIN });

  app.get("/health", async () => ({
    status: "ok",
    network: deps.config.CARDANO_NETWORK, // always "preprod" (config guard)
    custody: "none",
    provider: deps.provider?.name ?? "not-configured",
  }));

  await app.register(pairsRoutes, { deps });
  await app.register(ordersRoutes, { deps });
  await app.register(smartFillRoutes, { deps });
  await app.register(arbitrageRoutes, { deps });
  await app.register(protocolRoutes, { deps });
  await app.register(txRoutes, { deps });
  await app.register(assetsRoutes, { deps });

  // Manual reindex — the frontend's "Refresh" button. Safe (rebuilds a
  // cache from public chain data); cooldown-gated in the indexer itself so
  // repeated clicks can't replace the old continuous-polling cost with the
  // same cost on demand (docs/deployment.md §7 / provider-quota notes).
  app.post("/indexer/reindex", async (_req, reply) => {
    if (!deps.indexer)
      return reply
        .code(503)
        .send({ error: "indexer not configured (no Blockfrost key)" });
    const result = await deps.indexer.triggerSync();
    return { ok: true, ...result };
  });

  // One-time repair for rows the cache already had before lineage-backfill
  // existed (docs/partial-fills.md §4) — NOT cooldown-gated like reindex
  // since it's an intentional admin action, not something a UI button spams.
  app.post("/indexer/repair-lineage", async (_req, reply) => {
    if (!deps.indexer)
      return reply
        .code(503)
        .send({ error: "indexer not configured (no Blockfrost key)" });
    const result = await deps.indexer.repairLineage();
    return { ok: true, ...result };
  });

  return app;
}
