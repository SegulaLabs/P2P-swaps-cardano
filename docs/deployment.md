# Deployment Guide — **preprod only**

> **Mainnet deployment is out of scope and must not be attempted.** This guide
> covers Cardano **preprod** exclusively. See [security.md](security.md) §5 for
> the gate that must pass before mainnet is even discussed.

## 0. Current status

**Protocol v3 (partial fills) is LIVE-VERIFIED on preprod.** Validators pass
the full Aiken suite; CreateOrder → discovery → TakeOrder / TakeOrderPartial
→ CancelOrder all ran successfully against real preprod
(`e2e/smoke.ts`, `e2e/smoke-take-many.ts`, `e2e/smoke-take-partial.ts`,
`e2e/smoke-take-mixed.ts` — open-questions #25, [take-many-orders.md](take-many-orders.md),
[partial-fills.md](partial-fills.md)). Every on-chain assertion passed (exact
beacon set, exact deposit, exact payment/continuation output, beacon
burn/reassert, stake-key authorization, correct balance deltas). Live
`GET /protocol/config` confirms the current epoch:

```json
{"network":"preprod","protocolVersion":3,
 "orderValidatorHash":"1757ecd8fdc1c3d095906f13f17acdf8262a7c2363ac69ddeb256f8b",
 "beaconPolicyId":"c14dc44ed1e2025bae03895af442f2fa9d387deb526b6518b5aa8702",
 "depositLovelace":"3500000","maxOrdersPerTx":8,"partialFillsSupported":true}
```

Prior epochs (now stranded — orders under old hashes are invisible to the
current indexer, but still cancellable by their owners since the old
validator still exists on-chain): v1 order validator hash `89389051…`; v2
order validator hash `4d0a13355316e80d8addbc93c7bf2fba1a4a6563e6097e87c11794b8`,
beacon policy `a88c60a8e8be899466eff52542ee57fd728540be1ed59d4e3ca2c9b0`.

The order book is currently seeded with live test data across **11 markets**
(TESTA/ADA plus 5 more token/ADA pairs and 5 cross pairs) via the
market-data scripts in [../e2e/README.md](../e2e/README.md#market-data-seeding-scripts)
— useful starting point for manual/UI testing rather than an empty book.

**Not yet done:** verifying stake-key `required_signers` signing with a real
browser wallet rather than headless Mesh (open-questions #29) and
reference-script publication (§3; transactions attach scripts until then,
which works but costs more per tx).

To reproduce the live verification: see [../e2e/README.md](../e2e/README.md).

## 1. Prerequisites

- **Aiken** toolchain — `aikup` (https://aiken-lang.org), or on aarch64-linux
  dev containers (no aikup binary) the npm distribution:
  `npm i -D @aiken-lang/aiken`. The scaffold is verified against
  **aiken v1.1.23 + stdlib v2.2.0** (pinned in `contracts/aiken.toml`).
- **Node.js ≥ 20** and npm (workspaces are used).
- **Docker** for PostgreSQL (`infra/docker-compose.yml`).
- **Blockfrost project for PREPROD** (https://blockfrost.io) — a preprod
  project id, kept in `backend/.env`, never committed. (Maestro/Koios are
  alternatives behind the same `ChainProvider` interface.)
- **A preprod browser wallet** (e.g. Eternl/Lace set to the preprod network)
  funded from the official faucet:
  https://docs.cardano.org/cardano-testnets/tools/faucet
- A separate, throwaway **deployment wallet** for publishing reference
  scripts (also faucet-funded). Never reuse mainnet keys anywhere.

## 2. Build the contracts

```bash
npm run contracts:check    # aiken check — 77 tests must pass
npm run contracts:build    # aiken build + copies plutus.json into the backend
```

The beacon policy is parameterized by the order validator hash; the backend
applies the parameter at boot with Mesh and **cross-checks** the result
against `aiken blueprint apply` semantics (blueprint.test.ts pins both ids).
Optionally set `ORDER_VALIDATOR_HASH` / `BEACON_POLICY_ID` in `backend/.env`
— boot fails on mismatch, so a stale blueprint can't serve silently. After
ANY contract change, re-run `npm run contracts:build` and update the pinned
ids in `backend/src/protocol/blueprint.test.ts` and `.env.example`.

## 3. Publish reference scripts (CIP-33) ⚠

Take/cancel/update transactions should reference the scripts instead of
attaching them. Plan:

1. From the deployment wallet, build a tx with outputs carrying the order
   validator and beacon policy as reference scripts.
2. Park those outputs at an address they can't accidentally vanish from —
   candidate: an always-fail script address (permanent, nobody can spend) vs.
   deployer-held address (cheaper to migrate, but deployer can delete). ⚠
   Decision + who pays the (nontrivial) min-ADA for large script outputs.
3. Record (tx_hash, output_index) in the `reference_scripts` table; expose via
   `GET /protocol/reference-scripts`.

## 4. Configure & run the stack

```bash
# from repo root
npm install                                # workspaces + aiken (via npm)
cp .env.example .env                       # postgres credentials
docker compose -f infra/docker-compose.yml --env-file .env up -d

cp backend/.env.example backend/.env       # add BLOCKFROST_PROJECT_ID_PREPROD
cp frontend/.env.example frontend/.env.local

npm run dev                                # backend :3001 + frontend :3000
```

Guards to know about:
- Backend refuses to boot unless `CARDANO_NETWORK=preprod`, and refuses any
  key-material env var (PRIVATE_KEY/MNEMONIC/…) — it must never sign.
- Without `BLOCKFROST_PROJECT_ID_PREPROD`, the API still boots read-only:
  `/tx/*` and the indexer answer 503 instead of pretending.
- Without a reachable PostgreSQL, the backend falls back to an in-memory
  cache with a loud warning (dev only).

## 5. Smoke test

**Backend/contract flow: done, automated, and passing** — `e2e/smoke.ts`
(open-questions #25) runs steps 1–5 below end-to-end against real preprod
via the actual `TxBuilder`/`OrderIndexer`/`BlockfrostChainProvider` code
(not a UI). Run it with `npx tsx e2e/smoke.ts` after
`npx tsx e2e/generate-wallets.ts` and funding both printed addresses from
the faucet; see [../e2e/README.md](../e2e/README.md).

**Still required before announcing**: the same flow **through the actual
browser UI** with a real CIP-30 wallet extension (Eternl/Lace), which
exercises code paths the headless harness cannot (real `signTx` behavior,
in particular the CancelOrder stake-key witness — open-questions #29):

1. Connect a preprod wallet in the browser; NetworkBadge must show
   **preprod**.
2. Create a tiny order via the swap card on the home page; verify the order UTxO on a preprod
   explorer — beacons + inline datum present (already proven by e2e/smoke.ts
   at the backend level; this step confirms the UI/wallet round-trip).
3. See the order appear in `/trade/[pair]` via the indexer.
4. Take it from a second wallet; verify seller payment, beacon burn.
5. Create + cancel from `/orders`; **specifically confirm the wallet
   produces a stake-key witness** for the signature required by
   CancelOrder (this is the one step the headless harness had to work
   around — see open-questions #29).

UpdateOrder has no UI and is not part of this test — postponed post-MVP
(mvp-contract-decisions.md §7).

## 6. Environments

| Env | Chain | Purpose |
|---|---|---|
| local | preprod via Blockfrost | development |
| staging (later) | preprod, self-hosted Kupo/Ogmios | provider-migration testing |
| mainnet | — | **forbidden for MVP** |

**Frontend delivery caveat (open-questions #37).** The UI is served as a
production build (`next build` + `next start`); this repo currently rebuilds
in place rather than running `next dev`. Each rebuild renames the
content-hashed JS chunks and **deletes the old ones**, so any browser tab
opened against the previous build white-screens on its next chunk fetch (a
hard reload fixes it). The error boundaries in `app/error.tsx` /
`app/global-error.tsx` now surface this as a "reload" prompt instead of a
blank page. Before a real production rollout, adopt an atomic/versioned
static-asset deploy (retain prior chunk sets, or a CDN with old-asset
retention) so in-flight sessions don't break mid-navigation.

## 7. Upgrade path away from Blockfrost

`ChainProvider` is the only module that talks to the chain. Later:
implement `KupoOgmiosProvider` against the same interface, add kupo/ogmios
services to `infra/docker-compose.yml` (placeholder dirs exist), run both
providers in staging, diff results, then switch. No business-logic changes.
