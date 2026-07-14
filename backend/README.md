# Backend (Fastify + TypeScript)

Non-custodial API for the P2P beacon DEX. Three jobs:

1. **Serve the order cache** (`/pairs`, `/orders/*`) fed by the beacon indexer.
2. **Build unsigned transactions** (`/tx/*`) for the browser wallet to sign.
3. **Expose protocol config** (`/protocol/*`): validator address, beacon
   policy, reference-script locations.

**It never holds keys, never signs, never custodies funds.** See
[docs/security.md](../docs/security.md) §1/§3 — any PR that adds key material
here must be rejected.

Framework choice: **Fastify** (over NestJS) — small API surface, no need for
NestJS's DI/module machinery at this size.

## Layout

```
src/
  index.ts                 bootstrap (guards, DI wiring, indexer start)
  app.ts                   app factory (dependency-injected, testable)
  config.ts                env validation; preprod-only + no-key-material guards
  types.ts                 API/domain types (mirrors protocol-spec.md §2)
  routes/
    pairs.ts               GET /pairs, GET /pairs/:pair/orderbook
    orders.ts              GET /orders/:orderId, GET /orders/by-owner/:cred
    protocol.ts            GET /protocol/config, GET /protocol/reference-scripts
    tx.ts                  POST /tx/{create,cancel,take,update}-order  (501 stubs)
  services/
    chain-provider.ts      ChainProvider interface + Blockfrost stub (swap later)
    order-indexer.ts       beacon → PostgreSQL sync (strategy documented, TODO)
    tx-builder.ts          unsigned-tx construction (blocked on SDK choice)
    asset-metadata.ts      display metadata (registry/CIP-68), cosmetic only
    protocol-config.ts     active version + reference scripts from DB
  protocol/
    plutus.json            synced Aiken blueprint (npm run sync-blueprint)
    blueprint.ts           script CBOR/hashes/addresses (+ env cross-check)
    beacons.ts             beacon-name derivation (byte-mirror of Aiken)
    datum.ts               OrderDatum encode/decode + redeemer constants
  db/
    orders-repo.ts         Pg + in-memory order cache repositories
    schema.sql             orders/pairs/assets/protocol_versions/
                           reference_scripts/tx_history (+ indexer cursor)
```

## Status

**Implemented** — 59 vitest tests, typecheck and build green. Highlights:
- `protocol/` derives script identities from the synced blueprint and
  cross-checks Mesh vs `aiken blueprint apply` (pinned in blueprint.test.ts);
  beacon derivation + datum codec mirror Aiken byte-for-byte (shared
  known-answer vectors).
- `/tx/create|cancel|take-order` build real unsigned transactions with Mesh
  (Blockfrost fetcher/evaluator); `/tx/update-order` returns **501 postponed**.
- Boot guards: preprod-only, key-material env vars forbidden, in-memory cache
  fallback when PostgreSQL is unreachable, 503s (never fakes) without a
  Blockfrost key.
- Not yet verified live on preprod (no key in this environment) —
  docs/open-questions.md #25.

## Run

```bash
cp .env.example .env      # set BLOCKFROST_PROJECT_ID_PREPROD
npm install
npm run dev               # :3001 — try GET /health
```

Postgres comes from `infra/docker-compose.yml`; `db/schema.sql` is applied on
the container's first boot.
