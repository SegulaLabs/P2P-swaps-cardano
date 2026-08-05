import pg from "pg";
import { parseEnv } from "./config.js";
import { buildApp, type AppDeps } from "./app.js";
import { loadProtocolScripts } from "./protocol/blueprint.js";
import {
  MemoryOrdersRepo,
  PgOrdersRepo,
  type OrdersRepo,
} from "./db/orders-repo.js";
import { createChainProvider, type ChainProvider } from "./services/chain-provider.js";
import { TxBuilder } from "./services/tx-builder.js";
import { OrderIndexer } from "./services/order-indexer.js";
import { AssetMetadataService } from "./services/asset-metadata.js";
import { SettingsStore, type ChainProviderSettings } from "./services/settings-store.js";

/**
 * Bootstrap. Degrades honestly:
 *  - no DATABASE reachable        -> in-memory cache (ok for single-user; logged)
 *  - no provider key configured   -> read-only API; tx/indexer endpoints 503
 * Never holds signing keys, never signs (config.ts enforces this at boot).
 * The provider (Blockfrost/Koios + its key) is hot-swappable at runtime via
 * the Settings page — see applySettings() below.
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

const settings = await SettingsStore.load(
  process.env.SETTINGS_FILE || "./data/settings.json",
  {
    provider: config.CHAIN_PROVIDER,
    blockfrostProjectId: config.BLOCKFROST_PROJECT_ID_PREPROD,
    koiosApiToken: config.KOIOS_API_TOKEN,
  }
);

/** Builds provider + everything downstream of it from the given settings.
 *  Does NOT touch the running indexer — buildRuntime()/applySettings() own
 *  starting/stopping it, so a hot-swap can stop the old one first. */
function buildRuntime(s: ChainProviderSettings): {
  provider: ChainProvider | null;
  txBuilder: TxBuilder | null;
  indexer: OrderIndexer | null;
} {
  const key =
    s.provider === "koios" ? s.koiosApiToken : s.blockfrostProjectId;
  const provider =
    s.provider === "koios" || key ? createChainProvider(s.provider, key) : null;

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

  return { provider, txBuilder, indexer };
}

const initial = buildRuntime(settings.get());

const deps: AppDeps = {
  config,
  scripts,
  repo,
  provider: initial.provider,
  txBuilder: initial.txBuilder,
  indexer: initial.indexer,
  assetMetadata: new AssetMetadataService(db, initial.provider),
  settings,
  async applySettings(patch) {
    const next = { ...settings.get(), ...patch };
    if (next.provider === "blockfrost" && !next.blockfrostProjectId) {
      return {
        ok: false,
        error: "a Blockfrost preprod project id is required (or switch to Koios)",
      };
    }
    const built = buildRuntime(next);
    if (built.provider) {
      try {
        await built.provider.getTip();
      } catch (err) {
        return { ok: false, error: `provider check failed: ${String(err)}` };
      }
    }
    await settings.update(patch);
    deps.indexer?.stop();
    deps.provider = built.provider;
    deps.txBuilder = built.txBuilder;
    deps.indexer = built.indexer;
    deps.assetMetadata = new AssetMetadataService(db, built.provider);
    deps.indexer?.start();
    return { ok: true };
  },
};

const app = await buildApp(deps);

if (!deps.provider) {
  app.log.warn(
    `no ${settings.get().provider} key configured — tx building and indexing disabled (503) until set via Settings or env`
  );
}

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(
    `P2P beacon DEX backend (preprod) on :${config.PORT} — validator ${scripts.orderValidatorHash.slice(0, 8)}…, policy ${scripts.beaconPolicyId.slice(0, 8)}…`
  );
  deps.indexer?.start();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
