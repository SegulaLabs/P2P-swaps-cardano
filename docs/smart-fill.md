# Smart Fill — routing over full orders (Phase 2)

Status: **Phase 2 shipped; execution upgraded by protocol v2.** The routing
layer below is unchanged, but settlement now uses **TakeManyOrders**
([take-many-orders.md](take-many-orders.md)): the route's legs are grouped
into batches of up to `MAX_ORDERS_PER_TX` orders, and **each batch settles in
ONE atomic transaction**. §1's "one order per transaction / not atomic"
statements describe the original MVP execution and are superseded — a route
that fits one batch IS atomic now; only multi-batch routes remain
non-atomic *across* batches.

Smart Fill is a **discovery / UX** layer. It does not add any new on-chain
capability. It answers one question for the taker:

> "I want to spend at most _X_ of asset A to receive asset B — which existing
> open orders give me the best deal, and what would filling them look like?"

Everything below is computed off-chain from the same indexed order cache the
order book already uses. Settlement is still the unchanged, audited MVP
`TakeOrder` path, one order per transaction.

---

## 1. Smart Fill now (this phase)

**Input:** `spendAsset`, `receiveAsset`, `maxSpend` (raw integer units).

**What it does:**

1. Derives the canonical pair id (`sort(spendAsset, receiveAsset)` joined by
   `_`) and loads that pair's **open** orders from the existing cache
   (`OrdersRepo.listByPair`). No new indexing.
2. Keeps only the orders on the taker's side of the book — those whose
   **offered** asset is `receiveAsset` and whose **requested** asset is
   `spendAsset`. Taking such an order pays the maker `requestedAmount` of
   `spendAsset` and gives the taker `offeredAmount` of `receiveAsset`.
3. Ranks them by **effective price** = `requestedAmount / offeredAmount`
   (spend per unit received; lower is better). All comparisons are done by
   bigint cross-multiplication — never floating point.
4. Greedily selects **whole** orders cheapest-first while the running total of
   `requestedAmount` stays within `maxSpend`. An order is either fully selected
   or skipped — **never partially selected** (the MVP contract only supports
   full fills).
5. Returns a **route preview**: the selected legs, total spend, total receive,
   average price, transaction count, and honest warnings.

**Execution:** because the MVP allows **one order input per transaction**, a
multi-leg route is **not atomic**. The UI executes it as a **sequence** of
ordinary `TakeOrder` transactions (the exact existing flow — build → preview →
wallet sign → submit → next leg), or the user can take just the single best
leg. Between legs, another taker may consume an order (the losing take fails
harmlessly — no funds move — per [eutxo.md](eutxo.md) §1); the UI surfaces this
and lets the user re-plan the remaining budget.

**Honesty invariants (enforced in the returned `warnings`):**

- Smart Fill is a routing preview, **not** an atomic swap.
- A multi-leg route is N independent transactions; orders can be taken by others
  in between.
- Prices are effective prices in **raw units** — decimals are cosmetic and
  applied only at the display boundary.
- Max spend is never exceeded, and no order is ever partially filled.

---

## 2. `TakeManyOrders` — **IMPLEMENTED (protocol v2)**

> Designed, approved, implemented and live-verified — see
> [take-many-orders.md](take-many-orders.md). The sketch below is kept for
> the historical rationale.

Making a multi-leg route **atomic** requires spending **more than one order
input in a single transaction**. The MVP validator deliberately forbids this
(mvp-contract-decisions.md §8): with exactly one order input, the single exact
payment output of §6 is unambiguous and double-satisfaction is impossible.

A `TakeManyOrders` phase would:

- Relax the one-input rule and add **output tagging** — each payment output
  carries a datum naming the consumed order's `OutputReference` (cardano-swaps'
  `prev_input` approach, already noted as the designed upgrade path in §2/§8),
  so N orders map unambiguously to N payment outputs and double satisfaction
  stays closed.
- Be a **new script hash → new protocol version** (a validator change is never
  a silent upgrade).
- Require its own adversarial test pass (batched payment matching, per-leg
  expiry, ex-unit budget for N inputs).

It is a **separate phase** because it changes the trust-critical on-chain code;
Smart Fill routing does not, and delivers most of the user value now.

## 3. Partial fills — SHIPPED (protocol v3)

Implemented in **[partial-fills.md](partial-fills.md)**: opted-in orders may
be fractionally consumed via `TakeOrderPartial`, leaving an exactly-checked
continuation output (rank-paired to its order input for batch safety).

Smart Fill now spends leftover budget with **one marginal partial leg**: after
the greedy whole-order pass, the cheapest remaining partial-enabled order is
taken for exactly the residual budget (spend mode) or the residual target
(receive mode). Legs below the dust threshold — or whose taker-funded min-ADA
would rival their value — are skipped with a warning, so tiny leftovers are
still honestly reported as unused.

## 4. Future: cross-token / multi-hop routing

Smart Fill Phase 2 is **single-pair only**: `spendAsset → receiveAsset` must
have a direct order book. Routing A → B → C (spend A, hop through B, receive C)
means chaining takes across pairs — strictly more txs, price/slippage across
hops, and much larger route-search surface. It is deferred until at least
`TakeManyOrders` exists, because without atomic multi-input execution a
multi-hop route is even less atomic than a single-pair multi-leg one (a
half-completed hop leaves the user holding the intermediate asset).

## 5. Why these are separate phases

| Phase | On-chain change? | New trust surface | Delivers |
|---|---|---|---|
| **Smart Fill (now)** | none | none | best-route discovery + sequential fill over existing orders |
| TakeManyOrders | yes (new script) | batched payment matching, output tagging | atomic multi-order fill |
| Partial fills | yes (new script) | continuation outputs, datum-diff | fractional fills |
| Cross-token routing | builds on the above | multi-hop price/atomicity | A→B→C swaps |

Each later phase is gated on the previous one's on-chain work being audited.
Shipping Smart Fill first gets the routing UX and its honesty story in front of
users **without touching the validators**, and de-risks the on-chain phases by
letting the route data model and warnings settle against real usage first.
