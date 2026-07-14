# Security Audit — Cardano P2P Beacon DEX (Fable 5, adversarial)

Auditor: Claude Fable 5 (adversarial engagement)
Date: 2026-07-13
Target: `/workspace/cardano-p2p-beacon-dex`
Commit state audited: working tree as-checked-out; contracts verified with `aiken v1.1.23`, stdlib `v2.2.0`.

> All audit artifacts (this report, machine-readable findings, regression tests, and
> illustrative wallets/stake addresses) live under `Audit/`. Per the engagement rules I
> did **not** modify any protocol source; the regression tests were run in-tree to
> capture evidence and then relocated to `Audit/regression-tests/` (see that folder's
> README for how to re-run them).

---

## Executive Summary

I attacked this protocol as a hostile order creator, seller, taker, colluding pair,
multi-wallet operator, and raw-transaction builder that ignores the frontend and
backend entirely. The **on-chain trust boundary is strong**: I could not construct a
ledger-valid transaction that steals locked value, underpays a seller, double-satisfies
one payment across two orders, leaks or forges beacons, or drifts a partial-fill
continuation in the attacker's favour. The two validators (`order` spend + `beacon`
mint) together enforce a tight, well-tested invariant set, and the double-satisfaction
defense (per-order `PaymentTag` + rank-paired continuations + count-based beacon
accounting) holds under every batching and mixing permutation I tried, including novel
shapes not present in the existing suite.

The material risk is **not** in the contracts. It is in the **off-chain trust model**:

- **F-01 (High, scoped):** the frontend signs backend-provided CBOR while showing a
  backend-provided summary. Only the *fee* is decoded from the real transaction. A
  malicious or compromised backend (or a MITM on an un-pinned connection) can present a
  benign preview while the actual transaction routes the *taker's/creator's own* funds
  elsewhere. The on-chain validators protect the **seller's** payment but do nothing to
  protect the party who authors and signs the transaction. This is documented in-repo as
  a known gap, but it remains the single most impactful issue and gates any move beyond
  preprod.

The remaining confirmed findings are Low/Informational griefing and hygiene issues:
unbounded `ask` asset identifiers allow unfillable order-book spam (F-02); order
creation is permissionless in the owner field, allowing UI-level impersonation (F-03);
the off-chain route/arbitrage planners don't exclude the taker's own orders, allowing
wash-style self-fills (F-04); and order discovery cost scales with a self-fundable spam
flood (F-05).

**Verdict: PREPROD TESTING ONLY.** The contracts are close to external-audit quality,
but F-01 must be closed (client-side CBOR verification, or a signed/deterministic build
attestation) before real value is ever at stake, and F-02/F-03 warrant cheap on-chain
hardening while the contract is still unfrozen.

---

## Scope

In scope and inspected in full:

- Aiken validators: `contracts/validators/order.ak`, `contracts/validators/beacon.ak`
- Aiken rules/libs: `contracts/lib/p2p_dex/{order_rules,beacon_rules,beacons,types}.ak`
- Aiken tests + fixtures: `contracts/lib/tests/{order_tests,beacon_tests,fixtures}.ak`
- Backend protocol codecs: `backend/src/protocol/{beacons,datum,blueprint}.ts`
- Backend services: `tx-builder`, `order-indexer`, `smart-fill`, `arbitrage`,
  `chain-provider`, `asset-metadata`
- Backend routes: `tx`, `orders`, `smart-fill`, `arbitrage`, `assets`, `pairs`, `protocol`
- Backend config: `config.ts`
- Frontend flow: `hooks/useTxFlow.ts`, `components/TransactionPreview.tsx`,
  `lib/{api,validate,pricing,walletAdapter}.ts`
- Deployment/blueprint config: `blueprint.ts`, `config.ts`, `plutus.json`, `plutus-applied.json`
- Docs: `mvp-contract-decisions.md`, `protocol-spec.md`, `eutxo.md`, `beacons.md`,
  `security.md`, `deployment.md`, `open-questions.md`, `take-many-orders.md`,
  `partial-fills.md`, `smart-fill.md`, `arbitrage.md`

Tooling: `aiken check` (all 130 stock tests pass; +5 audit tests I added, all pass);
`vitest` backend suite (120 tests pass).

Out of scope / not exercised: live preprod submission (no funded keys / provider key in
this environment), wallet-extension internals, Blockfrost/Kupo/Ogmios server code.

---

## Actual Implemented Protocol (code as ground truth)

What the code *actually* implements (docs are largely accurate, deviations noted):

**Order lifecycle.** An order is a single UTxO at a per-owner "personal" script address:
payment credential = the (unparameterized) `order` validator hash, staking credential =
the owner's staking **key** hash (CIP-0089 pattern, `blueprint.ts::orderAddressFor`,
`beacon_rules.ak` step 2). Each order carries an inline `OrderDatum` and exactly five
beacon tokens under one policy: `OrderBeacon` (constant `"order"`), `PairBeacon`,
`OfferBeacon`, `AskBeacon`, `OwnerBeacon`.

**Creation** is enforced solely by the `beacon` minting policy (`MintBeacons`), because
spending validators don't run on output creation. It pins: exactly one beacon-bearing
output; that output at the validator address with owner-stake credential; well-formed
key-owner `OrderDatum`; `payment_address` is a key address; `version==1`;
`beacon_policy_id==policy`; `offer != ask`; positive amounts; offer/ask policy ≠ beacon
policy; exact output value (deposit lovelace + offer + the 5 beacons, no strays); and
`mint == exactly the 5 beacons, +1 each`. **Creation requires no owner signature.**

**Redeemers actually present** (`types.ak::OrderRedeemer`): `CancelOrder` (0),
`TakeOrder` (1), `TakeOrderPartial{take_amount}` (2). There is **no `UpdateOrder`**
(postponed). Beacon policy redeemers: `MintBeacons` (0), `BurnBeacons` (1, burn-only).

- **CancelOrder** — owner staking key in `extra_signatories`; **exactly one** order-script
  input in the whole tx; no beacon tokens in any output (forces the 5-beacon burn). Value
  routing is the owner's business (they signed).
- **TakeOrder** (full fill; v2 multi-order) — each order input validated independently
  against **its own** `PaymentTag`-tagged payment output at `payment_address`, carrying
  exactly the ask + at least the returned deposit and no foreign assets;
  `beacon_accounting_ok` (beacon-bearing outputs == partial-take inputs, i.e. 0 here, so
  all beacons burn); expiry respected. **Many orders per tx** allowed.
- **TakeOrderPartial** (v3) — requires `datum.allow_partial_fill`; consumes
  `take_amount` (`0 < take < offer`); pays exactly `required = ceil(take*ask/offer)`
  (`required < ask`) to the tagged payment (deposit **not** returned); recreates a
  continuation at the same address with value = input − taken offer (deposit + remaining
  offer + all 5 beacons) and datum identical except both amounts reduced. Continuations
  are bound to inputs by **rank pairing**: the run's rank among partial inputs (canonical
  ascending input order) selects the rank-th beacon-bearing output, and #beacon-outputs
  == #partial-inputs.

**Off-chain features that exist:** multi-order atomic `TakeManyOrders`; Smart Fill route
planner (greedy cheapest-first whole orders + at most one marginal partial leg);
arbitrage finder (2- and 3-cycles, partial-trimmed); a Postgres order cache/indexer with
partial-fill lineage tracking. All fund math is bigint; the backend beacon derivation and
partial-fill math mirror the Aiken code (`beacons.ts`, `datum.ts::requiredPayment`).

**Deviations from docs (benign):** the pair-beacon encoding length-prefixes each asset id
(documented refinement in `beacons.ak` — closes a concatenation-ambiguity spam vector, and
I confirmed the derivation is unambiguous). Deposit default is 3.5 ADA (config), fixtures
use 2 ADA.

---

## Protocol Invariants (the ones that matter)

On-chain (must hold against raw transactions):

1. **I1 — Seller payment exactness.** A full take pays the seller *exactly* `ask_amount`
   of the ask asset plus ≥ the deposit, no foreign assets, at `payment_address`.
2. **I2 — Injective order→payment mapping.** No single output may settle two order
   inputs (`PaymentTag == own_ref`, unique-or-crash).
3. **I3 — Beacon conservation.** Every beacon that enters a spend either lands in exactly
   one exact-valued continuation or is burned; beacons can never leak to change, other
   scripts, seller payments, or fake orders; beacons cannot be minted except into one
   valid new order.
4. **I4 — Continuation fidelity.** A partial continuation has value = input − taken
   offer and datum identical except `offer'=offer−take`, `ask'=ask−required`; same owner,
   pair, payment address, version, flag, expiration.
5. **I5 — Seller-favoring rounding.** `required = ceil(take*ask/offer) ≥ proportional`;
   the taker can never underpay a partial; the total ask for a fully-consumed order is
   exactly the original ask.
6. **I6 — Owner-only cancel.** Only the owner's staking key can cancel.
7. **I7 — Creation integrity.** Only well-formed orders (address, datum, exact value,
   exact 5-beacon mint) can be created; no strays, no extra beacons.
8. **I8 — Expiry.** An expired order can only be cancelled, never taken.

Off-chain (integrity/UX, not fund-authoritative):

9. **I9 — Preview truthfulness.** The signed transaction does what the preview claims.
   *(This is the one that is not enforced — see F-01.)*
10. **I10 — Discoverability integrity.** Indexed orders are real, fillable, and correctly
    attributed.

---

## Attack Methodology

1. Read every validator and rule as ground truth; treated docs as claims to disprove.
2. Enumerated the exact set of ledger-valid transactions each redeemer accepts, then
   searched for a value-violating member (theft, underpayment, beacon leak, price drift).
3. Modeled complete transactions (not isolated validator calls): multi-input batches,
   mixed full/partial legs, unrelated inputs/outputs interleaved, colliding beacon names,
   shared payment addresses, permuted input/output ordering.
4. Brute-forced the partial-fill rounding over small integer domains (where rounding
   attacks surface first) and reasoned about telescoping over repeated fills.
5. Wrote adversarial Aiken tests to *prove* each hypothesis pass/fail (evidence preserved
   in `Audit/regression-tests/audit_fable5_tests.ak`); ran the full suite.
6. Traced the off-chain path: what a malicious backend can lie about, and what (if
   anything) the frontend independently verifies.
7. Probed the indexer and route/arbitrage planners for wrong-but-not-thieving behavior.

---

## Confirmed Findings

### F-01 — Signed transaction is not verified against the preview (backend fully trusted for taker/creator funds)

- **Severity:** High *(in a compromised/malicious-backend or MITM threat model; the
  contracts themselves remain safe)*
- **Confidence:** High (confirmed by reading the sign path and the preview component)
- **Affected files:** `frontend/hooks/useTxFlow.ts`, `frontend/components/TransactionPreview.tsx`,
  `backend/src/services/tx-builder.ts`
- **Affected function:** `useTxFlow.confirmAndSign`, `TransactionPreview.decodeFeeLovelace`
- **Intended invariant:** I9 (preview truthfulness).
- **Attack preconditions:** attacker controls or MITMs the backend response (malicious
  operator, compromised host, or transport without integrity). The victim is any user who
  builds a take/create/cancel and confirms without scrutinizing the wallet dialog.
- **Attack construction:** `confirmAndSign` signs `state.tx.unsignedTxCborHex` verbatim.
  The preview renders `state.tx.summary` (backend-supplied) and decodes *only* the fee
  from the CBOR (`Transaction.fromCbor(...).body().fee()`). Nothing decodes the CBOR's
  outputs, change address, mint, or datums and compares them to the summary. A hostile
  backend returns `{ summary: <benign "you receive X, you pay Y">, unsignedTxCborHex:
  <a tx that spends the taker's wallet UTxOs to attacker-controlled outputs> }`. Because
  the *taker* authors and signs the transaction, on-chain value conservation lets their
  inputs flow anywhere the tx directs — the order validator only constrains the seller's
  payment, not the taker's change/outputs. The wallet extension shows the true tx, so the
  only real defense is user diligence (which the summary is explicitly designed to reduce).
- **Concrete example:** user wants to take an order paying 50 tADA for a token. Backend
  returns a summary saying exactly that, but the CBOR sets `changeAddress` to the
  attacker and adds no real change output back to the user; the user's ~16k tADA wallet
  (see `describeInsufficientFunds` comment referencing such balances) drains to the
  attacker minus the take. Only the wallet dialog would reveal it.
- **Actual result:** on-chain validators accept the tx (seller is paid correctly); the
  taker is robbed. Not caught by any client-side check besides the wallet UI.
- **Impact:** theft of taker/creator funds under backend compromise. Sellers are safe.
- **Proof of concept:** code path is direct — `confirmAndSign` → `signAndSubmit(wallet,
  state.tx.unsignedTxCborHex)` with no re-derivation. The in-repo `STANDARD_WARNINGS`
  and the `TransactionPreview` "REMAINING TRUST GAP" comment acknowledge exactly this.
- **Regression test:** N/A as an Aiken test (off-chain). Recommended: a frontend test
  that decodes the returned CBOR and asserts every non-fee, non-change output and the
  change address match the summary; feed it a summary/CBOR mismatch and assert rejection.
- **Recommended fix (smallest safe):** before `confirmAndSign`, decode the unsigned CBOR
  client-side and assert: (a) change/fee-payer address == connected wallet's change
  address; (b) every output not going to the wallet matches a summary line (address +
  value + datum, including `PaymentTag`); (c) mint == the summary's beacon set. Reject on
  any mismatch. Longer term, publish a reproducible-build attestation of the scripts and
  verify script hashes client-side too.

---

### F-02 — Minting policy does not bound `ask` asset identifier length → unfillable order-book spam

- **Severity:** Low
- **Confidence:** High (proved with an Aiken test that mints such an order)
- **Affected files:** `contracts/lib/p2p_dex/beacon_rules.ak`, `backend/src/services/order-indexer.ts`
- **Affected function:** `beacon_rules.mint_beacons_ok`
- **Intended invariant:** I7 / I10 (only real, fillable orders enter the book).
- **Attack preconditions:** attacker builds a raw creation tx (bypassing the backend,
  whose `fromApiAssetId` caps asset names at 32 bytes). Attacker funds one deposit per
  spam order.
- **Attack construction:** the `ask` asset is never *held* in the order UTxO (it is only a
  target), so `mint_beacons_ok` performs no length check on `datum.ask.policy_id` /
  `datum.ask.asset_name`. Create an order asking for a token whose asset name is 40 bytes
  (> the 32-byte ledger limit) or whose policy id is not 28 bytes. No such asset can ever
  exist on Cardano, so no taker can produce the payment — the order is permanently
  unfillable, yet it mints cleanly and passes `order-indexer.validateAndMap` into the open
  book (the beacon set derives fine from arbitrary bytes).
- **Concrete example:** `ask = { policy_id: <valid 28B>, asset_name: 0xaabb…(40 bytes) }`,
  `ask_amount = 1`, offer 100 TOKA, deposit 3.5 ADA → mints, indexes, shows on the pair,
  can never be taken.
- **Actual result:** `mint_beacons_ok` returns `True` (see
  `audit_oversized_ask_asset_name_mints_unfillable_order`).
- **Impact:** order-book pollution / griefing; degraded UX (users see fillable-looking
  orders that always fail at build). The offer side *is* bounded (a real held token is
  ≤32 bytes), so this is spam, not theft. Attacker pays ~3.5 ADA deposit per order (which
  they can later reclaim via cancel), so it is economically self-limiting but cheap.
- **Proof of concept:** `Audit/regression-tests/audit_fable5_tests.ak` →
  `audit_oversized_ask_asset_name_mints_unfillable_order` (currently **passes**, i.e. the
  policy accepts the unfillable order; a fix should flip it to fail).
- **Recommended fix:** in `mint_beacons_ok`, require
  `bytearray.length(datum.ask.policy_id) == 28 || is_ada(datum.ask)` and
  `bytearray.length(datum.ask.asset_name) <= 32` (and the same for `offer` for
  defense-in-depth). Cheap, unambiguous, and closes the vector at the source.

---

### F-03 — Order creation is permissionless in the owner field → owner-attribution spoofing

- **Severity:** Low / Informational
- **Confidence:** High (proved with an Aiken test; also implicit in every stock create test)
- **Affected files:** `contracts/lib/p2p_dex/beacon_rules.ak`
- **Affected function:** `beacon_rules.mint_beacons_ok`
- **Intended invariant:** I10 (correct attribution).
- **Attack preconditions:** attacker builds a raw creation tx; funds the deposit + offer.
- **Attack construction:** `mint_beacons_ok` never checks that the named owner signed. An
  attacker mints a well-formed order whose owner staking key (and therefore `OwnerBeacon`
  and "My Orders" attribution) is an arbitrary victim's staking key, placed at the
  victim's personal order address. The order is real and fillable.
- **Concrete example:** attacker mints an order with `owner = VerificationKey(<victim
  stake key>)`, `payment_address = <attacker>`; it appears under the victim's "My Orders"
  (queried by OwnerBeacon).
- **Actual result:** `mint_beacons_ok` returns `True` (see
  `audit_permissionless_creation_spoofs_owner`).
- **Impact:** UI-level impersonation / "My Orders" pollution attributed to a third party;
  potential confusion in analytics keyed by owner. **Self-limiting and often
  self-defeating:** the victim can `CancelOrder` (they hold the staking key) and *keep*
  the attacker-funded offer + deposit, so the attacker gifts value to the victim. Not a
  fund-theft vector.
- **Proof of concept:** `audit_permissionless_creation_spoofs_owner` (passes).
- **Recommended fix:** if attribution integrity matters, require the owner staking key in
  `extra_signatories` at mint (`list.has(self.extra_signatories, owner_key_hash)`). Note
  this changes the "anyone can create liquidity on behalf of a key" property — decide
  deliberately. If left as-is, document it and make the frontend label externally-created
  orders. Alternatively accept as designed (it is a known trade-off of permissionless mints).

---

### F-04 — Route/arbitrage planners don't exclude the taker's own orders → wash/self-fill

- **Severity:** Informational
- **Confidence:** High (code review)
- **Affected files:** `backend/src/services/smart-fill.ts`, `backend/src/services/arbitrage.ts`
- **Affected function:** `planSmartFill`, `findArbitrage`
- **Intended invariant:** I10 (meaningful routing).
- **Attack construction:** neither planner filters candidates by owner, so a user's own
  open orders are eligible legs. A user can be routed to take their own order (or an
  arbitrage cycle spanning their own orders), producing wash-trade volume and misleading
  "average price" displays. It is on-chain valid (nothing forbids self-take) and not a
  fund risk, but it distorts the book and any volume metrics.
- **Impact:** wash trading, self-inflated volume, misleading route economics. No theft.
- **Recommended fix:** pass the connected wallet's owner stake key into the planners and
  drop candidates whose `ownerStakeCredential` matches; warn if a route would self-fill.

---

### F-05 — Order discovery cost scales with a self-fundable spam flood → indexer/provider DoS

- **Severity:** Informational / Low
- **Confidence:** Medium (design analysis; not load-tested here)
- **Affected files:** `backend/src/services/order-indexer.ts`
- **Affected function:** `OrderIndexer.doSync`
- **Attack construction:** discovery fetches all `OrderBeacon` holders, then per holder
  fetches UTxOs, validating each. A griefer who mints thousands of orders across many
  personal addresses (F-02/F-03 make each cheap and each address distinct per owner key)
  multiplies provider calls per sync. The deposit is the only limiter.
- **Impact:** Blockfrost/provider quota exhaustion, slow/stale book. Not a fund risk; the
  cache is explicitly not a security boundary and the builder re-validates on-chain.
- **Recommended fix:** cap/paginate holders per sync, cache verified-open orders (already
  partly done via the "open + confirmed ⇒ skip re-verify" short-circuit), and rate-limit.

---

## Suspected / Unconfirmed Findings

- **S-1 (Low, ledger-level) — partial fill can strand an ADA-offer remainder below
  min-UTxO.** A partial take of an ADA-offer order reduces the continuation's lovelace by
  `take_amount`. If the remainder falls below the ledger min-UTxO for a 5-beacon output,
  the tx is rejected by the *ledger* (not the validator). This is a liveness/edge issue,
  not theft; the builder's `PARTIAL_PAYMENT_LOVELACE` doesn't relate to the continuation's
  own floor. Worth a builder-side guard that rejects partials that would underfund the
  continuation. Not exploitable for value.

- **S-2 (Info) — reference-script UTxO trust.** The builder can spend the order validator
  from a configured reference input (`REFERENCE_SCRIPT_TX_ID`). A wrong/malicious
  reference script is caught by the ledger (its hash must match the order address's script
  hash), so this is safe, but an operator misconfiguration silently degrades to inline
  scripts / failures. Verified safe; noted for deployment hygiene.

- **S-3 (Info) — indexer `classifySpend`/`backfillAncestry` rank pairing depends on
  provider output ordering.** `classifySpend` filters beacon-bearing outputs without an
  explicit `sort` by output index (unlike `backfillAncestry`, which sorts). If a provider
  ever returned outputs out of index order, lineage could mislink. Not a fund risk
  (cache only). Recommend sorting there too for parity with the validator's semantics.

---

## Attacks Attempted That Failed (correctly rejected)

These were genuinely constructed (as fixtures/tests or by exact reasoning against the
code) and correctly rejected by the contracts — this is the protocol's strength:

- **Double satisfaction, shared single payment** across two order inputs — rejected: the
  second order's `tagged_payment` finds no output tagged with its `own_ref`
  (`expect [payment]` crashes). Proved by stock `batch_take_double_satisfaction_fails`
  and my novel `audit_two_full_takes_one_doubled_payment_second_fails` (one doubled-value
  payment tagged for only the first order).
- **Untagged / wrong-tagged / duplicate-tagged payment** — rejected
  (`take_payment_untagged_fails`, `take_payment_with_wrong_tag_fails`,
  `take_with_duplicate_tag_outputs_fails`).
- **Underpay / overpay-as-underpay / wrong asset / foreign asset in payment** — rejected
  (`take_underpays_ask_fails`, `take_pays_wrong_asset_fails`,
  `take_payment_with_foreign_asset_fails`, `take_shorts_deposit_return_fails`).
- **Beacon leakage** into change/seller payment/continuation on cancel and take —
  rejected (`*_with_beacon_leakage_fails`, `*_with_beaconed_continuation_fails`).
- **Smuggling a cancel into a batched take** — rejected
  (`cancel_smuggled_into_batch_take_fails`; `only_one_order_input` on cancel).
- **Twin identical partials sharing one continuation / swapped continuations** — rejected
  (`twin_partials_sharing_one_continuation_fails`, `twin_partials_swapped_continuations_fail`).
- **Continuation datum drift** (owner, pair via offer/ask, payment address, version, flag,
  expiration, amounts) — all rejected (`partial_continuation_*_fails`).
- **Partial underpay by one / exhausting the ask / zero / negative / ≥ offer take** —
  rejected (`partial_underpays_by_one_fails`, `partial_exhausting_ask_fails`,
  `partial_take_zero_fails`, `partial_take_negative_fails`, `partial_take_full_amount_fails`).
- **Mixed batch leaving a full-take order's beacons unburned** — rejected
  (`mixed_batch_unburned_beacons_fail_both_runs`); value conservation + count-based beacon
  accounting force the burn even when full and partial legs share identical beacon names.
- **Minting extra/duplicate beacons, two orders per creation tx, beacons to key address,
  wrong script hash, wrong stake cred, script owner, script payment address, offering the
  beacon policy** — all rejected (`beacon_tests.ak`).
- **Counterfeit beacons under a different policy** — invisible: discovery keys on the real
  policy's `OrderBeacon`; the validator trusts `beacon_policy_id` only because the mint
  policy pinned it. A lookalike is undiscoverable and unspendable-as-protocol.
- **Taker-favoring rounding via split fills** — impossible: `ceil` always rounds toward
  the seller (`audit_partial_rounding_never_favors_taker`), and telescoping returns
  exactly the original ask for a fully-consumed order.

---

## Partial Fill Analysis

Implemented, and attacked aggressively. The pricing rule in code is
`required = (take*ask + offer − 1) / offer = ceil(take*ask/offer)`
(`order_rules.required_payment`), mirrored exactly in `datum.ts::requiredPayment`.

- **Rounding direction (I5):** `required*offer ≥ take*ask` for all valid takes — the taker
  can never underpay. Brute-forced over `(offer,ask) ∈ {(100,250),(250,100),(7,3),(3,7),
  (101,100),(2,10^6)}` and all `take ∈ [1,offer)` — no counterexample
  (`audit_partial_rounding_never_favors_taker`).
- **Continuation math (I4):** `offer' = offer − take`, `ask' = ask − required`, value =
  input − taken offer (deposit + beacons retained). The reduced `ask'` uses `required`,
  **not** the actual payment, so overpayment is a pure seller bonus and never cheapens the
  remainder. Both amounts stay strictly positive for accepted takes
  (`take < offer` ⇒ `offer' > 0`; `required < ask` enforced ⇒ `ask' > 0`;
  `audit_partial_continuation_ask_stays_positive`).
- **Telescoping over repeated fills:** for any split that fully consumes the offer (a
  sequence of partials + a final `TakeOrder` on the last continuation), the seller
  receives **exactly** the original `ask_amount`. Intermediate remainders get cheaper
  per-unit (the seller "over-collects" on each ceil, reducing `ask'` more than
  proportionally), but this only ever transfers value *between successive takers*, never
  away from the seller. No accumulation attack.
- **Final-fill semantics:** the exact final fill is a `TakeOrder` (full), which returns
  the deposit; a partial can never be the last unit (`take < offer`, `required < ask`).
- **Min-ADA:** deposit is retained in the continuation on partials; the taker funds the
  payment's min-ADA on token asks (`PARTIAL_PAYMENT_LOVELACE`), any excess is a seller
  gift. See S-1 for the ADA-offer continuation floor edge.

Conclusion: the partial-fill system is economically sound. No taker underpayment, no
seller shortfall, no continuation drift.

---

## Multi-Order / Atomic Execution Analysis

`TakeManyOrders` consumes up to `MAX_ORDERS_PER_TX` (default 8; a builder/tx-size limit,
not a security limit — the validator does not cap it) orders atomically.

- **Order→payment mapping (I2):** injective by `PaymentTag == own_ref`, unique-or-crash.
  N orders need N distinct correctly-valued tagged payments. Identical-datum orders still
  have distinct `OutputReference`s ⇒ distinct tags. Verified with duplicate-value fixtures
  and my doubled-payment variant.
- **Order→continuation mapping (I4):** rank pairing. `partial_take_refs` (canonical
  ascending input order) indexes `beacon_bearing_outputs` (output order), with
  `#outputs == #partial-inputs`. Ranks are distinct (unique refs) and every run computes
  the same lists ⇒ bijection. Two identical orders cannot share one continuation
  (`twin_partials_sharing_one_continuation_fails`); swaps fail
  (`twin_partials_swapped_continuations_fail`). Output *reordering* by the attacker just
  fails a run — it cannot create a many-to-one mapping.
- **Mixing full + partial legs:** beacon accounting is count-based and consistent across
  both rule paths; even when full and partial legs share identical beacon names, value
  conservation forces the correct number of burns (the fungibility of same-named beacons
  makes "which token burns" irrelevant; the *counts* are what's pinned). Proved by
  `mixed_batch_*` tests.
- **Unrelated inputs/outputs before/between/after:** wallet inputs, buyer outputs, and
  change never carry beacons and never carry a `PaymentTag`, so they don't perturb either
  mapping. `beacon_bearing_outputs`/`tagged_payment` filter precisely.

No cross-order confusion, index-permutation, or reuse attack succeeded.

---

## Beacon Integrity Analysis

- **When each script runs:** the mint policy runs on creation (and on any burn); the spend
  validator runs whenever a beacon-bearing UTxO is spent. There is no gap: a beacon can
  only come into existence via `MintBeacons` into one valid order, and can only move by
  spending its order (which runs the spend validator and either burns it or re-locks it in
  an exact continuation). Beacons therefore always live inside valid orders (I3).
- **Name derivation (`beacons.ak`) — verified independently:**
  `Order="order"` (5B); `Pair=sha256(0x00 ++ lp(id_lo) ++ lp(id_hi))`;
  `Offer=sha256(0x01 ++ id)`; `Ask=sha256(0x02 ++ id)`; `Owner=stake key hash` (28B).
  Domain prefixes `0x00/0x01/0x02` separate the three hashes; the length prefix on the
  undirected pair removes the asset-name-boundary ambiguity (two different pairs can't
  collide) — confirmed the concern the doc cites is real and the fix is correct. The five
  names can never collide (lengths 5 / 32 / 32 / 32 / 28 and distinct prefixes), so
  `beacon_set` always has exactly five entries at qty 1. Backend `beacons.ts` mirrors this
  byte-for-byte (known-answer tests on both sides).
- **Cross-policy confusion / counterfeits:** impossible to exploit — the policy is
  parameterized by the order validator hash (`blueprint.ts`), the datum's
  `beacon_policy_id` is pinned at mint, and discovery keys on the real policy. Foreign
  tokens with the same *names* under a different policy are different assets and are
  invisible/inert.
- **ADA representation:** `is_ada` requires *both* empty policy and empty name; a
  malformed `{policy:"", name:"x"}` asset can't exist on-chain, so it can't be held as an
  offer (only makes an unfillable ask — see F-02).

No beacon leak, forge, preserve-when-should-burn, or burn-when-should-continue succeeded.

---

## Double-Satisfaction Analysis

This is the protocol's headline risk and it is **closed on-chain**:

- One payment output cannot satisfy two order inputs (I2, `PaymentTag` uniqueness).
- One receive/continuation output cannot satisfy two partial inputs (rank-pairing
  bijection + `#outputs == #inputs`).
- A payment output and a continuation cannot be the same physical output (mutually
  exclusive datums: `PaymentTag` vs `OrderDatum`).
- Beacons can't be reused as a "home" for a fully-taken order's tokens (count-based
  accounting + value conservation).

I attempted the classic and several novel shapes (shared payment, doubled-value payment,
swapped/merged continuations, mixed legs with colliding names) — all rejected. See
"Attacks Attempted That Failed."

---

## Pricing and Rounding Analysis

Covered in Partial Fill Analysis. Summary: single source of truth for the formula
(on-chain and backend), `ceil` favors the seller, telescoping preserves the exact total
ask, no float anywhere in fund math, bigint throughout (no JS overflow in builder/planner
math; the *display* helpers `ratioToDecimal` are bigint-safe too). The only rounding the
attacker controls is *self-harming* overpayment.

---

## Deposit / Min-ADA Analysis

- Deposit is defined consistently: for ADA offers, `lovelace − offer_amount`; for token
  offers, all the lovelace (`take_ok`, `resolveOrder`, `validateAndMap` agree).
- Full take returns ≥ deposit to the seller (I1); cancel returns everything to the owner's
  discretion (they signed).
- Partial fill retains the deposit in the continuation (never double-counted, never paid
  to the taker). The builder tops up partial token-ask payments to a min-ADA floor as a
  disclosed seller gift.
- No path lets the taker skim the deposit, the buyer accidentally receive it, or the fee
  be subsidized from locked value (fee is paid from the taker's own selected inputs;
  collateral is excluded from coin selection — `attachCommon`).
- Edge: S-1 (ADA-offer continuation could drop below min-UTxO ⇒ ledger-rejected, not a
  theft).

---

## Backend Trust Analysis

Assuming a malicious backend (the correct posture — it's non-custodial and holds no keys,
enforced by `config.assertNoKeyMaterial`):

- **What it CANNOT do (blocked on-chain):** underpay/misroute a *seller's* payment
  (tagged, value-pinned); forge/leak beacons; create invalid orders; drift a
  continuation; violate rounding. The seller is safe regardless of the backend.
- **What it CAN do (F-01):** lie in the preview summary while building a CBOR that spends
  the *taker's/creator's* wallet UTxOs to attacker outputs, sets a hostile change address,
  or adds recipients. The frontend does not re-derive the summary from the CBOR (only the
  fee). It can also select extra wallet inputs (coin selection is over the wallet's own
  UTxOs, so it can't touch *other* users, but it can over-consume the connecting user).
- **What it CANNOT do to other users:** coin selection is restricted to the requesting
  wallet's submitted UTxOs (`attachCommon.selectUtxosFrom(spendable)`), and every tx must
  be signed by that wallet — so a backend cannot move a *non-consenting* user's funds; it
  can only trick the *consenting signer*.

Attack scenarios and where they are caught:

| Scenario | Blocked by validator? | Detected by preview? | Currently prevented? |
|---|---|---|---|
| Backend swaps seller payment address/amount | **Yes** (I1) | n/a | Yes |
| Backend adds recipient draining taker | No | **No** (F-01) | Only wallet dialog |
| Backend sets hostile change address | No | **No** (F-01) | Only wallet dialog |
| Backend over-selects taker inputs | No | Partially (net line) | Only wallet dialog |
| Backend forges/leaks beacons | **Yes** (I3) | n/a | Yes |
| Backend builds invalid order | **Yes** (I7) | n/a | Yes |

---

## Transaction Preview Analysis

`TransactionPreview` decodes the real fee from CBOR (good) but takes all money-movement
claims (`takerNet`, `offered`, `requested`, `paymentAddress`, `orderAddress`, deposit,
beacons) from the backend summary. It surfaces the raw CBOR (copyable) and *warns* that
client-side verification is not implemented — honest, but the warning is easy to ignore.
This is the UX surface of F-01. Recommended fix is in F-01.

---

## Indexer Analysis

- Discovery verifies every candidate against the chain (address = validator + owner stake,
  exact 5-beacon set re-derived, well-formed datum, offered asset present); malformed or
  spoofed-address UTxOs are dropped (`validateAndMap` returns null, try/caught).
- The cache is explicitly not a security boundary; the builder re-fetches and re-validates
  every order at build time (`resolveOrder` re-derives beacons and checks quantities).
- Can it show an unfillable order? **Yes** — via F-02 (oversized ask) it can index an
  order no one can ever take. Otherwise indexed orders are fillable when fresh.
- Robustness: malformed CBOR/datum → skipped (not a crash). Lineage backfill and
  classification replicate the validator's rank pairing; see S-3 for a minor ordering
  parity nit. Stale-open handling and partial-fill continuation surfacing look correct and
  reorg-tolerant.

---

## Smart Fill / Routing Analysis

- Pure, bigint, deterministic; prices compared by cross-multiplication (no float, no JS
  overflow); stable tie-breaks (price, then bigger receive, then orderId).
- Expiry-filtered; positive-amount-filtered; whole-order greedy + at most one marginal
  partial leg; correct `maxTakeForSpend`/`requiredPayment` usage consistent with the
  validator.
- Weaknesses (all non-fund, UX/integrity): **F-04** (no own-order exclusion ⇒ self-fill);
  route is over a *cache* that can be stale between preview and execution (disclosed via
  warnings; on-chain atomicity means a taken-away leg fails the whole batch, so no partial
  economic loss); multi-batch routes are atomic per batch, not across batches (disclosed).
- Arbitrage finder: 2/3-cycles, rate-product prefilter, riskless check (`nets ≥ 0`,
  some `> 0`), fee/min-ADA-adjusted ranking. Same cache-staleness and no-own-order caveats.
  Atomicity claim holds (one `TakeManyOrders` tx per cycle; if any leg is gone the tx
  fails whole). No cycle can leave the wallet fronting assets given the riskless check.

---

## Cross-Protocol Composition Analysis

- The order validator `fail`s on any purpose other than `spend`; the beacon policy `fail`s
  on any purpose other than `mint`. No withdraw/publish/stake tricks.
- Interacting from another protocol: an external script input in the same tx doesn't
  perturb the order/beacon rules (they filter by this validator's payment credential and
  this policy's tokens). A foreign mint doesn't affect beacon accounting (keyed on the
  beacon policy). Cancel's `only_one_order_input` prevents batching a cancel with anything
  at this validator.
- The offer/ask assets are forbidden from being under the beacon policy, so no
  self-referential asset confusion.

No composition attack found.

---

## Denial-of-Service Analysis

- **On-chain:** unspendable UTxOs (no parseable datum) are permanently locked *by design*
  and only harm their creator. Oversized datums/values are bounded by ledger limits.
  Pathological batches are bounded by tx size/ex-units (and the builder's
  `MAX_ORDERS_PER_TX`).
- **Off-chain:** F-05 (spam flood inflating discovery cost / provider quota) and F-02
  (unfillable spam) are the realistic DoS levers; both are deposit-limited and cache-only.
  The indexer has overlap guards, an on-demand cooldown, and a short-circuit for
  already-confirmed-open orders.

---

## Test Coverage Gaps

The stock suite is unusually thorough (130 tests) and covers double satisfaction, tag
manipulation, beacon leakage/forgery, continuation drift, rounding edges, mixed batches,
and expiry. Gaps I'd add:

1. **On-chain asset-identifier length bounds** (F-02) — no test asserts rejection of an
   oversized `ask` (my test proves it is *accepted*).
2. **Owner-signature-at-mint** (F-03) — no test pins whether creation requires the owner's
   consent (currently it does not).
3. **Frontend CBOR-vs-summary equivalence** (F-01) — no client-side test decodes the built
   tx and asserts it matches the preview.
4. **ADA-offer continuation min-UTxO** (S-1) — no builder test for a partial that would
   underfund the continuation.
5. **Own-order exclusion** in planners (F-04).

---

## Remaining Unknowns

- No live preprod submission was possible in this environment (no funded keys/provider
  key), so exact ex-unit/size limits for large batches and the real min-UTxO floors were
  reasoned about, not measured. `MAX_ORDERS_PER_TX=8` is unverified against on-chain
  budgets (the repo says "raise only after measuring").
- Wallet-extension behavior (what CIP-30 dialogs actually render for these txs) is the
  practical backstop for F-01 and was not tested against real wallets here.
- Provider (Blockfrost/Kupo) output-ordering guarantees (relevant to S-3) not verified.

---

## Mainnet Readiness Verdict

**PREPROD TESTING ONLY.**

The on-chain contracts are strong and close to external-audit quality — I found no
value-stealing on-chain exploit, and the double-satisfaction, beacon-integrity, and
partial-fill systems withstood adversarial construction. However:

- **F-01 (High, scoped)** means users currently trust the backend with their *own* funds;
  this must be closed (client-side CBOR verification and/or build attestation) before any
  real value, and certainly before mainnet.
- **F-02 / F-03** are cheap on-chain hardenings worth doing while the contract is still
  unfrozen (asset-id length bounds; decide the owner-signature-at-mint policy explicitly).
- **F-04 / F-05 / S-1 / S-3** are off-chain hygiene items.

Do not treat passing tests as proof of safety: the suite is excellent but did not (until
this audit) probe asset-identifier bounds, creation authorization, or the preview trust
gap. After F-01 is fixed and F-02/F-03 are decided, this is a strong candidate for
**READY FOR EXTERNAL AUDIT**.
