# TakeManyOrders — atomic batched fills (protocol v2)

> **Superseded by protocol v3 (2026-07-09):** the batched-take design below is
> unchanged and carried forward, but **[partial-fills.md](partial-fills.md)**
> redeployed the scripts (new hashes) and extended batches with partial-fill
> legs; the v2 hashes below are historical (blueprint preserved in
> `e2e/blueprint-v2.plutus.json`, v2 orders drain against it).

**Status: IMPLEMENTED & LIVE-VERIFIED on preprod (2026-07-07).** Approved and
built as designed below; §10 records the deployment facts. It supersedes the
"future TakeManyOrders" sketch in [smart-fill.md](smart-fill.md) §2 with an
implementable plan and a double-satisfaction argument.

**Deployment facts (§10):**
- order validator (v2): `4d0a13355316e80d8addbc93c7bf2fba1a4a6563e6097e87c11794b8`
- beacon policy (v2, order-hash applied): `a88c60a8e8be899466eff52542ee57fd728540be1ed59d4e3ca2c9b0`
  (cross-derived identically by Mesh `applyParamsToScript` and
  `aiken blueprint apply`)
- v1 hashes `89389051…46ab` / `264ed623…cc0a`; the v1 blueprint is preserved
  in `e2e/blueprint-v1.plutus.json` — v1 orders remain spendable only against
  the v1 script (cancel/take one-at-a-time with the old blueprint).
- 85 Aiken tests pass, including the §8 adversarial list (double
  satisfaction, missing/wrong/duplicate tags, batch expiry, cancel smuggling).
- **Live proof**: preprod tx `a6dcda4327cf87df8af3546e4d5064eef232d4f74afdecd03a7f85aac33c9a18`
  took two orders atomically in one transaction — two tagged payments, each
  tag decoding to exactly its consumed order's OutputReference, exact
  ask+deposit values, all 10 beacons burned (`e2e/smoke-take-many.ts`).
- Batch cap: config `MAX_ORDERS_PER_TX` (default 8) — a tx-size/ex-unit
  budget, not a validator rule (§6).
- One deliberate relaxation vs v1: since tags (not address uniqueness) now
  identify the payment, extra untagged outputs at the seller's address are
  allowed — the taker's change may land there, so self-takes work and the
  old `change_address_conflict` builder guard is retired.

## 1. Motivation

Smart Fill (Phase 2) routes a taker across several orders but settles them as
**N independent transactions** — because the deployed validator enforces
**exactly one order input per transaction** (mvp-contract-decisions.md §8). The
taker signs once per order and each leg can be sniped between signatures.

The goal of this phase: **one transaction fills many orders atomically** — all
selected orders settle together or none do, one signature per batch.

## 2. Why the MVP forbids it today (the constraint we must replace)

Two deployed rules make multi-fill unsafe *as written*:

- `only_one_order_input` (order_rules.ak) — every spend path requires exactly
  one input at the order validator's payment credential.
- TakeOrder's payment check finds **the** single output at `payment_address`
  and requires it to carry **no datum** (order_rules.ak §6, line 141).

These together give an unambiguous "one order ⇒ one payment output" mapping,
which is what closes **double satisfaction**: with two order inputs and only the
"exactly one payment output at address X" check, one shared output could satisfy
two orders that happen to share a `payment_address`, letting a taker pay once and
consume twice.

The MVP even left the upgrade hook in place: the payment output is kept datum-
less *specifically* so output tagging can be added later (order_rules.ak line
139–141; mvp-contract-decisions.md §2 "output tagging … is the designed upgrade
path when batch fills are allowed post-MVP").

## 3. Design: per-order output tagging

Replace the "exactly one order input" rule with a **1:1 tagged mapping** between
order inputs and payment outputs. Each order input must be matched by a payment
output whose **datum names that specific order's `OutputReference`**.

### 3.1 Payment output datum (new)

```
pub type PaymentTag {
  /// The OutputReference of the order UTxO this output settles.
  order_ref: OutputReference,
}
```

### 3.2 New spend rule (`take_many_ok`, replaces `take_ok`)

For the order input being validated (`own_ref`, `datum`):

1. **No global input-count limit** — drop `only_one_order_input` for this path.
2. Compute `deposit` exactly as today (MCD §1).
3. Find the **unique** output whose inline datum is `PaymentTag { order_ref: own_ref }`.
   `expect [payment] = outputs.filter(tag == own_ref)` — exactly one.
4. That output must go to `datum.payment_address` with the **exact** value of
   MCD §2 (ask exact, lovelace ≥ deposit, no foreign assets) — unchanged math.
5. `no_beacons_in_outputs(beacon_policy_id)` — unchanged; still forces the full
   burn of **every** consumed order's 5 beacons (value conservation).
6. Per-order `expiration_ok` — unchanged; each order proves its own non-expiry
   against the shared validity range.
7. Defensive `version == 1`, `!allow_partial_fill` — unchanged.

Each order input runs this independently. `CancelOrder` is **unchanged** (still
one-input, owner-signed) — batching cancels is out of scope.

### 3.3 Why double satisfaction stays closed

- Tags are **unique**: `own_ref` is a distinct `OutputReference` per order input.
- Each output carries **at most one** `PaymentTag`, so it can satisfy **at most
  one** order's rule. The mapping is injective by construction.
- Therefore N order inputs require N distinct, correctly-valued payment outputs —
  a taker cannot make one output "count twice."
- Cross-protocol composition is still safe: our payment output must be tagged
  with **our** order's ref, so another DApp's output can never satisfy it.

This is exactly cardano-swaps' `prev_input` tagging (verified in their README;
already cited in MCD §2/§8) applied to our full-fill model.

## 4. What does NOT change

- **Beacon minting policy (`beacon.ak`)**: `BurnBeacons` already succeeds for any
  all-negative burn with no per-tx count limit, so burning 5×N beacons in one tx
  needs **no policy change**. `MintBeacons` (creation) is untouched.
- **Order creation, datum shape, deposit rule, ADA/token payment math** — all
  identical.
- **No partial fills, no cross-token/multi-hop, no UpdateOrder, no mainnet,
  no custody** — still out of scope. This phase only relaxes the *count* of
  order inputs per take, with tagging to keep it safe.
  *(Later note: "out of scope" meant no dedicated routing feature — the
  design itself never restricted a batch to one pair, since every order
  validates independently. Partial fills arrived in protocol v3
  ([partial-fills.md](partial-fills.md)), and mixed-pair batches are now
  exercised deliberately by the arbitrage feature
  ([arbitrage.md](arbitrage.md)) with zero contract changes.)*

## 5. Redeployment consequences (important)

The beacon policy is **parameterized by the order validator's script hash**
(MCD §4). Changing `order.ak` changes the order hash ⇒ **a new beacon policy id**
⇒ every beacon name re-derives ⇒ this is a **new protocol version** end to end.

- Old orders remain spendable **only** by the old contract (one-at-a-time). They
  do not migrate; they are taken/cancelled on the old version until drained.
- New orders are created under the new hashes and support batched fills.
- On preprod: simplest is to **re-seed** the test book under the new version
  (the existing `e2e/create-smart-fill-orders.ts` re-run after redeploy).
- `PROTOCOL_VERSION` bumps to 2; `ORDER_VALIDATOR_HASH` / `BEACON_POLICY_ID`
  cross-checks in config updated; frontend/back read the new blueprint.

## 6. Practical batch size

One tx cannot hold unlimited order inputs — each adds a script execution + a
tagged output, bounded by the **tx size** and **ex-unit** limits. Realistic
batch is **~5–15 orders** depending on reference-script use and per-order ex
units (to be measured with `aiken`'s cost model + a preprod dry run).

The off-chain planner therefore splits a Smart Fill route into **groups of ≤ B**
(B from a measured/config cap): each group is one atomic `TakeManyOrders` tx.
A 26-order route becomes e.g. 2–3 signed txs instead of 26 — atomic *within*
each group, and the UI states the group boundaries honestly.

## 7. Off-chain changes

- **tx-builder**: `buildTakeManyOrders({ wallet, orderIds[] })` — collects N
  order UTxOs, builds N tagged payment outputs, one redeemer per input, one
  mint field burning all 5×N beacons; fails fast if N exceeds the cap.
- **API**: `POST /tx/take-many-orders` (mirrors the existing take endpoint;
  validates each orderId, all on the same pair/side).
  *(As built, the endpoint validates each order but deliberately does NOT
  enforce same pair/side — the validator doesn't need it (§3.3), and
  mixed-pair batches are what make arbitrage cycles possible
  ([arbitrage.md](arbitrage.md)).)*
- **Smart Fill**: keep the current route; add "Fill atomically (B per tx)" that
  calls the batched builder per group. The sequential path stays as a fallback.
- **types**: `TxSummary.action` gains `"take-many-orders"`; the preview lists
  every seller payment so the taker still sees exactly who gets paid.

## 8. Test plan (adversarial-first, mirrors MCD §11)

On-chain (`aiken check`), highest-value attacks first:
1. **Missing tag**: an order input with no matching tagged output → fail.
2. **Shared output / double satisfaction**: two order inputs, one payment output
   tagged for both refs (impossible to encode two tags) or reused → fail.
3. **Wrong tag**: output tagged with a different (or non-existent) order ref → fail.
4. **Underpay / wrong asset / foreign assets** in a tagged payment → fail (reuses
   the §6 value checks per order).
5. **Beacon leak**: any beacon of the policy in any output → fail (unchanged).
6. **Per-order expiry**: one expired order in the batch → whole tx fails.
7. **Mixed redeemers / cancel smuggled into a batch take** → fail.
8. Happy paths: N = 1 (must still work — back-compat of the take shape), N = 2,
   token↔token, ADA→token, token→ADA in one batch.

Off-chain (vitest): builder produces exactly N tagged outputs + 5×N burns;
cap enforced; a live preprod smoke test taking a 3-order batch atomically.

## 9. Rollout checklist

1. Approve this design.
2. Implement `take_many_ok` + `PaymentTag`; keep `cancel_ok` as-is.
3. Adversarial tests green (`aiken check`), then `aiken build`.
4. Re-derive hashes; update config cross-checks; redeploy reference scripts.
5. Implement builder + endpoint + Smart Fill batching; vitest green.
6. Re-seed preprod; live smoke test of an atomic batch.
7. Update smart-fill.md §2 to "implemented in v2" and record the new hashes in
   mvp-contract-decisions.md.
