# Cardano P2P Beacon DEX (preprod MVP)

A peer-to-peer, order-book style trading DApp on Cardano, built on the
**distributed-DApp / beacon-token** pattern (CIP-0089, fallen-icarus style).

> **Status: protocol v2 (atomic TakeManyOrders) implemented, preprod only,
> NOT audited.** All local validation passes (85 Aiken tests, 85 backend
> tests, 33 frontend tests, full typecheck + builds). Live preprod smoke
> tests passed for both v1 (create/take/cancel — open-questions #25) and v2
> (two orders taken atomically in one tx — docs/take-many-orders.md §10).

## What this is / is not

| It is | It is not |
|---|---|
| A P2P order book: every order is its own UTxO | An AMM / liquidity-pool DEX |
| Non-custodial: funds sit in order UTxOs governed by audited-scope validators | A platform that ever holds user funds |
| Beacon tokens make orders discoverable on-chain | An off-chain order book |
| Browser wallet (CIP-30) signs every transaction | A backend that ever sees a private key |
| Full-fill fixed spot orders (create / cancel / take) | Partial fills, market-maker orders, UpdateOrder |
| **Cardano preprod only** | Mainnet (blocked by boot guards, badges, and policy) |

## How it works

A user creates an order by locking the offered asset + a ~3.5 tADA deposit +
five **beacon tokens** in a UTxO at the order validator address (validator
payment credential + the owner's staking credential — CIP-0089 personal
addresses). Since spending validators don't run at creation, the **beacon
minting policy** enforces creation correctness: beacons only mint into
well-formed order outputs. Discovery = querying the chain for beacons. Taking
pays the seller exactly the asked amount plus the returned deposit in one
exact output; cancelling needs the owner's staking-key signature; **every
spend must leave zero beacons in the tx outputs** (forcing the burn and
preventing leakage). Protocol v2 (**TakeManyOrders**) lets one transaction
take many orders **atomically**: each order's payment output carries an
inline `PaymentTag` naming the consumed order, so the order→payment mapping
is 1:1 and double satisfaction stays closed
([docs/take-many-orders.md](docs/take-many-orders.md)). Full spec:
[docs/protocol-spec.md](docs/protocol-spec.md) +
[docs/mvp-contract-decisions.md](docs/mvp-contract-decisions.md).

Script identities (current build, aiken↔Mesh cross-checked):
`order validator 4d0a1335…94b8`, `beacon policy a88c60a8…c9b0` (protocol v2 — atomic TakeManyOrders).

## Repository layout

```
contracts/   Aiken: order validator + beacon policy (rules in lib/, tested)
backend/     Fastify TS: Blockfrost provider, beacon indexer, Mesh unsigned-tx
             builder, PostgreSQL cache (in-memory fallback for dev)
frontend/    Next.js + Mesh React: wallet connect, order book, create/take/
             cancel flows with mandatory TransactionPreview
infra/       docker-compose: PostgreSQL (+ optional app profile); Kupo/Ogmios
             placeholders for the self-hosted future
docs/        protocol spec, decisions, eUTxO notes, beacons, security,
             deployment, open questions
```

## Run it locally

```bash
npm install                                    # root: workspaces + aiken + tooling
cp .env.example .env
docker compose -f infra/docker-compose.yml --env-file .env up -d   # postgres

cp backend/.env.example backend/.env           # ← add BLOCKFROST_PROJECT_ID_PREPROD
cp frontend/.env.example frontend/.env.local

npm run dev                                    # backend :3001 + frontend :3000
```

**Blockfrost (required for trading):** create a **preprod** project at
https://blockfrost.io and put its id (starts with `preprod`) in
`backend/.env`. Without it the app runs read-only (tx endpoints return 503).
Fund wallets at https://docs.cardano.org/cardano-testnets/tools/faucet.

## Validate

```bash
npm run contracts:check   # 85 Aiken tests
npm test                  # contracts + backend (85) + frontend (33)
npm run typecheck
npm run build             # backend tsc + frontend next build
```

## How signing works (and why this is non-custodial)

1. The frontend sends your wallet's UTxOs + change address + a collateral
   UTxO to the backend, which builds and balances an **unsigned** transaction
   (coin selection uses only *your* UTxOs — the backend has none).
2. You see a `TransactionPreview` with un-hidable warnings; nothing is signed
   until you explicitly confirm.
3. Your CIP-30 wallet signs and submits. The backend never sees a key — it
   refuses to boot if key-material env vars exist at all.
4. Settlement rules (exact payment, deposit return, beacon burn, owner-only
   cancel) are enforced by the **on-chain validators**, not by the backend:
   a malicious backend cannot steal from a user who reviews what they sign.

## Security warnings

- **Experimental MVP. Not audited. Preprod only — never use mainnet funds.**
- The transaction preview is backend-provided; independent client-side CBOR
  decoding is not implemented yet (docs/open-questions.md #27). Read your
  wallet's own display before signing.
- The chain is the source of truth; the order book is a cache. Two takers can
  race for one order — the loser's tx fails harmlessly.
- Mainnet is out of scope until the gate in [docs/security.md](docs/security.md)
  §5 (tests ✅, audit ❌, adversarial preprod soak ❌) is fully passed.

## Docs

[protocol-spec](docs/protocol-spec.md) ·
[mvp-contract-decisions](docs/mvp-contract-decisions.md) ·
[eutxo](docs/eutxo.md) · [beacons](docs/beacons.md) ·
[security](docs/security.md) · [deployment](docs/deployment.md) ·
[smart-fill](docs/smart-fill.md) · [take-many-orders](docs/take-many-orders.md) ·
[partial-fills](docs/partial-fills.md) · [arbitrage](docs/arbitrage.md) ·
[open-questions](docs/open-questions.md)
