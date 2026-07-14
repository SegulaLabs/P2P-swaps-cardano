# Open Questions / Unverified Assumptions

Per project rules: **when unsure, document here — never silently guess.**
Resolved items keep their numbers (they are referenced across the repo) with a
one-line record of the decision; details live in
[mvp-contract-decisions.md](mvp-contract-decisions.md) ("MCD").

## Resolved (2026-07-06, protocol-hardening pass)

1. **Deposit return on TakeOrder.** ✅ Taker returns the deposit to
   `payment_address` inside the exact payment output; buyer gets the offered
   asset only; cancel returns everything to the owner. → MCD §1.
2. **Double-satisfaction mitigation.** ✅ One order input per tx, enforced in
   the validator on every path; output tagging (cardano-swaps `prev_input`
   style, verified in their README) is the post-MVP upgrade for batching.
   → MCD §8.
3. **Payment output shape.** ✅ Exactly one output at `payment_address`; ask
   amount exact; lovelace ≥ deposit; no foreign assets; no datum required.
   → MCD §2.
4. **Beacon name derivation.** ✅ `sha2_256` with domain prefixes
   (`#"00"` pair-sorted / `#"01"` offer / `#"02"` ask), constant `"order"`,
   owner key hash verbatim. `sha2_256` verified present in stdlib v2.2.0
   source. Matches cardano-swaps' scheme (verified) except our undirected,
   prefixed pair beacon. → MCD §3.
5. **One policy vs per-pair policies.** ✅ One policy. Blockfrost's
   `/assets/policy/{policy_id}` + per-asset endpoints (verified in their
   OpenAPI spec) make this query-efficient. → MCD §3/§10.
6. **Expiration semantics.** ✅ POSIX ms; TakeOrder requires a finite validity
   upper bound ≤ `expiration`. Residual detail → #24.
7. **UpdateOrder.** ✅ **Postponed** — cancel+recreate is equivalent;
   removing it makes "every spend burns all beacons" a total invariant.
   Redeemer removed from MVP types. → MCD §7.
9. **Garbage-datum UTxOs.** ✅ Accepted by design: non-parsing datum ⇒
   permanently unspendable (standard for datum-carrying protocols; cannot
   trap a valid order because the minting policy guarantees valid datums in
   real orders). Behavior to be pinned by a test during implementation.
   → MCD §5.
10. **Aiken toolchain.** ✅ aiken v1.1.23 + stdlib v2.2.0 compile the
    scaffold; on aarch64-linux use the npm distribution (`@aiken-lang/aiken`).
11. **Test layout.** ✅ `lib/tests/` compiles and runs under `aiken check`.
13. **SDK choice.** ✅ **Mesh SDK** (React/Next.js wallet layer, blueprint
    support, provider-agnostic builder; both candidates verified actively
    maintained June 2026). Lucid Evolution is the fallback; switch trigger
    defined. → MCD §9, spike in #21.
16. **Blockfrost query surface.** ✅ Verified from the OpenAPI spec:
    `/assets/{asset}/addresses`, `/addresses/{address}/utxos/{asset}`,
    `/assets/policy/{policy_id}`, `POST /tx/submit`; preprod base URL;
    paging max 100; 10 req/s rate limit (burst 500). → MCD §10.
19. **CIP-0089 status.** ✅ Verified: "Distributed DApps & Beacon Tokens",
    authors fallen-icarus & zhekson1, status **Active**. Its personal-address
    pattern (validator payment credential + owner staking credential) is
    adopted for order addresses. → MCD §4 rule 2.
20. **cardano-swaps prior art.** ✅ README read (repo fetched): beacon naming
    adopted-with-changes; their continuation-UTxO deposit model rejected for
    our full-fill model; their `prev_input` tagging recorded as the batching
    upgrade path; their address-staking-credential ownership adopted at the
    address level while keeping `datum.owner` as the authorization source.

## Resolved (2026-07-06, MVP implementation pass)

12. **Parameter application workflow.** ✅
    `aiken blueprint apply -m beacon -v beacon 581c<order-hash>` works, and
    Mesh's `applyParamsToScript(code, [{bytes: hash}], "JSON")` reproduces the
    **identical** policy id (`264ed623…cc0a`) — asserted permanently in
    `backend/src/protocol/blueprint.test.ts`.
14. **Unsigned-tx handoff.** ✅ Frontend sends Mesh-UTxO JSON from
    `wallet.getUtxos()` + change address + one collateral UTxO; backend
    builds/balances with MeshTxBuilder (Blockfrost fetcher+evaluator) and
    returns unsigned CBOR hex + summary; wallet `signTx(hex, partialSign=true)`
    then `submitTx`. Implemented in `tx-builder.ts` / `useTxFlow.ts`.
21. **Mesh spike.** ✅ No blocker — Mesh stays (MCD §9). Verified: param
    application (=aiken), datum encode/decode round-trips, order-address
    serialization with owner staking credential, all builder methods present.
    Residual live-preprod verification is #25.
22. **Aiken test fixtures.** ✅ Hand-rolled builders
    (`contracts/lib/tests/fixtures.ak`) over `transaction.placeholder` proved
    sufficient; `vodka`/mocktail not needed.
23. **Change address vs payment_address.** ✅ Guard implemented in
    `buildTakeOrder` (409 `change_address_conflict`), unit-tested, and the
    validator itself rejects two outputs at `payment_address` (Aiken test
    `take_with_two_outputs_to_payment_address_fails`).
24. **Interval bound inclusivity.** ✅ Conservative rule implemented: finite
    upper bound with `upper <= expiration`, inclusivity ignored (safe for
    both; at most 1 ms conservative). Tested incl. the `== t` boundary.

## Still open

8. **Script staking-credential owners.** Post-MVP. Rejected at mint time;
   revisit with the withdraw-0 pattern when there is a concrete need.
15. **Min-ADA / deposit sizing.** MVP over-provisions via
    `ORDER_DEPOSIT_LOVELACE` (3.5 tADA default) instead of computing the
    exact ledger minimum per output (MCD deviations #5). Post-MVP: compute
    from protocol params; verify Mesh's own min-UTxO handling on outputs.
17. **Reference-script hosting.** Not deployed yet — transactions currently
    ATTACH the scripts (bigger txs, same behavior); `REFERENCE_SCRIPT_TX_ID`
    env is wired for when they are published. Decide always-fail vs
    deployer-held at first deployment.
18. **Indexer rollback handling / created-slot fidelity.** Confirmation depth
    is configurable and enforced before caching; `created_at_slot` is
    approximated by sync-tip slot; spends are classified via the consuming tx
    but rollbacks are not replayed. Fine for a preprod cache (chain remains
    source of truth); revisit with Kupo.

## Resolved (2026-07-07, live preprod smoke test — open-questions #25)

25. **Live preprod end-to-end smoke test.** ✅ **Run successfully** against
    real preprod with two funded throwaway wallets (`e2e/smoke.ts`,
    `e2e/generate-wallets.ts`): CreateOrder → discovery → TakeOrder →
    CreateOrder → CancelOrder, all with on-chain assertions (exact beacon
    set, exact deposit, exact payment, buyer/seller balance deltas, beacon
    burn, stake-key authorization). **Four real bugs were found and fixed
    as a direct result** — none were visible from unit tests, since all
    involve actual Blockfrost/Mesh/ledger behavior:

    a. **Collateral double-use** (`tx-builder.ts`): `attachCommon` passed the
       *full* wallet UTxO list to `selectUtxosFrom`, including whatever UTxO
       was separately marked as collateral via `txInCollateral`. With few
       UTxOs available, coin selection could consume the collateral UTxO as
       a normal input too, leaving no real collateral — confirmed on-chain
       as `NoCollateralInputs` / `InsufficientCollateral(0)`. Fixed: the
       collateral UTxO is now excluded from the spendable set. Also made
       collateral **mandatory** (fail-fast `BuildError`) since every tx this
       builder produces touches a Plutus script — building without it was
       silently producing a transaction guaranteed to fail on submission.

    b. **`getUtxo()` never detected spent status** (`chain-provider.ts`): it
       used Mesh's `fetchUTxOs(txHash, index)`, which reads
       `/txs/{hash}/utxos` but returns a transaction's outputs forever,
       regardless of whether they've since been spent. A `resolveOrder()`
       call against an already-spent order would build a transaction with a
       dead input instead of cleanly 404ing. Fixed: `getUtxo` now uses the
       raw Blockfrost response's `consumed_by_tx` field (non-null = spent)
       directly.

    c. **CancelOrder needs the owner's STAKE key witness, not just payment**
       (protocol design, confirmed sound). `datum.owner` is deliberately the
       *staking* credential (MCD §5/CIP-0089 personal-address pattern), so
       `extra_signatories` requires a stake-key signature. **Mesh's headless
       `MeshWallet.signTx()` cannot produce one** — traced to
       `@meshsdk/wallet`'s `AppWallet.signTx` always calling
       `EmbeddedWallet.signTx(..., accountType="payment")`, with no path to
       pass `"stake"` through. This is a **Mesh headless-wallet gap**, not a
       contract bug: `EmbeddedWallet` supports `accountType: "stake"`
       internally, and the smoke test proved the *validator* accepts a
       properly-added stake-key witness (reached past `MeshWallet`'s public
       surface to add one manually). **Real CIP-30 browser wallets (Eternl,
       Lace) must still be verified** — per CIP-30 they're expected to
       satisfy `required_signers` for keys they hold, but this needs
       confirming with an actual browser wallet, not just headless Mesh.
       Tracked as #29.

    d. **Spend classification (`order-indexer.ts` `classifySpend`) needed
       two rewrites.** First approach — search the OwnerBeacon's asset
       history (`GET /assets/{unit}/transactions`) for the consuming tx —
       **never found take/cancel transactions at all**: confirmed live that
       this Blockfrost index only lists txs where the asset appears in an
       *output* (mints/transfers); a tx that purely *burns* it (no beacon
       output, which is every take/cancel) is absent, not just delayed.
       Second approach — infer taken-vs-cancelled from payment shape ("did
       an output pay ≥ ask_amount of the ask asset to payment_address") —
       produced a **false positive**: a self-cancel (owner's own address as
       `payment_address`, the common default) had its returned deposit
       alone exceed a modest ask_amount in the same asset, misclassifying a
       real Cancel as Taken. **Final, correct approach**: read the actual
       redeemer constructor from `GET /txs/{hash}/redeemers` (filtered to
       `purpose=spend` + our validator's script hash) resolved via
       `GET /scripts/datum/{redeemer_data_hash}` — `constructor: 0` =
       CancelOrder, `constructor: 1` = TakeOrder, per
       `contracts/lib/p2p_dex/types.ak`. Unambiguous, no heuristics.

    **Also confirmed as a genuine (non-bug) Blockfrost characteristic**: its
    secondary indices — `consumed_by_tx`, the asset→addresses index used for
    beacon discovery — visibly lag primary block confirmation by seconds to
    over a minute in observed testing. Harmless in production (the indexer
    polls continuously; the tx-builder re-fetches per request), but a
    single-shot check right after 1 confirmation can miss. The smoke test's
    `waitUntil` retry helper documents and works around this; no product
    code changes were needed for it beyond (b) and (d) above.

## New (from the live smoke test)

29. **Verify stake-key `required_signers` with a REAL CIP-30 wallet.**
    Confirmed the on-chain CancelOrder rule is correct (#25c) and that
    Mesh's *headless* `MeshWallet` can't satisfy it, but whether Eternl/Lace/
    other browser wallets correctly add a stake-key witness for
    `required_signers` (per CIP-30) is unverified. If a common browser
    wallet also can't do this cleanly, reconsider CancelOrder authorization
    (e.g., require the PAYMENT key hash instead — always signed anyway as
    part of normal input-spending — rather than the staking key).
30. **`getSpendRedeemerConstructor` couples the indexer to Blockfrost's
    `/scripts/datum/{hash}` endpoint** (resolves a datum/redeemer hash back
    to its Plutus Data). Confirm this endpoint's availability/behavior holds
    for Kupo when that migration happens (docs/deployment.md §7); Kupo
    exposes redeemers differently and will need its own mapping.
31. **`@meshsdk/react` is 2.0.0-beta.2.** The wallet UI layer is a beta;
    pin the version, watch for breaking changes, and re-test wallet connect
    on upgrade. (`@meshsdk/core` 1.9.1 is stable and now live-verified.)
    **Live finding (2026-07-07, real Eternl connect):** the beta's wallet
    object (`MeshCardanoBrowserWallet`) exposes the RAW CIP-30 surface —
    `getChangeAddress()` returns hex CBOR bytes (not bech32),
    `getUtxos()`/`getCollateral()` return CBOR hex strings, and `signTx()`
    returns only a witness set. This broke the staking-credential display
    (a staked base address showed "no staking credential!") and caused
    /tx/create-order 400s. Fixed via `frontend/lib/walletAdapter.ts`, which
    prefers the class's Mesh variants (`getChangeAddressBech32`,
    `getUtxosMesh`, `getCollateralMesh`, `signTxReturnFullTx`) with
    type-checked fallbacks + a pure-ADA collateral fallback. Re-check this
    adapter first on any @meshsdk/react upgrade.
32. **Client-side CBOR verification of the preview.** The TransactionPreview
    renders the backend's summary and says so loudly; decoding the unsigned
    tx in the browser and diffing against the summary is the designed
    trust-gap closure (security.md). Post-MVP.
33. **Wallet cannot prove preprod vs preview.** CIP-30 `getNetworkId()`
    returns 0 for all testnets. Mitigation: txs are built against preprod
    state so wrong-network signing simply fails; UI states the assumption.
    A cheap improvement: compare a wallet UTxO against Blockfrost preprod.

## Resolved (2026-07-09, frontend UX & resilience pass)

Frontend/UX decisions from a working session. All are cosmetic or
client-only — **none touch the protocol, the backend, or on-chain behavior.**
Recorded here for context on the production follow-ups #34–#37 they spawned.

A. **Per-token avatar colours are hash-derived.** `frontend/lib/tokens.ts`
   `avatarHue()` was upgraded from a plain rolling hash (`h*31 + c`) to
   **FNV-1a + a murmur3 finalizer**. The test tokens TESTA–TESTF share one
   policy id and differ only in the *last* byte of their asset name, so the
   old hash produced hues ~1° apart — every market rendered the same blue.
   The avalanche finalizer spreads a single changed input byte across all
   output bits, so adjacent markets now get distinct, still-deterministic
   colours. Caveat → #34.

B. **ADA (lovelace) uses a bundled logo image.** The Cardano logo is checked
   in at `frontend/public/tokens/cardano.png` and rendered via a plain
   `<img>` for `lovelace`; every other asset keeps the tinted letter-avatar.
   Deliberately chose the source PNG
   (`storage.googleapis.com/dexhunter-images/tokens/cardano.png`) over the
   DexHunter `next/image` proxy URL, and a plain `<img>` over `next/image`,
   to avoid remote-domain config and an optimisation pipeline for one local
   static asset. Branding/licensing/generalisation → #35.

C. **Partial-fill editor is an inline expanding row.** On `/trade/[pair]` the
   "Partial…" editor now expands as a row **directly beneath the order it
   belongs to** (previously a single panel under the whole book), the toggle
   button shows a pressed/active state, and only one editor is open at a time.
   Pure UX; the only known gap is no open/close animation (`<tr>` height
   doesn't transition cleanly). No production debt.

D. **Transaction history is stored client-side (localStorage).** Every tx this
   app submits (create / take / partial / cancel) is recorded at the single
   choke point in `hooks/useTxFlow.ts` and shown on `/orders`
   (`components/TxHistory.tsx`, `lib/history.ts`), keyed by the wallet's stake
   credential (same identity as `/orders/by-owner`). **Rationale:** the
   backend is intentionally stateless and account-less, and its indexer only
   retains *live* order UTxOs — a taken/cancelled order's UTxO is spent and
   drops out of the index, so the backend cannot reconstruct past activity.
   The browser is the only party that witnesses each submission together with
   its full `TxSummary`. **Consequences (accepted for MVP):** history is
   per-browser, per-device, forward-only (no backfill), and non-authoritative
   (the chain/explorer link is the source of truth). Cross-device/complete
   history is a backend feature → #36.

E. **Error boundaries added.** `app/error.tsx` + `app/global-error.tsx`. The
   app previously had **no** error boundary, so any client render- or
   chunk-load failure produced a silent white screen. Failures now render a
   message with a Reload button. This was found while diagnosing a white
   screen that turned out to be a stale browser tab requesting chunks a
   rebuild had purged → deploy concern #37. (Client-side CBOR verification of
   the preview remains a separate trust-gap item, #32.)

## New (from the 2026-07-09 frontend pass)

34. **Avatar colour separation is probabilistic, not guaranteed.**
    `avatarHue()` (#A) gives each asset a stable, well-avalanched hue, but N
    random hues on a 360° wheel can still cluster (birthday effect); the
    function has no global market index to space colours deterministically.
    Production polish: assign colours by index / golden-angle from a
    market or token registry, or resolve a real per-token brand colour. Pairs
    with #35.
35. **Token logo / branding resolution.** Only ADA has a real logo (a bundled
    static PNG, #B); every other token falls back to a generated letter
    avatar. Production needs a proper token-metadata → logo/colour pipeline
    (Cardano token registry / off-chain metadata), CDN hosting with sane
    fallbacks, a **licensing review** of any third-party logo assets (the ADA
    image currently originates from a Google-hosted DexHunter bucket), and
    likely `next/image` with configured remote domains.
36. **Cross-device transaction history is a backend service.** MVP history is
    browser-local (#D). A complete, portable history requires: enumerating a
    stake credential's protocol txs **including spent UTxOs** (a heavier
    indexer that retains history, or an external chain-index provider);
    reconstructing each tx's semantics from on-chain data rather than the
    build-time `TxSummary`; reconciling confirmation/rollback status; and
    deciding the identity/privacy model (public-by-credential vs a
    proof-of-ownership gate). Depends on the Kupo migration
    (deployment.md §7) and relates to indexer rollback handling #18.
37. **Rebuilds purge content-hashed chunks under open tabs.** The frontend is
    served as a production build (`next start`); each rebuild renames the
    hashed JS chunks and deletes the old ones, so a browser tab opened against
    a *prior* build white-screens on its next chunk fetch. The #E error
    boundaries turn this into a visible "reload" prompt instead of a blank
    page, but production still needs an **atomic/versioned static-asset
    deploy** (retain the previous chunk sets, or a CDN with old-asset
    retention) and ideally a build-version ping that invites a reload. See
    deployment.md §6.

## Resolved (2026-07-11, live user-reported bug — insufficient funds)

38. **"UTxO Balance Insufficient" on TakeOrder despite a well-funded wallet.**
    ✅ Root cause: an oversized collateral UTxO (worth nearly the entire
    wallet balance in the reported case) was excluded from coin selection —
    correctly, per the ledger's collateral rule — which meant coin selection
    ran against almost nothing. Two earlier hypotheses (backend error
    diagnostics, CIP-30 pagination) were real gaps but not the cause; the
    byte-identical error across both "fixes" was the signal to verify the
    wallet's actual on-chain state directly via Blockfrost rather than keep
    guessing client-side. Fixed via `pickCollateral()` — see security.md §0.2
    for the full account, including the two secondary hardening fixes
    (backend diagnostic error, wallet-adapter pagination) that shipped
    alongside it.

## Session decisions (2026-07-11, trade-UX pass)

F. **`/trade/[pair]` layout: order book left, sticky trade rail right.** The
   page was restructured into `<header className="trade-header">` (pair title
   + per-token info), `<section className="trade-books">` (the order book,
   which now fills the left column from the top), and `<aside
   className="trade-side">` (the trade panel with the markets list beneath
   it). The right rail is `position: sticky` (`top: calc(var(--header-h) +
   0.75rem)`) so it stays visible while the book scrolls, and it moves as one
   unit — no independent inner scrollbar. The site header is now opaque
   (`--header-h: 60px`) and page content is offset so nothing sits under it.
   Pure layout; no production debt.

G. **Scroll resets to top on market navigation.** `components/ScrollReset.tsx`
   (`useEffect(() => window.scrollTo(0,0), [trigger])`, keyed on the pair) so
   switching markets no longer lands mid-page. Also fires the tx-flow
   scroll-to-top in `hooks/useTxFlow.ts` on preview/submitted.

H. **The whole tx flow happens *inside* the trade component.** Building →
   preview → submitted → success all render in-place inside the same card
   (each host wraps its flow in `<div className="…tx-flow-host">`, and a CSS
   neutraliser strips any inner `.card`/`.preview` box so it doesn't look like
   a nested page). Previously accepting a trade navigated to a separate,
   inconsistent page. Applies to TradePanel, OrderBook and MyOrders.

I. **Preview shows the network fee and a copy-CBOR button.**
   `components/TransactionPreview.tsx` decodes the fee client-side with
   `@meshsdk/core-cst` (`Transaction.fromCbor(hex).body().fee()` — pure TS,
   runs in the browser) and shows it as a "Network fee" row; a copy button
   copies the raw unsigned CBOR. This does **not** close the CBOR
   verification trust gap (#32) — the summary is still advisory.

J. **BITMASK-style success component.** `components/TxStatus.tsx` was rebuilt
   as a polished success state: an animated SVG check badge (ring/disc/tick
   with `@keyframes tx-draw`/`tx-pop`), a status dot that goes amber→green on
   confirmation, the short tx hash, and a "View on Cardanoscan ↗" link. Keeps
   the existing confirmation polling + auto-dismiss.

K. **Market/Limit tabs share one form state.** `TradePanel.tsx` lifts a shared
   `TradeFormState` (sellAsset / buyAsset / sellAmount / buyAmount) so
   switching tabs no longer resets the chosen tokens or amounts. The Market
   tab UI was unified to match Limit: a flip button *between* the two token
   boxes and a Max control top-right.

L. **Apple/Jupiter-style toggle + Max + percentage slider.** The old "Allow
   partial fills" checkbox is now an iOS-style switch (`.switch` — hidden
   checkbox + styled track/thumb). When a wallet is connected both tabs show a
   Max button and a `components/PercentSlider.tsx` (25/50/75/MAX chips +
   Jupiter-style volume range with a `--pct` fill var). A reusable
   `components/Callout.tsx` (Jupiter "TIP"-style box, tones
   accent/info/warn) replaces ad-hoc notes across the site.

M. **"NO MARKET" vs "TOO SMALL": disambiguated via `candidateCount`.** An empty
   Smart Fill route (`legs.length === 0`) has two distinct causes that the UI
   previously conflated into a misleading "NO MARKET" banner. The planner now
   returns `candidateCount` = the number of open orders on the spend→receive
   side (`backend/src/services/smart-fill.ts`, mirrored in
   `backend/src/types.ts` and `frontend/lib/types.ts`). `TradePanel.tsx`
   branches on it:
     - `candidateCount === 0` → **NO MARKET** callout; button "No market yet —
       place a limit order" (opens the market; backend behaviour unchanged).
     - `candidateCount > 0` but no fillable legs → a distinct **TOO SMALL**
       (info-tone) callout; button "Amount too small — place a limit order".
   The no-market path deliberately still lets the user place a *limit* order
   that will create the market — the "no market" state is hidden as a dead end
   but functional underneath. Verified end-to-end: 10 tADA→TESTA returns
   `candidateCount: 34, legs: 0` (TOO SMALL) vs a nonexistent pair returning
   `candidateCount: 0` (NO MARKET).

N. **Front-page copy corrected for partial fills.** The hero previously said
   partial fills were unsupported and the trade component explained them
   *above* the button; partial fills are now supported (v3, partial-fills.md),
   the stale copy was removed, and explanatory text moved **below** the action
   button. Backend-unreachable warning is now a `Callout` (tone "warn").

O. **Market-tab flip (⇅) preserves the typed amount.** Previously `flipSides()`
   cleared both boxes — typing 50 tADA to sell, then hitting flip, lost the
   50. New pure `frontend/lib/marketForm.ts` `flipMarketSides()` swaps the two
   assets but keeps the number attached to whichever box (`edited: "spend" |
   "receive"`) the user was actually typing into, clearing only the computed
   side so it re-quotes for the new direction. Deliberately extracted to a
   standalone `lib/*.ts` module rather than left inside `TradePanel.tsx`:
   importing the component file transitively pulls in `@meshsdk/react`'s
   native crypto bindings (`bip32`/`tiny-secp256k1` WASM), which fail to
   initialize under Vitest ("ecc library invalid") — pure logic has to live
   outside component files to stay unit-testable.

P. **"Back to Trade" no longer waits for on-chain confirmation.**
   `components/TxStatus.tsx` gained optional `onDismiss`/`dismissLabel`/`note`
   props: when provided, a button lets the user leave the success screen and
   start another trade immediately, without waiting for `onSettled`'s
   confirmation-count polling to fire. Wired into all three submit flows
   (Market tab's batch queue, Limit tab's single tx, MyOrders' expired-order
   claim queue). For the batch queue specifically, dismissing mid-batch shows
   a `note` warning ("N more batches won't be executed") — leaving early is
   safe there because nothing has been submitted yet for the remaining legs;
   the option must never be offered where dismissing would race ahead of an
   in-flight submission.

Q. **Market-tab spend-side slider/Max always renders, clamped to 0% when
   unheld.** Reported as "the slider only shows for the top token, not after
   flipping" — traced (via a direct Blockfrost query against the reporting
   wallet) to the wallet genuinely holding zero of the flipped-to asset, not a
   lookup bug: the control was hidden outright whenever the spend balance was
   `undefined`/`0`, which reads as broken UI rather than "you don't hold any
   of this yet." Fixed by defaulting the balance to `0n` and rendering the Max
   button + `PercentSlider` unconditionally for whichever asset currently sits
   in the spend box; Max/the slider correctly land on 0% for a zero balance,
   and now follow the spend box automatically through a flip.
