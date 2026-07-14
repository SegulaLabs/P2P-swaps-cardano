# Partial Fills (protocol v3)

Status: **implemented** (contracts + off-chain). Supersedes the "full fills
only" rule of [mvp-contract-decisions.md](mvp-contract-decisions.md) §6 and
the deferral in [smart-fill.md](smart-fill.md) §3, and composes with the v2
batched takes of [take-many-orders.md](take-many-orders.md).

## 1. What changes

A seller may opt an order into partial fills at creation
(`allow_partial_fill: True` — the datum field existed since v1, pinned False
until now). A taker may then consume part of the offer with the new redeemer:

```
TakeOrderPartial { take_amount: Int }
```

The fill pays `required = ceil(take_amount × ask_amount ÷ offer_amount)` of
the ask to `payment_address` (rounding always favours the seller) and
recreates the order as a **continuation output**: the consumed UTxO's exact
value minus the taken offer — so the deposit, the remaining offer, and all
five beacons ride along — under a datum identical except

```
offer_amount' = offer_amount − take_amount     (must stay > 0)
ask_amount'   = ask_amount   − required        (must stay > 0)
```

`ask' = ask − required` (not "− paid") keeps the continuation a pure function
of `(datum, take_amount)`: overpayment is a seller bonus that never cheapens
the remainder, and builder/indexer/next taker can all derive the continuation
without inspecting payment lovelace. Because `Σ ceil ≥ ceil Σ`, any fill
sequence pays the seller at least the original ratio; the remainder's price
never drops below it by more than the sub-unit rounding already credited.

The **final fill is a plain `TakeOrder`** (valid regardless of the flag): it
pays the remaining ask exactly, burns all five beacons, and returns the
deposit — which is also why the deposit-return decision of MCD §1 is
unchanged: the deposit stays locked in the shrinking continuation (the
cardano-swaps model MCD §1 contrasts with) and comes back on the closing
fill or cancel. Taking the full remaining amount via `TakeOrderPartial` is
rejected (`take < offer`, `required < ask`); dust is otherwise the seller's
problem — there is deliberately no on-chain minimum fill.

**Min-ADA on partial legs:** no deposit is returned, so when the ask is a
native token the **taker** funds the payment output's ledger min-ADA (the
script leaves payment lovelace unconstrained; for ADA asks the rule is
`lovelace ≥ required` as before). That lovelace is a small per-leg gift to
the seller; the builder and UI surface it.

## 2. Validator rules — `take_partial_ok` (order_rules.ak)

1. `version == 1` and `allow_partial_fill == True` (defensive re-checks).
2. `0 < take_amount < offer_amount` and `required < ask_amount`.
3. The unique `PaymentTag { order_ref == own_ref }` output (v2 mechanism,
   unchanged) pays `payment_address`: ADA ask → `lovelace ≥ required`, no
   other assets; token ask → **exactly** `required` of the ask, lovelace free.
4. **Rank pairing** (see §3): this run's continuation output has
   - the consumed input's exact address (validator payment credential +
     owner staking credential, CIP-0089);
   - value **exactly** `input_value − take_amount·offer` (one equality pins
     deposit retention, the remaining offer, exactly the five beacons, and
     no foreign assets at once);
   - inline datum **exactly** the reduced datum (every other field
     byte-identical, so pair/assets/owner/payment address/expiration/flag
     are immutable);
   - no reference script.
5. Expiration: same rule as full takes — finite validity upper bound
   ≤ `expiration`; the continuation keeps the same expiration (forced by the
   datum equality).

`mint_beacons_ok` drops its `!allow_partial_fill` check (the flag is a free
seller choice); nothing else changes on the mint side. Cancel is unchanged
(one order input, all beacons burned).

## 3. Security: continuation injectivity in batches (rank pairing)

Nothing in an `OrderDatum` is unique, so two byte-identical orders partially
filled in one tx could otherwise both "recognise" one shared continuation —
the taker would pocket the second order's assets. Payments are already
injective via `PaymentTag`; continuations get the batch-safe analogue:

- **S** = OutputReferences of all inputs at the order validator spent with a
  `TakeOrderPartial` redeemer, in tx input order. The ledger sorts inputs
  ascending by OutputReference, and every validator run reads the same
  `self.redeemers`, so every run computes the same canonical S. (Reading a
  sibling's redeemer is sound: that input is validated by this same script
  with that same redeemer.)
- **C** = all outputs (any address) carrying any beacon-policy token, in
  output order.
- **Every take-path run** (full and partial) requires `|C| == |S|`. With no
  partial inputs this degenerates to v2's `no_beacons_in_outputs`.
- A partial run at rank *i* in S requires `C[i]` to be **its** continuation,
  exact in address, value, and datum.

Ranks are distinct by construction and all runs agree on S and C, so the
input→continuation mapping is a bijection. Beacon conservation follows: a
take tx cannot mint beacons (`MintBeacons` demands exactly one beacon-bearing
output and an all-positive mint — unsatisfiable next to continuations or
beacon-carrying inputs), each `C[i]` holds exactly its own five beacons
(quantity-capped by the exact-value check, so a fully-taken twin's beacons
cannot hide inside a continuation), hence every fully-taken order's beacons
have no output home and **must** be burned by value conservation. Pure-partial
txs burn nothing and never invoke the beacon policy at all.

Off-chain, the builder replays the same ordering: it sorts the batch's legs
ascending by `(txHash, outputIndex)` — the ledger's input order — and emits
each partial leg's continuation in that order (change outputs carry no
beacons and come last), so C lines up with S by construction.

## 4. Redeemer indices (off-chain contract)

`OrderRedeemer` constructors are append-only: `0 = CancelOrder`,
`1 = TakeOrder`, `2 = TakeOrderPartial(take_amount)`. The indexer classifies
spends by constructor: 2 ⇒ status `partially_filled`, and the continuation
(the consuming tx's output at the order address carrying the OrderBeacon) is
discovered as a **new** order row; `order_lineage(child, parent, root)` links
the chain.

**No vanish window:** the parent and its continuation are created in one tx,
so the indexer surfaces the continuation as `open` **in the same sync pass**
that marks the parent `partially_filled` — it does not wait for the normal
`INDEXER_CONFIRMATIONS` discovery gate (the spend it just trusted is that same
tx). Without this, the parent would leave the open book the moment its spend
is seen while the continuation waited extra confirmations to appear, blinking
the seller's remaining liquidity out of the book. A reorg self-heals on the
next pass (parent reappears as open, child vanishes).

## 5. Versioning / deployment facts

A validator change ⇒ new order hash ⇒ new beacon policy id ⇒ **protocol v3**;
all five beacon names re-derive. The datum's `version` field stays `1` — it
versions the (unchanged) datum schema; protocol identity is carried by the
script hashes.

| | order validator | beacon policy |
|---|---|---|
| **v3 (this)** | `1757ecd8fdc1c3d095906f13f17acdf8262a7c2363ac69ddeb256f8b` | `c14dc44ed1e2025bae03895af442f2fa9d387deb526b6518b5aa8702` |
| v2 (take-many) | `4d0a1335…94b8` | `a88c60a8…c9b0` |
| v1 (MVP) | `89389051…46ab` | `264ed623…cc0a` |

v2 orders do not migrate: they remain spendable only against the v2 scripts
(blueprint preserved in `e2e/blueprint-v2.plutus.json`) — cancel/take them
there until drained, as was done for v1. `PROTOCOL_VERSION=3` in the backend
env; the boot cross-check (`ORDER_VALIDATOR_HASH` / `BEACON_POLICY_ID`)
rejects stale blueprints. Reference scripts, when published, must be re-parked
and re-recorded (`reference_scripts`, `GET /protocol/reference-scripts`).

## 6. Off-chain surface

- `POST /tx/create-order` gains `allowPartialFill` (default false).
- `POST /tx/take-order` gains optional `takeAmount` (absent = full fill).
- `POST /tx/take-many-orders` accepts `orders: [{ orderId, takeAmount? }]`
  (legacy `orderIds` still accepted, meaning all-full fills). Mixed batches
  are fully supported.
- Smart Fill now spends leftover budget with **one marginal partial leg** on
  the cheapest partial-enabled remaining order (and hits exact receive
  targets the same way), below-dust legs skipped with a warning.
- `TxSummary.action` gains `take-order-partial`; summaries list per-leg
  `takeAmount` / `paidAsk` / remaining amounts, and warn when a token-ask
  partial leg donates min-ADA.
