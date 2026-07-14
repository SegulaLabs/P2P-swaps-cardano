# MVP Contract Decisions

**Status: DECIDED — this document is the implementation contract for the first
real version of the beacon minting policy and order spending validator.**
Where it conflicts with older text in protocol-spec.md, this document wins
(the spec gets folded in when implementation starts).

Decision date: 2026-07-06. Sources checked: the fallen-icarus/cardano-swaps
README (fetched), CIP-0089 "Distributed DApps & Beacon Tokens" (fetched —
status **Active**, authors fallen-icarus & zhekson1), the Blockfrost OpenAPI
spec (fetched; endpoints verified by grep), the pinned Aiken stdlib v2.2.0
source (verified locally: `sha2_256`, `blake2b_224`, `aiken/interval`), and
meshjs.dev / Anastasia-Labs/lucid-evolution (fetched; both actively
maintained as of June 2026).

**MVP action set: `CreateOrder`, `CancelOrder`, `TakeOrder`. UpdateOrder is
postponed (§7). One order input per transaction (§8). Full fills only.**

---

## Implementation status (2026-07-06)

**Implemented and tested.** §1–§6, §8: on-chain rules live in
`contracts/lib/p2p_dex/{beacons,beacon_rules,order_rules}.ak` with thin
validator wrappers; 77 Aiken tests pass (`aiken check`), covering the §11
adversarial lists. §9/§10: Mesh + Blockfrost implemented in the backend
(59 vitest tests), including the cross-tool check that Mesh's
`applyParamsToScript` reproduces `aiken blueprint apply`'s policy id exactly.
v1 identities: order validator
`89389051eeb86f5fd564794238a2ffd708ea6e0431ec273fbd2346ab`, beacon policy
`264ed623c0565099c5b856adc3fe6f173d0a901a0d49edb8f218cc0a`.

> **2026-07-07 — protocol v2 (TakeManyOrders) supersedes §8 on the Take
> path.** One tx may now take MANY orders atomically; double satisfaction is
> closed by per-order output tagging (each payment output carries an inline
> `PaymentTag` naming the consumed order's `OutputReference` — the §2 upgrade
> path, exactly). Cancel keeps the one-input rule. The §2 "no datum on the
> payment output" rule is replaced by the tag, and the "exactly one output at
> payment_address" rule by tag uniqueness (untagged extras at the seller's
> address are now harmless gifts; self-takes work). New identities: order
> validator `4d0a13355316e80d8addbc93c7bf2fba1a4a6563e6097e87c11794b8`,
> beacon policy `a88c60a8e8be899466eff52542ee57fd728540be1ed59d4e3ca2c9b0`.
> Design, adversarial tests and the live preprod proof:
> **[take-many-orders.md](take-many-orders.md)**. This document otherwise
> still governs; where they differ on TakeOrder, take-many-orders.md wins.

**Implementation deviations / refinements (all tightenings, no relaxations):**

1. **PairBeacon encoding adds length prefixes** (§3): name =
   `sha2_256(#"00" ++ lp(id_lo) ++ lp(id_hi))` where `lp(x)` prepends one
   length byte. Reason: without it, the variable-length asset-name boundary
   lets two *different* pairs produce the same concatenation (datum assets
   need not exist on-chain, so this was exploitable for order-book spam).
   Offer/Ask names are unchanged (a single id parses unambiguously — policy
   ids are fixed 28 bytes).
2. **The payment output must carry NO datum** on TakeOrder (§2 said "no datum
   required"; enforcement + test added — keeps previews and future
   output-tagging unambiguous).
3. **Beacon-policy assets are untradeable**: `offer.policy_id` and
   `ask.policy_id` must differ from the beacon policy id (minting rule).
   Beacons are worthless tags; allowing them as trade legs would tangle the
   burn-all invariant.
4. **ADA-offer lovelace floor at mint**: when the offer is ADA, the order's
   lovelace must be ≥ `offer_amount` (deposit cannot be negative).
5. **Deposit sizing** (§1): the tx-builder uses a configured
   `ORDER_DEPOSIT_LOVELACE` (default 3.5 tADA), slightly over-provisioned vs
   the ledger min-UTxO instead of computing it per-output; the excess returns
   to the seller on take / owner on cancel. Revisit post-MVP
   (open-questions #15).
6. **Data encodings pinned**: redeemers `CancelOrder`=Constr 0,
   `TakeOrder`=Constr 1, `MintBeacons`=Constr 0, `BurnBeacons`=Constr 1;
   `Bool` False=Constr 0/True=Constr 1; owner/payment credentials
   `VerificationKey`=Constr 0. Mirrored in `backend/src/protocol/datum.ts`
   with round-trip tests.

---

## 1. Deposit / min-ADA / return rule

**Definitions.** Every order UTxO holds a lovelace *deposit* on top of the
offered asset. On-chain, the deposit is computed from the order input itself:

```
deposit = lovelace(order_utxo)                     if offer is a native asset
deposit = lovelace(order_utxo) − offer_amount      if offer is ADA
```

**Decisions:**

- **On create:** the creator locks `offer_amount` of the offer asset plus a
  deposit. The deposit's size is whatever the ledger's min-UTxO rule demands
  for this order UTxO (5 beacons + asset + inline datum ⇒ roughly 2 ADA),
  computed by the tx builder at build time from live protocol parameters —
  never hardcoded. The minting policy does **not** enforce a deposit floor;
  the ledger already does exactly that.
- **On cancel:** the owner signed the tx, so the validator does not constrain
  where value goes — offer and deposit return to wherever the owner directs
  (their wallet). No rule needed beyond beacon destruction (§5).
- **On take:** the **deposit is returned to the seller**, inside the payment
  output: the taker must send `ask_amount` of the ask asset **plus the
  deposit's lovelace** to `payment_address` (§2). The **buyer receives the
  offered asset only** — no ADA bonus (when the offer *is* ADA, the offered
  ADA is of course what they receive).
- **Seller receives:** requested asset + returned deposit, in one output.

**Why this is safest for MVP:** the seller never bleeds ADA per filled order
(market makers would otherwise lose ~2 ADA per fill); the taker is
value-neutral (the deposit they "pay" to the seller comes out of the consumed
order UTxO); and the returned deposit conveniently satisfies the payment
output's *own* min-ADA when the ask is a native token, so takers need no
extra ADA. Contrast: cardano-swaps keeps the deposit in its continuation UTxO
(reclaimed at close) — that fits their partial-fill model, not our
full-fill-and-burn model, which has no continuation UTxO to keep it in.

## 2. Payment output shape on TakeOrder

**Decision: exactly one output, exact asset amount, no extras.**

The TakeOrder branch requires the tx to contain **exactly one output whose
address equals `payment_address`** (full address equality, payment + staking
part), and that output's value must be exactly:

| ask asset | required value of the payment output |
|---|---|
| native token | `ask` == `ask_amount` **exactly**; lovelace ≥ `deposit`; **no other native assets** |
| ADA | lovelace ≥ `ask_amount + deposit`; **no native assets** |

- **Exact, not "at least", for the ask asset:** overpaying has no legitimate
  use, and exactness makes the validator check, the tests, and the client-side
  `TransactionPreview` all trivially explainable ("this output IS the seller
  payment, and it contains exactly what the datum says").
- **Lovelace uses ≥:** min-ADA rounding must never make an honest tx fail.
  Extra lovelace only benefits the seller.
- **No merging with other assets:** the payment output may not carry unrelated
  tokens. This keeps previews unambiguous and closes accounting games where a
  "payment" doubles as something else.
- **No datum is required on the payment output** in MVP; output tagging (a
  datum naming the consumed order's `OutputReference`, cardano-swaps'
  `prev_input` approach — verified in their README) is the designed upgrade
  path when batch fills are allowed post-MVP.
- **Double satisfaction** is prevented by the one-order-input rule (§8), which
  makes "the one payment output" unambiguous.
- **Builder constraint (off-chain):** the tx builder must ensure the taker's
  change address is never equal to `payment_address` (self-takes or wallet
  quirks could otherwise merge change into the payment output and break the
  "exactly one output" rule). Tracked as open-questions #23.
- **`payment_address` must have a key (not script) payment credential** —
  enforced at mint time (§4). This prevents orders whose payout is stuck at a
  datum-less script and keeps MVP free of script-to-script interactions.

## 3. Beacon lifecycle

**Final token-name derivation** (all inside one minting policy; `asset_id` =
`policy_id ++ asset_name`; ADA = empty policy id ++ empty name; hash output is
32 bytes = the token-name limit; `sha2_256` verified present in stdlib):

| Beacon | Token name |
|---|---|
| OrderBeacon | constant ASCII `"order"` (`6f72646572`) |
| PairBeacon  | `sha2_256(#"00" ++ asset_id_A ++ asset_id_B)` with A, B the offer/ask asset ids **sorted lexicographically** (undirected — one name per pair, both book sides) |
| OfferBeacon | `sha2_256(#"01" ++ offer_asset_id)` |
| AskBeacon   | `sha2_256(#"02" ++ ask_asset_id)` |
| OwnerBeacon | the owner's 28-byte staking key hash, verbatim |

This follows cardano-swaps' scheme (verified: they use
`sha2_256("01"/"02" ++ …)` for offer/ask) with two deliberate differences: our
pair beacon is **undirected and domain-prefixed** (`#"00"`), and we add the
constant OrderBeacon and per-owner OwnerBeacon.

**Lifecycle per action:**

| Beacon | CreateOrder | CancelOrder | TakeOrder | UpdateOrder |
|---|---|---|---|---|
| OrderBeacon | mint 1 into order UTxO | **burn** | **burn** | — postponed (§7) |
| PairBeacon  | mint 1 into order UTxO | **burn** | **burn** | — |
| OfferBeacon | mint 1 into order UTxO | **burn** | **burn** | — |
| AskBeacon   | mint 1 into order UTxO | **burn** | **burn** | — |
| OwnerBeacon | mint 1 into order UTxO | **burn** | **burn** | — |

With UpdateOrder postponed, the invariant becomes total and simple:
**every spend of an order UTxO destroys all five of its beacons.** The
validator enforces this not as "check a burn" but as the stronger, composable
formulation: **no output of the transaction may contain any token of
`beacon_policy_id`** (§5/§6) — value conservation then forces the burn, and
beacons can never leak into change, other scripts, or fake orders. A pleasant
consequence: the spending validator never derives a single beacon name (no
hashing at spend time); only the minting policy hashes, once, at creation.

## 4. CreateOrder validation (beacon minting policy, `MintBeacons`)

Creation is enforced entirely here — the spending validator does not run when
a UTxO is created. The policy is parameterized by the order validator's script
hash (`order_script_hash`); it knows its own policy id from the mint context.

The `MintBeacons` redeemer succeeds iff **all** of the following hold:

1. **Exactly one output** in the tx contains tokens of this policy (one order
   created per tx in MVP — keeps ex-units and tests small; relaxable later
   because all checks below are already per-output).
2. That output's address has **payment credential = `order_script_hash`** and
   **staking credential = `datum.owner`** (the CIP-0089 personal-address
   pattern, verified in the CIP text: the owner keeps delegation authority
   over the locked value, and every owner gets their own order address while
   sharing one validator).
3. The output carries an **inline** `OrderDatum` (not a datum hash) with:
   - `version == 1`
   - `beacon_policy_id ==` this policy's own id
   - `owner` is a **VerificationKey** staking credential (script owners are
     post-MVP)
   - `payment_address` has a **VerificationKey payment credential** (§2)
   - `offer != ask` (as full asset ids), `offer_amount > 0`, `ask_amount > 0`
   - `allow_partial_fill == False`
   - `expiration`: no on-chain check (`Some(t)` with `t` in the past is
     self-harm only — the order is immediately untakeable and cancellable;
     documented footgun, the frontend should warn)
4. The output's value is **exactly**: the five beacons of §3 (amount 1 each,
   names derived from this datum) + `offer_amount` of `offer` + the lovelace
   deposit — **and nothing else**. (When offer is ADA: exactly lovelace +
   the five beacons, lovelace ≥ `offer_amount`.)
5. The tx's **total mint under this policy is exactly those five names, +1
   each** — all positive, no other names, no mixed burns. (Cancel-and-recreate
   in one tx is therefore impossible in MVP; it costs two txs. Accepted.)

The `BurnBeacons` redeemer succeeds iff **every** amount of this policy in the
mint field is **strictly negative**. Burning needs no other constraint:
beacons only exist inside order UTxOs (guaranteed above + §5/§6), and spending
those always runs the order validator.

## 5. CancelOrder validation (order spending validator)

1. `datum.owner` is a VerificationKey credential and its key hash is in the
   tx's `extra_signatories`. (Datum fields are trustworthy because the minting
   policy validated them at creation — the §4 trust chain.)
2. **Exactly one input** in the tx sits at this validator's payment credential
   (§8 — applies to Cancel too; multi-cancel is post-MVP).
3. **No output of the tx contains any token of `datum.beacon_policy_id`**
   (forces the full 5-beacon burn via value conservation).

Nothing else: the owner signed, so value routing is their business.

Note on garbage UTxOs at the validator address: a UTxO whose datum does not
parse as `OrderDatum` is permanently unspendable (the `expect` fails on every
path) — anyone sending funds there without our tx builder loses them; this is
standard for datum-carrying protocols and cannot trap a *valid* order. A UTxO
with a well-formed datum but **no beacons** (someone imitating an order
without minting) is invisible to beacon-driven discovery and remains spendable
by its "owner" via Cancel — harmless.

## 6. TakeOrder validation (order spending validator)

1. **Exactly one input** at this validator's payment credential (§8).
2. Defensive datum re-checks (cheap): `version == 1`,
   `allow_partial_fill == False`.
3. **No output of the tx contains any token of `datum.beacon_policy_id`**
   (full burn; also makes "no unauthorized continuation order" automatic —
   a beacon-less output at the validator address is just the taker donating
   money, not an order).
4. **Exactly one output at `payment_address`** with the exact value of §2
   (ask exactly, deposit-return lovelace, no foreign assets).
5. If `expiration == Some(t)`: the tx validity interval's **upper bound is
   finite and ≤ t** (the taker proves non-expiry; exact inclusive/exclusive
   handling per `aiken/interval` is settled in implementation with a test).
6. No signature requirement — anyone may take.

The buyer's side needs no check: the taker builds the tx, so the offered asset
goes wherever they direct it; value conservation is the ledger's job.

## 7. UpdateOrder: **POSTPONED** (not in MVP)

Rationale:

- **Equivalent functionality exists**: cancel + recreate does the same job in
  two txs with zero additional on-chain logic; the only cost is one extra tx
  fee and a brief off-book gap.
- **It would be the only path where beacons survive a spend.** Removing it
  makes "every spend destroys all beacons" a total invariant, which collapses
  the leakage analysis (§3) and roughly halves the adversarial test surface.
- **Datum-diff checks are the riskiest kind of validator code** ("new datum
  equals old except fields X,Y") — historically where continuation-style bugs
  live. Not worth it for a convenience feature in a first deployment.

Consequences: the `UpdateOrder` redeemer is **removed from the MVP types**
(not kept as an always-fail branch — dead code in a script only adds size and
audit surface; a future v2 adding it is a new script hash and thus a new
protocol version regardless). `POST /tx/update-order` stays as a 501 stub in
the backend scaffold, documented as post-MVP; the frontend's Update button
stays disabled.

## 8. One-order-per-transaction rule — verified sufficient for MVP

**Rule:** every spending path requires exactly one input at the order
validator's payment credential (counted in the validator itself, using its own
script hash resolved from its own input).

**Why it is sufficient:** double satisfaction needs two script inputs whose
validators can be "paid" by one shared output. With exactly one order input,
the §6 payment check is unambiguous. Cross-*protocol* composition (our order
spent alongside some other DApp's UTxO) cannot hurt *our* seller: the exact
payment output must exist regardless of what else the tx does — if some other
protocol lets that same output satisfy it too, that's the other protocol's
under-constraint, and MVP's answer is documented: our seller is still made
whole. Full uniqueness (output tagging with the consumed `OutputReference`,
as cardano-swaps does with `prev_input`) is the designed post-MVP upgrade and
becomes necessary exactly when batch fills are allowed.

**What it blocks:** batch takes (N orders, one tx), batch cancels, atomic
cancel+take arbitrage, one-tx migration flows. None are MVP features.

**What it simplifies:** the payment check is provably single-target; tests
shrink (no combinatorial multi-input cases); ex-units stay low; the
`TransactionPreview` story is one sentence ("this tx consumes exactly one
order and pays its seller exactly X").

## 9. SDK decision: **Mesh SDK**

Both candidates were checked and are healthy (Mesh: 1M+ downloads, active
feature releases; Lucid Evolution: 564 releases, latest June 13 2026 —
actively maintained by Anastasia Labs). Comparison for *this* project:

| Criterion | Mesh | Lucid Evolution |
|---|---|---|
| Aiken / CIP-57 blueprints | ✅ blueprint support, `applyParamsToScript` | ✅ equivalent |
| Browser wallet (CIP-30) | ✅ + **ready-made React hooks/components** | ✅ API only, UI hand-rolled |
| Unsigned-tx handoff (backend builds, wallet signs) | ✅ MeshTxBuilder produces unsigned CBOR | ✅ equivalent |
| Plutus script txs (mint + spend + redeemers + inline datums) | ✅ | ✅ (somewhat lower-level control) |
| Reference scripts | ✅ | ✅ |
| Next.js ergonomics | ✅ first-party guides, React-first design | neutral (framework-agnostic) |
| Provider flexibility | ✅ Blockfrost/Koios/Maestro/Ogmios/U5C behind one interface — mirrors our `ChainProvider` plan | ✅ similar incl. Kupmios |
| Long-term maintainability | active, large user base | active, strong team |

**Decision: Mesh**, matching the stated preference (faster frontend/wallet
integration) — no blocker found. The React wallet layer and first-party
Next.js path remove the largest chunk of hand-rolled code in our stack
(`lib/wallet.ts` disappears into `@meshsdk/react`). Lucid Evolution is the
documented fallback; the **switch trigger** is if the pre-implementation spike
(open-questions #21) shows MeshTxBuilder cannot cleanly build server-side
transactions from wallet-supplied UTxOs (CIP-30 `getUtxos()` CBOR) with
script mint + spend in one tx. Nothing is implemented yet; this is a decision
document only.

## 10. Indexer/provider decision: **Blockfrost** for MVP preprod

Verified against the Blockfrost OpenAPI spec (grep over the fetched YAML):

- `GET /assets/{asset}/addresses` — who holds a beacon → order discovery ✅
- `GET /addresses/{address}/utxos/{asset}` — the beacon-holding UTxOs ✅
- `GET /assets/policy/{policy_id}` — every beacon name in existence (full
  sync / pair enumeration) ✅
- `GET /assets/{asset}/history|transactions` — status transitions ✅
- `POST /tx/submit` (CBOR) — signed-tx relay ✅
- Preprod base URL `https://cardano-preprod.blockfrost.io/api/v0` ✅
- Pagination `page`/`count` (max 100), rate limit 10 req/s (burst 500) —
  indexer polling cadence must budget for this.

| Option | Verdict for MVP |
|---|---|
| **Blockfrost** | **Chosen.** Endpoints verified sufficient; free tier adequate for preprod; already scaffolded; first-class Mesh provider. |
| Maestro | Capable paid alternative; nothing it adds is needed for MVP. Revisit if Blockfrost rate limits bite. |
| Koios | Free/community fallback; keep behind `ChainProvider` as plan B. |
| Kupo/Ogmios | Deliberately later (self-hosted stage) — placeholders and migration plan already in `infra/` and deployment.md §7. |

## 11. Contract implementation order

Beacon **policy before** order validator — creation is the root of trust, and
every validator test needs a validly-created order fixture anyway.

1. **`lib/p2p_dex/beacons.ak`** — pure name-derivation functions (§3).
   Tests: known-answer vectors, sort-order symmetry
   (`pair_name(a,b) == pair_name(b,a)`), ADA encoding, 32-byte length.
2. **Beacon policy — `MintBeacons`** (§4). Adversarial tests **first**, in
   this order (highest-value attacks first):
   a. mint into an address whose payment credential ≠ order validator
   b. beacon set wrong: missing one / extra one / amount 2 / extra name
   c. token names not matching the datum (wrong pair/offer/ask/owner name)
   d. datum attacks: not inline, `beacon_policy_id` ≠ own id, script owner,
      script `payment_address`, `offer == ask`, zero/negative amounts,
      `allow_partial_fill == True`, wrong version
   e. value attacks: offered asset missing/short, stray foreign tokens
   f. two order outputs in one tx; mint mixed with burn
   then the single happy-path test.
3. **Beacon policy — `BurnBeacons`**: any positive amount under this redeemer
   fails; pure burn passes.
4. **Order validator — `CancelOrder`** (§5; simplest spend path): non-owner
   signer fails, missing signature fails, beacon smuggled into any output
   fails, two order inputs fail; happy path.
5. **Order validator — `TakeOrder`** (§6): underpay / wrong address / wrong
   asset / payment split across two outputs / foreign tokens in payment
   output / deposit not returned / expired (upper bound > t, or no upper
   bound) / beacon smuggling / two order inputs; happy paths for token↔token,
   ADA→token, token→ADA.
6. **`aiken build`** + parameter application (`aiken blueprint apply`, #12) +
   record hashes; property tests over amounts/assets if time allows.
7. Only after all of the above: off-chain work (indexer, then tx-builder).

Test tooling: evaluate SIDAN Lab's `vodka`/mocktail helpers for building
`Transaction` fixtures in Aiken tests before hand-rolling (open-questions
#22).

## 12. Open-questions cleanup

Done in [open-questions.md](open-questions.md): items 1–7, 9, 13, 16, 19, 20
are resolved with links here; 8, 12, 14 (narrowed), 15, 17, 18 remain open;
new items #21 (Mesh server-side build spike), #22 (Aiken test-fixture
library), #23 (change-address ≠ payment_address builder rule), #24
(interval bound inclusivity test) added.
