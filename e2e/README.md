# Live preprod e2e (open-questions #25)

Throwaway **preprod-only** test wallets + the live smoke test. This harness
plays the *browser wallet's* role (holds keys, signs) against the real
backend code (`TxBuilder`, `OrderIndexer`, `BlockfrostChainProvider`) and the
real preprod chain.

**Key-handling rules (do not relax):**
- `e2e/wallets/` is **gitignored** and holds throwaway preprod mnemonics only.
  Never put value on these wallets beyond faucet tADA. Never reuse anywhere.
- The backend never reads this folder — its no-key-material boot guard stands.
  Only this test harness (acting as the user) loads the keys.

## Usage

```bash
npx tsx e2e/generate-wallets.ts   # once: creates wallets, prints addresses
# fund BOTH addresses at https://docs.cardano.org/cardano-testnets/tools/faucet
npx tsx e2e/smoke.ts              # runs the full create -> take -> cancel test
npx tsx e2e/smoke-take-many.ts    # v2: two orders taken in ONE atomic tx
npx tsx e2e/smoke-take-partial.ts # v3: partial fill -> continuation -> final fill
npx tsx e2e/smoke-take-mixed.ts   # v3: twin partials + full fill in one atomic tx
```

The smoke test (docs/deployment.md §5):
1. Wallet A mints 1000 `TESTA` (plain native-script mint — user action, not protocol).
2. A creates an order: offer 100 TESTA, ask 5 tADA (+ deposit locked).
3. On-chain checks: order UTxO at the owner-staked validator address with the
   exact 5-beacon set + inline datum; indexer picks it up.
4. Wallet B takes it: A's payment address must receive exactly 5 tADA + the
   deposit; beacons burn; B receives 100 TESTA.
5. A creates a second order and cancels it (stake-key signature); value
   returns, beacons burn.
6. Indexer classifies both spends (taken / cancelled).

Each step waits for on-chain confirmations, so a full run takes several
minutes. Exit code 0 + `ALL CHECKS PASSED` is the pass condition. The script
is idempotent-safe to rerun against the same funded wallets (balance/asset
assertions use deltas, not absolute amounts).

Both wallets need a spare pure-ADA UTxO for collateral (every tx here touches
a Plutus script); the harness self-heals this with a one-off ADA
self-transfer if none exists (`ensureCollateral`), same as a real CIP-30
wallet does behind the scenes.

## Status: PASSED on preprod (2026-07-07)

A full run confirmed every check, including all payment/beacon/deposit
exactness rules and stake-key authorization. **Four real bugs were found and
fixed** in the process — none reachable by unit tests, since each depends on
actual Blockfrost/Mesh/ledger behavior. Full writeup:
[docs/open-questions.md](../docs/open-questions.md) #25 (a–d) and
[docs/security.md](../docs/security.md) §0.1. Summary:

1. A collateral UTxO could be silently reused as a spending input
   (`NoCollateralInputs` on submission) — fixed in `tx-builder.ts`.
2. `getUtxo()` never actually checked spent status — fixed via Blockfrost's
   `consumed_by_tx` field in `chain-provider.ts`.
3. Indexer spend classification went through two wrong designs (asset-history
   search misses burn-only txs; payment-shape heuristics false-positive on
   self-cancels) before landing on reading the real redeemer constructor —
   `order-indexer.ts` / `getSpendRedeemerConstructor`.
4. CancelOrder's stake-key authorization is confirmed **correct on-chain**,
   but Mesh's headless `MeshWallet.signTx()` can't produce that witness (see
   `signWithStakeKeyAndSubmit` in `smoke.ts` for the workaround and root
   cause). **Real CIP-30 wallet behavior for this still needs checking** —
   open-questions #29.

## Market-data seeding scripts

These are not tests — they populate live preprod order books with realistic
maker/taker traffic so the UI and manual testing (including external wallets
like Eternl) have real data to interact with. Each is **idempotent/resumable**:
progress is written to a same-named `*.out.json` after every confirmed step,
and rerunning skips anything already recorded (checked via `txHash`
presence, not just the derived `orderId`, since a crash can happen between
submission and order-id resolution).

All four scripts use the same **20 `mm-0`…`mm-19` wallets**
(`e2e/wallets/mm/mm-*.json`) as the market-maker pool, funded from
`wallet-a-seller` / `wallet-b-taker`. They target whichever protocol version
was live when written — check each script's `allowPartialFill` usage and the
`docs/deployment.md` script-hash epoch before rerunning against a
newly-redeployed contract, since old orders under a stale beacon policy
become invisible to the indexer (not an error, just orphaned value the owner
can still cancel).

- **`create-market-maker-orders.ts`** — first pass: 20 wallets, 10 sell +
  10 buy TESTA/ADA orders, ±10% around a 65,000 lovelace/TESTA mid price, no
  self-crossing.
- **`create-mm-v2-variety-orders.ts`** — v2 (`TakeManyOrders`) re-seed: same
  20 wallets, 2 sell + 2 buy each (80 orders), price ladder 1–100k
  lovelace/TESTA.
- **`create-mm-v3-partial-orders.ts`** — v3 re-seed: same wallets/shape, but
  every order has `allowPartialFill: true` and prices are whole ADA
  (1–100 ADA/TESTA) instead of fractional lovelace, so partial-fill testing
  deals in round numbers.
- **`create-multi-market-orders.ts`** — mints 5 new tokens (`TESTB`…`TESTF`,
  3000 each) under TESTA's existing single-signature policy, then builds
  **10 markets**: 5 token/ADA pairs + 5 cross pairs in a ring
  (`TESTB/TESTC → TESTC/TESTD → TESTD/TESTE → TESTE/TESTF → TESTF/TESTB`).
  Each market gets a dedicated seller/buyer wallet pair from the mm pool and
  10 orders per side (20/market, 200 total), all `allowPartialFill: true`,
  all priced at ratio ≥ 1 token-per-ADA (or ≥1 in the cross legs) per the
  "keep it easy to pay" requirement. Also gifts 1000 of each new token +
  10 tADA to an external Eternl address so it can be used for manual UI
  testing.

Run with `npx tsx e2e/<script>.ts`. Re-verify against the live backend after
running: `GET /pairs` and `GET /pairs/:pair/orderbook`, or
`POST /indexer/reindex` if the indexer needs a nudge.
