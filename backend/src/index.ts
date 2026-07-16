import pg from "pg";
import { parseEnv } from "./config.js";
import { buildApp } from "./app.js";
import { loadProtocolScripts } from "./protocol/blueprint.js";
import {
  MemoryOrdersRepo,
  PgOrdersRepo,
  type OrdersRepo,
} from "./db/orders-repo.js";
import { BlockfrostChainProvider } from "./services/chain-provider.js";
import { TxBuilder } from "./services/tx-builder.js";
import { OrderIndexer } from "./services/order-indexer.js";
import { AssetMetadataService } from "./services/asset-metadata.js";

/**
 * Bootstrap. Degrades honestly:
 *  - no DATABASE reachable  -> in-memory cache (ok for single-user; logged)
 *  - no Blockfrost key      -> read-only API; tx/indexer endpoints 503
 * Never holds keys, never signs (config.ts enforces this at boot).
 */

const config = parseEnv(process.env);
const scripts = loadProtocolScripts(config);

let db: pg.Pool | null = new pg.Pool({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
let repo: OrdersRepo;
try {
  await db.query("SELECT 1");
  repo = new PgOrdersRepo(db);
} catch (err) {
  console.warn(
    `NOTE: database unreachable (${String(err)}) — using the in-memory order cache. ` +
      `This is fine for a personal single-user instance: the chain is the source of truth ` +
      `and the cache re-syncs from Blockfrost on boot/Refresh. For a shared or 24/7 ` +
      `deployment run PostgreSQL (docker compose up) to avoid re-indexing on every restart.`
  );
  await db.end().catch(() => {});
  db = null;
  repo = new MemoryOrdersRepo();
}

const provider = config.BLOCKFROST_PROJECT_ID_PREPROD
  ? new BlockfrostChainProvider(config.BLOCKFROST_PROJECT_ID_PREPROD)
  : null;

const txBuilder = provider
  ? new TxBuilder(provider, scripts, {
      depositLovelace: config.ORDER_DEPOSIT_LOVELACE,
      referenceScript: config.REFERENCE_SCRIPT_TX_ID
        ? {
            txHash: config.REFERENCE_SCRIPT_TX_ID,
            index: config.REFERENCE_SCRIPT_INDEX,
          }
        : undefined,
      maxOrdersPerTx: config.MAX_ORDERS_PER_TX,
    })
  : null;

const indexer = provider
  ? new OrderIndexer(provider, repo, {
      beaconPolicyId: scripts.beaconPolicyId,
      orderValidatorHash: scripts.orderValidatorHash,
      confirmations: config.INDEXER_CONFIRMATIONS,
      pollMs: config.INDEXER_POLL_MS,
      minReindexIntervalMs: config.INDEXER_MIN_REINDEX_INTERVAL_MS,
      log: (m) => console.log(m),
    })
  : null;

const app = await buildApp({
  config,
  scripts,
  repo,
  provider,
  txBuilder,
  indexer,
  assetMetadata: new AssetMetadataService(db, provider),
});

if (!provider) {
  app.log.warn(
    "BLOCKFROST_PROJECT_ID_PREPROD not set — tx building and indexing disabled (503)"
  );
}

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(
    `P2P beacon DEX backend (preprod) on :${config.PORT} — validator ${scripts.orderValidatorHash.slice(0, 8)}…, policy ${scripts.beaconPolicyId.slice(0, 8)}…`
  );
  indexer?.start();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
