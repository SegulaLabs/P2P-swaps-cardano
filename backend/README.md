# Backend (Fastify + TypeScript)

Non-custodial API for the P2P beacon DEX. Four jobs:

1. **Serve the order cache** (`/pairs`, `/orders/*`, `/assets/*`) fed by the
   beacon indexer.
2. **Build unsigned transactions** (`/tx/*`) for the browser wallet to sign.
3. **Plan multi-order fills**: `/smart-fill` routes one intent across several
   orders; `/arbitrage` finds profitable cycles over the open book. Both are
   pure off-chain planning — they settle through the same `/tx/take-many-orders`.
4. **Expose protocol config** (`/protocol/*`): validator address, beacon
   policy, reference-script locations.

**It never holds keys, never signs, never custodies funds.** See
[docs/security.md](../docs/security.md) §1/§3 — any PR that adds key material
here must be rejected.

Framework choice: **Fastify** (over NestJS) — small API surface, no need for
NestJS's DI/module machinery at this size.

## Endpoints

```
GET  /health
GET  /pairs                          GET  /pairs/:pair/orderbook
GET  /orders/:orderId                GET  /orders/by-owner/:stakeCredential
GET  /assets/:assetId                GET  /protocol/config
GET  /smart-fill                     GET  /protocol/reference-scripts
GET  /arbitrage
POST /tx/create-order                POST /tx/cancel-order
POST /tx/take-order                  (optional partial amount → v3 partial fill)
POST /tx/take-many-orders            (v2: ONE atomic tx, mixed full + partial legs)
POST /tx/update-order                → 501 postponed (mvp-contract-decisions.md §7)
GET  /tx/:txHash/status
POST /indexer/reindex                POST /indexer/repair-lineage
```

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
    assets.ts              GET /assets/:assetId (display metadata)
    protocol.ts            GET /protocol/config, GET /protocol/reference-scripts
    smart-fill.ts          GET /smart-fill  (route planning over full orders)
    arbitrage.ts           GET /arbitrage   (profitable cycles over the book)
    tx.ts                  POST /tx/*, GET /tx/:txHash/status, indexer hooks
  services/
    chain-provider.ts      ChainProvider interface + Blockfrost impl (swap later)
    order-indexer.ts       beacon → PostgreSQL sync; classifies spends by reading
                           the real spend redeemer (cancel / take / partial) and
                           tracks partial-fill continuation lineage
    tx-builder.ts          unsigned-tx construction (Mesh); batched + partial legs
    smart-fill.ts          route planner (docs/smart-fill.md)
    arbitrage.ts           cycle detection (docs/arbitrage.md)
    asset-metadata.ts      display metadata (registry/CIP-68), cosmetic only
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

**Implemented — protocol v3.** 120 vitest tests, typecheck and build green.
Highlights:
- `protocol/` derives script identities from the synced blueprint and
  cross-checks Mesh vs `aiken blueprint apply` (pinned in blueprint.test.ts);
  beacon derivation + datum codec mirror Aiken byte-for-byte (shared
  known-answer vectors).
- `/tx/create|cancel|take-order` and `/tx/take-many-orders` build real unsigned
  transactions with Mesh (Blockfrost fetcher/evaluator), including v3 partial
  fills and mixed partial/full batches; `/tx/update-order` returns **501
  postponed**.
- Boot guards: preprod-only, key-material env vars forbidden, in-memory cache
  fallback when PostgreSQL is unreachable, 503s (never fakes) without a
  Blockfrost key.
- **Verified live on preprod** — the e2e harness runs this exact code
  (`TxBuilder`, `OrderIndexer`, `BlockfrostChainProvider`) against the real
  chain for v1/v2/v3 flows (see [e2e/README.md](../e2e/README.md)).

**Audit note (F-01, High):** the `/tx/*` summary this API returns is what the
UI previews, and the frontend does not yet independently decode the CBOR — so
a compromised backend could preview one thing and build another. The on-chain
validators still protect the *seller*, but not the signer. See
[Audit/security-audit-fable5.md](../Audit/security-audit-fable5.md); this is
the gate on anything beyond preprod.

## Run

```bash
cp .env.example .env      # set BLOCKFROST_PROJECT_ID_PREPROD
npm install
npm run dev               # :3001 — try GET /health
```

Postgres comes from `infra/docker-compose.yml`; `db/schema.sql` is applied on
the container's first boot.
