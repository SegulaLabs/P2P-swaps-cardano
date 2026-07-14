import "dotenv/config";
import { z } from "zod";

/**
 * Environment parsing + safety guards.
 *  - CARDANO_NETWORK must be exactly "preprod" (mainnet is out of MVP scope).
 *  - Key-material env vars are FORBIDDEN: this service must never sign.
 */

const EnvSchema = z.object({
  CARDANO_NETWORK: z.literal("preprod"),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z
    .string()
    .default("postgres://p2pdex:change-me-locally@localhost:5432/p2pdex"),
  /** Blockfrost preprod project id. Optional: without it the API boots but
   *  provider-backed endpoints return 503 (dev without a key). */
  BLOCKFROST_PROJECT_ID_PREPROD: z.string().default(""),
  PROTOCOL_VERSION: z.coerce.number().int().positive().default(1),
  /** Optional cross-checks against the compiled blueprint — boot fails on
   *  mismatch so a stale build can't silently serve wrong scripts. */
  ORDER_VALIDATOR_HASH: z.string().default(""),
  BEACON_POLICY_ID: z.string().default(""),
  /** Optional CIP-33 reference-script UTxO for the order validator +
   *  beacon policy; when unset, scripts are attached to transactions. */
  REFERENCE_SCRIPT_TX_ID: z.string().default(""),
  REFERENCE_SCRIPT_INDEX: z.coerce.number().int().nonnegative().default(0),
  /** Deposit locked with each order, in lovelace. Slightly over-provisioned
   *  vs the ledger min-UTxO (~2.9 ADA for a 5-beacon order output); excess
   *  returns to the seller on take, to the owner on cancel. */
  ORDER_DEPOSIT_LOVELACE: z.coerce.bigint().positive().default(3_500_000n),
  /** Max orders one TakeManyOrders tx may consume (v2 atomic batches). Bounded
   *  by tx-size/ex-unit limits, not the validator — conservative default;
   *  raise only after measuring on preprod (docs/take-many-orders.md §6). */
  MAX_ORDERS_PER_TX: z.coerce.number().int().positive().default(8),
  /** v3 Smart Fill dust guard: a marginal partial leg must spend at least
   *  this many raw units of the spend asset, or the leftover stays unused
   *  (docs/partial-fills.md §6). */
  SMART_FILL_MIN_PARTIAL_SPEND: z.coerce.bigint().positive().default(1n),
  /** Arbitrage fee estimate per TakeManyOrders tx, lovelace — a display-time
   *  cost line only (the TransactionPreview shows the real fee pre-sign);
   *  docs/arbitrage.md §3. */
  ARBITRAGE_FEE_ESTIMATE_LOVELACE: z.coerce
    .bigint()
    .positive()
    .default(1_000_000n),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(2),
  /** Background safety-net sync only — the frontend's "Refresh" button
   *  (POST /indexer/reindex) is the primary way the cache gets updated, to
   *  keep provider request volume near-zero while the site sits idle 24/7. */
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(900_000),
  /** Floor between on-demand /indexer/reindex syncs (ms). */
  INDEXER_MIN_REINDEX_INTERVAL_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(20_000),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/** Env var names that must never exist in this process: the backend holds no
 *  keys, signs nothing, and custodies nothing (docs/security.md §1/§3). */
const FORBIDDEN_ENV_PATTERNS =
  /(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|SEED_WORDS|SIGNING_KEY|WALLET_SECRET|ROOT_KEY)/i;

export function assertNoKeyMaterial(env: Record<string, unknown>): void {
  const offenders = Object.keys(env).filter((k) =>
    FORBIDDEN_ENV_PATTERNS.test(k)
  );
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to boot: key-material environment variables are forbidden in this non-custodial backend: ${offenders.join(", ")}`
    );
  }
}

export function parseEnv(env: Record<string, unknown>): AppConfig {
  assertNoKeyMaterial(env);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration (note: CARDANO_NETWORK must be exactly 'preprod'; mainnet is out of scope): ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
    );
  }
  const cfg = parsed.data;
  if (
    cfg.BLOCKFROST_PROJECT_ID_PREPROD !== "" &&
    !cfg.BLOCKFROST_PROJECT_ID_PREPROD.startsWith("preprod")
  ) {
    throw new Error(
      "BLOCKFROST_PROJECT_ID_PREPROD must be a *preprod* project id (they are prefixed with 'preprod')"
    );
  }
  return cfg;
}
