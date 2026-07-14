# Arbitrage — atomic profit cycles over the open book

Status: **implemented** (off-chain only — **zero contract changes**). Builds
entirely on protocol v2 batched takes ([take-many-orders.md](take-many-orders.md))
and v3 partial fills ([partial-fills.md](partial-fills.md)).

## 1. Why this needs no contract change

The order validator checks every order input **independently**: a tagged
payment output with the exact ask (+ deposit on full fills), beacons burned or
carried into a continuation, per-order expiry. There is **no cross-order
pair/side rule anywhere on-chain**, and `/tx/take-many-orders` never had one
off-chain either. So one transaction may take orders from *different* pairs —
and because eUTxO transactions balance **globally**, the assets released by
one consumed order can fund another order's ask **inside the same tx**.

This is exactly the composability cardano-swaps advertises ("arbitragers are
the connective tissue of the protocol": chained swaps across pairs settle
atomically because each script execution validates only its own UTxO). Our
`PaymentTag` mechanism is their `prev_input` tagging, so the same
double-satisfaction argument holds for mixed-pair batches: each payment output
names exactly one consumed order.

**Consequence:** a profitable cycle costs the taker *nothing but the tx fee*
(plus min-ADA gifts on partial legs). The wallet never needs to hold any of
the cycle's assets — the cycle funds itself — and the whole thing settles
atomically: either every leg fills or nothing moves.

## 2. What counts as an arbitrage cycle

Taking order *o* = pay `ask` of asset `X`, receive `offer` of asset `Y`
(a directed edge `X → Y` at rate `offer/ask`).

- **Direct cross (2 legs):** the same pair's book crosses — an order selling
  B for A and an order selling A for B whose prices overlap
  (`offer₁/ask₁ × offer₂/ask₂ > 1`).
- **Triangular (3 legs):** orders on A/B, B/C, C/A forming a cycle
  `A → B → C → A` whose rate product exceeds 1.

A rate product > 1 is necessary but not sufficient: fills are **whole orders**
unless the seller opted into partial fills, so amounts must also chain. The
planner:

1. Filters open, unexpired orders and groups them into directed edges,
   cheapest first (bigint cross-multiplication, never floats).
2. Enumerates 2-cycles (each asset pair with both directions, top-K orders per
   side) and 3-cycles (asset triples with all three edges, top-K per edge),
   pre-filtered by rate product > 1.
3. **Sizes the cycle** (per rotation of the leg order, best kept): the anchor
   leg is taken whole; walking forward, if a leg's ask exceeds the asset
   amount the previous leg delivered, the leg is **trimmed** with a partial
   fill (`maxTakeForSpend`, seller-favouring `requiredPayment` rounding —
   the exact v3 math) when the order allows it, otherwise the combo is
   rejected. **No wallet top-ups**: a shortfall never dips into taker funds.
4. Accepts a cycle iff, summing every leg, the **net per asset is ≥ 0 for all
   assets and > 0 for at least one** — riskless by construction.

Surpluses can land in more than one asset (e.g. trimming leaves extra B and
the wrap-around yields A) — the opportunity reports the full net vector, plus
a fee-aware lovelace line.

## 3. Costs (reported, never hidden)

- **Tx fee**: estimated per batch (`ARBITRAGE_FEE_ESTIMATE_LOVELACE`, default
  1 ADA — take-many txs with 2–3 script inputs measured well under that);
  the true fee shows in the TransactionPreview before signing.
- **Partial legs**: no deposit is returned and the taker funds the payment
  output's min-ADA on token asks (1.4 ADA per such leg — same rule as
  partial-fills.md §1). ADA asks below 1.4 ADA are topped up to it.
- Deposits on **full** legs are returned to their sellers from the order UTxO
  itself — never a taker cost.

`lovelaceNetAfterCosts` = gross lovelace net − fee estimate − partial min-ADA;
when it is negative but token profit remains, the opportunity is still listed
with an explicit warning (the taker pays ADA to collect token profit).

## 4. Honesty / limits

- The book is a cache; someone can take a leg first. The loser's tx **fails
  whole** — atomicity means no partial exposure, no funds move.
- Opportunities are ranked by cycle **margin** (rate product − 1), an
  oracle-free measure; per-asset nets are raw units, decimals cosmetic.
- v1 scope: one order per edge, cycles of length 2 and 3, top-K candidates
  per edge (K = 4 direct / 2 triangular). Multi-order legs and longer cycles
  are future work.
- Execution reuses `/tx/take-many-orders` verbatim — same preview, same
  wallet signing, same non-custodial guarantees. Nothing new on-chain.

## 5. Surface

- `backend/src/services/arbitrage.ts` — pure planner (`findArbitrage`),
  fully unit-tested; no network/DB.
- `GET /arbitrage` — scans all cached pairs, returns
  `{ opportunities, scannedOrders, pairCount, generatedAtMs }`.
- Frontend `/arbitrage` — lists opportunities (cycle, legs, profit, costs),
  executes one via the existing take-many build → preview → sign flow.
