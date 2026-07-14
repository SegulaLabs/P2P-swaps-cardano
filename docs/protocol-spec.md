# Protocol Specification — P2P Beacon DEX (MVP, preprod)

Status: **draft / pre-implementation**. Anything marked ⚠ is a design decision
that must be confirmed before implementation — see
[open-questions.md](open-questions.md).

> **2026-07-08 — v3: PARTIAL FILLS.** Orders may opt in to partial fills at
> creation; a new `TakeOrderPartial` redeemer consumes part of the offer and
> leaves an exactly-checked continuation order. Rules, security argument
> (continuation rank pairing), and new hashes: **[partial-fills.md](partial-fills.md)**.
> Where this spec says "full fill only" / "`allow_partial_fill` MUST be
> False", v3 supersedes it.

> **2026-07-06 — IMPLEMENTED.** The rules of §4–§6 as refined by
> **[mvp-contract-decisions.md](mvp-contract-decisions.md)** (which wins where
> they differ) are now live in `contracts/` with 77 passing tests. The §2
> datum below matches `contracts/lib/p2p_dex/types.ak` field-for-field; the
> MVP redeemer set is `CancelOrder | TakeOrder` (**UpdateOrder postponed**).
> Headlines: deposit returns to the seller inside a single exact payment
> output; every spend leaves **zero** beacons in tx outputs; one order input
> per tx on all paths; order addresses = validator payment credential + owner
> staking credential (CIP-0089); SDK = Mesh; provider = Blockfrost. See the
> decisions doc for implementation deviations (e.g. length-prefixed
> PairBeacon encoding).

## 1. Overview

The protocol is a peer-to-peer order book on Cardano's eUTxO model:

- Every **order is a single UTxO** locked at the *order validator* address.
- The order UTxO holds: the offered asset, the required min-ADA, a set of
  **beacon tokens**, and an **inline datum** describing the terms.
- Beacon tokens make orders discoverable by querying the chain for the beacon
  policy id (+ token name), with no central order book.
- There is **no shared/global state**: orders never contend with each other,
  and the protocol has no admin, no pool, and no custody.

Two on-chain scripts:

1. **Order spending validator** (`contracts/validators/order.ak`) — governs how
   an existing order UTxO may be spent (cancel / take / update).
2. **Beacon minting policy** (`contracts/validators/beacon.ak`) — governs how
   beacons are minted/burned, and thereby governs **order creation**, because
   spending validators do not run when a UTxO is created.

### 1.1 Script dependency direction

There is a potential circular dependency (validator needs to know the beacon
policy; the policy needs to know the validator address). We resolve it in one
direction only:

- The **order validator is compiled first** and is *not* parameterized by the
  beacon policy.
- The **beacon minting policy is parameterized by the order validator's script
  hash**, so it can require that beacons are only minted into outputs at that
  address.
- The order datum carries `beacon_policy_id`. At **mint time** the policy
  checks that the datum's `beacon_policy_id` equals its own policy id (a
  minting policy knows its own id from the script context). The spending
  validator can then trust the datum field, because a UTxO carrying real
  beacons must have passed the minting policy at creation.

## 2. Order datum (inline)

```
OrderDatum {
  version:            Int            -- protocol version, 1 for MVP
  beacon_policy_id:   PolicyId       -- verified by the minting policy at creation
  owner:              Credential     -- owner's STAKING credential (key hash for MVP)
  payment_address:    Address        -- where the ask payment must be sent on take
  offer:              AssetClass     -- (policy_id, asset_name); ADA = ("", "")
  offer_amount:       Int            -- > 0
  ask:                AssetClass
  ask_amount:         Int            -- > 0
  expiration:         Option<Int>    -- POSIX time (ms) ⚠ see §6
  allow_partial_fill: Bool           -- MVP: False; v3: seller opt-in (partial-fills.md)
}
```

Notes:

- The datum **must be inline** (CIP-32). Datum-hash-only orders are invalid:
  takers must be able to read terms directly from chain data.
- `owner` is the staking credential so that one user's orders across payment
  addresses group together (and it names the OwnerBeacon). MVP supports
  **key-hash owners only**; script staking credentials are deferred (⚠).
- `offer` and `ask` must be different assets; both amounts strictly positive.
- ADA is represented as the empty policy id + empty asset name.

## 3. Beacons

Five beacon token names under **one minting policy** (full rationale and naming
derivation in [beacons.md](beacons.md)):

| Beacon | Identifies | Token name (proposal ⚠) |
|---|---|---|
| OrderBeacon | "this is a protocol order" | constant, e.g. `"order"` |
| PairBeacon  | the (undirected) trading pair | hash of sorted asset ids |
| OfferBeacon | the offered asset | hash of tagged offer asset id |
| AskBeacon   | the requested asset | hash of tagged ask asset id |
| OwnerBeacon | the owner staking credential | the owner's 28-byte credential hash |

Every valid order UTxO holds **exactly one of each** (5 tokens, amount 1 each).

**Core invariant: beacons must never exist outside a valid order UTxO.**
Enforced jointly:
- *At creation*: the minting policy only mints into valid order outputs (§4).
- *On every spend*: the spending validator requires beacons to be burned
  (take/cancel) or carried forward into a valid continuation order (update).
  This is essential — moving tokens does not invoke a minting policy, so the
  spending validator is the only thing preventing beacons from leaking to
  arbitrary addresses when an order is spent.

## 4. Beacon minting policy rules

Redeemers: `MintBeacons`, `BurnBeacons`.

### MintBeacons
For the transaction to be valid, **every output containing any token of this
policy** must:

1. Be locked at the official order validator address (payment credential =
   the order validator script hash the policy is parameterized with).
2. Carry a valid **inline** `OrderDatum`, with:
   - `version == 1`
   - `beacon_policy_id ==` this policy's own id
   - `offer_amount > 0`, `ask_amount > 0`, `offer != ask`
   - `allow_partial_fill == False`
   - `owner` is a key credential (MVP)
3. Contain **exactly** the 5 required beacons (one each), with token names
   correctly derived from the datum (pair/offer/ask/owner).
4. Contain at least `offer_amount` of the offered asset (plus min-ADA; min-ADA
   is a ledger rule the node enforces, not the script — see
   [eutxo.md](eutxo.md)).
5. No tokens of this policy may go to any other address in the same tx.

Minted amounts must exactly match what the order outputs consume (no leftover
beacons in the mint that don't land in a valid order output).

### BurnBeacons
Only burning is allowed under this redeemer (all this-policy amounts in the
mint field are negative). Unconditional burning is safe because beacons only
live inside order UTxOs, and spending an order UTxO always runs the order
validator, which enforces the real rules.

## 5. Order validator rules

Redeemers: `CancelOrder`, `TakeOrder`, `UpdateOrder`.

### CancelOrder
- The tx is approved by the owner: `datum.owner`'s key hash is in the tx's
  `extra_signatories` (MVP: key owners only).
- All 5 beacons held by the consumed order are **burned** in this tx.
- The offered asset (and the min-ADA deposit) is free to go back to the owner —
  since the owner signed, the validator does **not** need to constrain outputs
  beyond beacon burning.

### TakeOrder
- ⚠ **Double-satisfaction guard (MVP): exactly one input in the tx may come
  from the order validator address.** Without this, one payment output could
  "satisfy" two orders at once. (Output-tagging designs relax this later — see
  [security.md](security.md).)
- The `payment_address` receives an output containing at least
  `ask_amount` of the `ask` asset **plus the order's min-ADA deposit** in
  lovelace (⚠ deposit-return policy to confirm).
- All 5 beacons held by the consumed order are **burned** in this tx.
- If `expiration` is set: the tx validity interval's upper bound must be
  ≤ `expiration` (the taker proves the order has not expired).
- No continuation output at the order validator address is created by this tx
  (full fill only; partial fills are out of scope).
- The buyer's receipt of the offered asset does not need an explicit check:
  the offered asset was in the consumed UTxO and the taker builds the tx, so
  value conservation gives it to whomever the taker directs — the seller is
  protected by the payment check, the buyer by building the tx themselves.

### UpdateOrder — **POSTPONED, not in MVP** (see mvp-contract-decisions.md §7)

The rules below are kept for the future v2 design only. The MVP redeemer type
contains `CancelOrder` and `TakeOrder` exclusively.

- Owner approved (as in Cancel).
- Exactly one order input (same double-satisfaction guard) and exactly one
  continuation output at the order validator address, with:
  - the same 5 beacons, untouched (no minting or burning of this policy);
  - an inline datum identical to the old one **except** `ask_amount` and/or
    `expiration` (so pair, assets, offer amount, owner, and payment address are
    immutable — changing the pair/assets would require re-derived beacon names,
    i.e. mint+burn, and is out of MVP scope);
  - at least `offer_amount` of the offered asset still locked;
  - new `ask_amount > 0`.

## 6. Time ⚠

On-chain scripts never see "the current slot"; they see the transaction's
**validity interval** (in POSIX time, ms). `expiration` is therefore specified
as POSIX time, not a slot number, despite "expiration slot" in early notes.
Expired orders are not auto-returned (nothing happens on-chain without a tx);
the owner cancels them. See open-questions §time.

## 7. Off-chain architecture

```
frontend (Next.js)                backend (Fastify)                 Cardano preprod
┌──────────────────┐   REST   ┌─────────────────────────┐  provider  ┌───────────┐
│ CIP-30 wallet     │ ───────▶ │ routes: pairs/orders/tx │ ─────────▶ │ Blockfrost │
│ signs & (submits) │ ◀─────── │ tx-builder (UNSIGNED)   │            │ (later:    │
│ TransactionPreview│          │ order-indexer ──▶ PG    │            │ Kupo/Ogmios│
└──────────────────┘          └─────────────────────────┘            └───────────┘
```

- **Backend builds unsigned transactions only.** It never sees keys, never
  custodies funds. The wallet signs; submission goes through the wallet or the
  backend's provider (submitting a *signed* tx is not custody).
- **The indexer is a cache, not the source of truth.** The chain is. The
  indexer discovers orders by querying the provider for UTxOs/addresses that
  hold beacon tokens, then verifies datum shape before caching.
- The chain-provider layer is an interface (`ChainProvider`) so Blockfrost can
  be swapped for Kupo/Ogmios/cardano-node without touching business logic.

## 8. Order lifecycle

```
CREATE:  user tx mints 5 beacons ──▶ order UTxO at validator (offer + minADA + beacons + datum)
TAKE:    taker spends order UTxO ──▶ payment to seller's payment_address, beacons burned,
                                     offered asset to taker
CANCEL:  owner spends order UTxO ──▶ beacons burned, value back to owner
UPDATE:  owner spends order UTxO ──▶ continuation order UTxO, beacons preserved,
                                     only price/expiration changed
```

## 9. Versioning

`protocol_versions` (DB) + `GET /protocol/config` expose the current validator
hashes, beacon policy id, and reference-script locations. `version` in the
datum allows future migrations; v1 scripts will never be mutated (new versions
mean new scripts + new beacon policy, old orders remain spendable).

## 10. Out of scope (MVP)

~~Partial fills~~ (v3, [partial-fills.md](partial-fills.md)), two-way/market-maker
orders, AMM/pools, fee switches, script staking-credential owners,
~~order matching/aggregation in one tx~~ (v2, [take-many-orders.md](take-many-orders.md)),
mainnet.
