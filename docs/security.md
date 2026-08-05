# Security Notes & Threat Model (MVP)

Scope: preprod MVP. **Nothing here has been audited.** Do not deploy to
mainnet. Items marked ⚠ are unresolved — tracked in
[open-questions.md](open-questions.md).

## 0. Implemented mitigations (2026-07-06 MVP pass)

On-chain, each with adversarial Aiken tests (77 total pass):
- Creation gate: beacons mint only into a single, fully validated order
  output at the validator address with the owner's staking credential
  (counterfeit/missing/renamed/extra beacon sets all fail).
- Every spend requires **zero protocol beacons across all tx outputs**
  (leakage, fake continuations, and smuggling all fail).
- One-order-input rule on every spend path (double-satisfaction guard, §2.1).
- TakeOrder: exactly one payment output, ask amount exact, deposit-return
  lovelace floor, no foreign assets, no datum, expiration via finite validity
  upper bound.
- CancelOrder: owner staking-key signature required.

Off-chain:
- Boot guards: `CARDANO_NETWORK=preprod` only; key-material env vars
  (PRIVATE_KEY/MNEMONIC/SEED…) abort boot; Blockfrost id must be preprod.
- Backend returns unsigned CBOR only; wallet signs; coin selection uses only
  the requesting wallet's own UTxOs; collateral only from the wallet.
- Tx-builder re-fetches the order UTxO on-chain and re-verifies datum +
  beacon set before building (cache never trusted on fund paths).
- Change-address ≠ payment-address guard on take (#23) — and the validator
  independently rejects the two-output case.
- Indexer re-derives beacon names from datums and drops mismatches.
- UI: preview before every signature with un-hidable warnings (not audited /
  preprod only / backend not trusted / summary-based preview), explicit
  confirm step (tested to never auto-sign), no Update surface.

## 0.1 Live preprod verification (2026-07-07)

The full flow ran against **real preprod** with two funded wallets
(`e2e/smoke.ts`): CreateOrder → discovery → TakeOrder → CreateOrder →
CancelOrder, all on-chain assertions passing (exact beacon set, exact
deposit, exact payment, beacon burn, stake-key authorization, correct
buyer/seller balance deltas). Full account: open-questions.md #25.

Four real bugs surfaced and were fixed as a direct result — each a class of
issue unit tests structurally cannot catch (real Blockfrost index behavior,
real Mesh wallet-SDK gaps, real ledger validation):
- A collateral UTxO could be silently double-used as a spending input,
  producing transactions the ledger rejects (`NoCollateralInputs`).
  Collateral is now excluded from coin selection and made mandatory.
- Spent-order detection (`getUtxo`) never actually checked spent status,
  which could let the backend attempt to build against a dead input instead
  of cleanly 404ing. Fixed via Blockfrost's `consumed_by_tx` field.
- Indexer spend classification went through two wrong designs (asset-history
  search misses burn-only txs; payment-shape heuristics false-positive on
  self-cancels) before landing on reading the actual on-chain redeemer
  constructor — the only unambiguous signal.
- Confirmed CancelOrder's stake-key authorization is validator-correct, but
  found Mesh's *headless* test wallet cannot produce that witness (a Mesh
  gap, not a contract bug) — real CIP-30 wallet behavior still needs
  checking (open-questions #29).

**Remaining known gaps** (all tracked): stake-key signing unverified on a
real browser wallet (#29), summary-based preview (#32), beta wallet UI lib
(#31), rollback replay (#18), deposit over-provisioning (#15), wallet can't
prove preprod (#33).

## 0.2 Live user-reported bug: oversized collateral (2026-07-11)

A wallet holding ~16,000 tADA across many UTxOs hit a bare `"UTxO Balance
Insufficient"` on TakeOrder. Two rounds of hypothesis-driven fixes (a backend
diagnostic error, then a CIP-30 pagination fix — both real gaps, see below,
but not the cause) left the error byte-identical on retry; that repetition
was the signal to stop guessing client-side and verify the wallet's actual
on-chain UTxO set directly via Blockfrost.

**Root cause:** the "collateral" UTxO the app was using was oversized —
worth nearly the entire wallet balance in the observed case. Collateral must
be excluded from the spending-input set (a hard ledger rule; the original
form of this class of bug is §0's collateral-double-use fix), so an
oversized collateral pick silently removed most of the wallet's funds from
coin selection before it ever ran, reproducing the insufficient-balance
failure on a genuinely well-funded wallet. Collateral is supposed to stay
small (a few ADA — it's only ever burned on script failure); nothing
previously enforced that.

**Fix:** `frontend/lib/walletAdapter.ts` `pickCollateral(walletReported,
utxos)` trusts the wallet-reported collateral UTxO only if it's
≤ 20 ADA (`MAX_REASONABLE_COLLATERAL_LOVELACE`); otherwise it substitutes the
smallest pure-ADA UTxO from the wallet's own UTxO set (logging a warning),
falling back to the wallet-reported UTxO only if no smaller pure-ADA UTxO
exists at all. `hooks/useTxFlow.ts` now calls this instead of accepting the
wallet's collateral response — or the old first-match `findPureAdaUtxo` — 
unconditionally. Confirmed working live (successful submission) after the
fix.

Two secondary hardening fixes landed from the same investigation — real gaps,
but neither was the actual cause:
- **Backend** (`tx-builder.ts`): `.complete()` failures from
  `@cardano-sdk/input-selection` used to surface as a bare, numberless 500.
  `describeInsufficientFunds()` translates the four known
  `InputSelectionFailure` strings into a `422 insufficient_funds` error
  reporting the backend's own view of spendable UTxO count / lovelace /
  per-asset totals (collateral excluded) — the fastest way to distinguish "the
  wallet only exposed a partial UTxO set to this dApp" from "you're actually
  short on this order's specific ask asset."
- **Frontend** (`walletAdapter.ts`): Mesh's `getUtxosMesh()` wrapper doesn't
  paginate. Some wallets cap what a single unpaginated `getUtxos()` call
  returns once an address has accumulated many small UTxOs — plausible here,
  since this protocol mints a fresh ~3.5 ADA deposit UTxO on every take/cancel.
  `fetchAllUtxoCborPaginated()` pages through the raw CIP-30
  `getUtxos({page, limit})` surface (with stuck-pagination detection, falling
  back to the single-call path on any failure) so the builder sees the
  wallet's full UTxO set regardless.

Tracked in [open-questions.md](open-questions.md) #38.

## 1. Trust model

| Component | Trusted with | Explicitly NOT trusted with |
|---|---|---|
| On-chain scripts | All fund-safety invariants | — |
| Browser wallet (CIP-30) | Keys, signing, collateral | — |
| Backend API | Availability, cache freshness, correct *unsigned* tx construction | Keys (never has them), funds (never holds them), truth (chain is source of truth) |
| Indexer/PostgreSQL | UX-level order visibility | Fund safety (it's a cache) |
| Frontend | Rendering, preview | Enforcing anything |

Design rule: **a fully malicious backend must not be able to steal funds from
a user who reviews what they sign.** It could lie about the order book or
build a hostile transaction — mitigation is client-side: the
`TransactionPreview` component decodes the unsigned tx CBOR in the browser and
shows inputs/outputs/mint before the wallet prompt, and the wallet shows its
own summary. ⚠ The preview must decode independently of the backend's claims.

## 2. On-chain threats and mitigations

### 2.1 Double satisfaction (the classic eUTxO attack)
If two order UTxOs from the same seller (same `payment_address`, same ask) are
spent in one tx, a single payment output of `ask_amount` could "satisfy" both
validators' payment checks — the attacker keeps one order's assets for free.

**MVP mitigation (decided): every spending path — Cancel included — rejects
any tx with more than one input at the order validator's payment credential.**
Crude but airtight; it only blocks batch operations (non-goals for MVP).
Verified sufficient in [mvp-contract-decisions.md](mvp-contract-decisions.md)
§8, including the cross-protocol composition analysis. The upgrade path is
output tagging (payment outputs carry a datum naming the consumed order's
output reference — cardano-swaps' `prev_input` mechanism, confirmed from
their README), required exactly when batch fills arrive post-MVP.

### 2.2 Fake orders / garbage datums
Spending validators don't run at creation, so garbage UTxOs at the validator
address are unpreventable. Mitigations: beacon-driven discovery only (garbage
has no beacons — the minting policy refuses to mint into malformed outputs);
indexer re-validates beacon set + datum before caching; takers' txs are built
against verified UTxOs.

### 2.3 Beacon leakage
Tokens moving don't trigger minting policies. Every spending path must burn
beacons or force a valid continuation output — otherwise an attacker could
park real beacons in a fake "order" at an arbitrary address and phish
indexers. Covered in the validator rules for all three redeemers; must be
covered by tests before any deployment.

### 2.4 Unauthorized cancel/update
Cancel/Update require the owner's staking-credential key in
`extra_signatories`. MVP restricts owners to key credentials; accepting script
credentials without running the script would be a hole, so they are rejected
at mint time. ⚠ (Script-owner support via the withdraw-0 pattern is future
work.)

### 2.5 Take-time value games
- Taker must pay `ask_amount` of the ask asset **to `payment_address`** — paying
  the wrong address, wrong asset, or rounding down must fail.
- Taker could attach the payment as many small outputs; the check must sum
  outputs to `payment_address` (or require a single payment output — simpler,
  ⚠ decide and test).
- Deposit (min-ADA) return: spec says taker returns it with the payment, so
  sellers don't bleed ADA per order. ⚠ Confirm exact rule.
- `expiration` uses the tx validity interval; a taker can't fake time because
  the node enforces the interval at admission.

### 2.6 Dust / spam orders
Min-ADA makes mass spam costly but tiny real orders are still possible.
MVP accepts this (front-end can filter); no on-chain minimum order size.

### 2.7 Contention & race conditions
Two takers racing for one UTxO: one tx fails harmlessly. UX handles it;
no funds at risk. The frontend should refetch and offer the next-best order.

## 3. Off-chain threats and mitigations

- **Key handling: there is none.** The backend has no wallet, no signing code,
  no key storage. Any PR adding key material to the backend must be rejected.
- **Unsigned-tx tampering** (malicious/compromised backend): see §1 —
  client-side preview + wallet display. Never auto-sign; never request
  `signTx` with partial-sign hiding outputs.
- **Indexer poisoning**: indexer only trusts chain data; it re-derives beacon
  names from datums and drops mismatches. API responses carry the UTxO ref so
  the tx-builder re-fetches and re-validates the real UTxO at build time
  (don't build from cache alone).
- **Secrets**: chain-provider keys (Blockfrost project id / Koios token) live
  in env vars or the runtime settings file (`backend/data/settings.json`,
  gitignored), never in the repo, never sent to the browser except back to
  the operator's own Settings page (docs/deployment.md §7). Frontend talks
  only to our backend.
- **CORS/rate limiting**: lock CORS to the frontend origin; rate-limit tx
  endpoints (they're compute-heavy). Standard, but scaffolded from day one.
- **SQL**: parameterized queries only (`pg` with placeholders).

## 4. What makes this non-custodial (checklist)

- [x] Funds only ever sit in (a) user wallets, (b) order UTxOs spendable only
      via validator rules that the *owner* or a *paying taker* satisfies.
- [x] No admin redeemer, no upgrade key, no pause switch that touches funds.
- [x] Backend returns unsigned CBOR; signing happens in the browser wallet.
- [x] Submission of a *signed* tx is a courtesy relay, not custody.
- [ ] Property/unit tests proving the above at the validator level (TODO —
      required before preprod deployment is announced to anyone).

## 5. Pre-mainnet gate (do not shortcut)

1. Full Aiken test suite: unit + property tests per redeemer, counterexample
   tests for §2.1–2.5.
2. Independent review/audit of both scripts.
3. Preprod soak with adversarial testing (we attack our own deployment).
4. Only then discuss mainnet. **The MVP explicitly never deploys to mainnet.**
