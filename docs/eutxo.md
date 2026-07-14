# eUTxO Notes — the ledger facts this design depends on

A short, honest reference for contributors coming from account-model chains.
If any statement here turns out to be wrong for the current era, fix it and
update [open-questions.md](open-questions.md).

## 1. UTxOs, not accounts

- The ledger is a set of unspent transaction outputs (UTxOs). A transaction
  consumes whole UTxOs as inputs and produces new UTxOs as outputs.
- A UTxO = address + value (lovelace + native assets) + optional datum +
  optional reference script.
- **Each of our orders is one UTxO.** There is no global order-book state, so
  two takers can take two different orders in the same block without
  contention. Two takers racing for the *same* order: exactly one wins; the
  other's tx fails at the mempool/ledger level (not a script failure) and no
  funds move. The UI must handle this race gracefully.

## 2. When scripts run — the single most important fact

- A **spending validator** runs only when a UTxO *at its address* is **spent**.
  It does **not** run when a UTxO is created at its address.
- Consequence: anyone can create arbitrary garbage UTxOs at our validator
  address, with any datum. **Creation-time correctness must be enforced by the
  beacon minting policy**, which *does* run when beacons are minted. Honest
  users only discover orders via beacons, so beacon-less garbage is invisible.
- A **minting policy** runs when tokens of its policy id are minted or burned.
  It does **not** run when existing tokens merely move. Consequence: the
  spending validator must prevent beacons from escaping order UTxOs on spend.

## 3. Datums

- Inline datums (CIP-32) store the datum directly in the output, readable by
  anyone from chain data. We require inline datums for orders.
- Validators receive the datum of the input being spent. For our `spend`
  handler the datum arrives as `Option<OrderDatum>` — a UTxO at a script
  address *can* exist with no datum (it becomes unspendable if the validator
  requires one; that's the creator's loss, not a protocol risk).

## 4. Determinism & phase-1/phase-2 validation

- Transactions are fully deterministic: scripts see the exact tx being
  validated (inputs, outputs, mint, signatories, validity interval). Fees and
  outcomes are known before submission.
- Phase-1 (structural/ledger rules: balancing, min-ADA, fee) is checked by the
  node; phase-2 is script execution. If phase-2 fails on-chain, collateral is
  forfeited — but wallets/providers evaluate scripts before submission, so
  honest users should never lose collateral in practice.

## 5. Min-ADA (min-UTxO value)

- Every UTxO must contain a minimum amount of lovelace proportional to the
  UTxO's on-chain size (protocol parameter `coinsPerUTxOByte`; the parameter's
  current value must be read from the network, not hardcoded).
- An order UTxO carrying 5 beacons + a token + an inline datum will need
  noticeably more than the bare minimum (order of ~2 ADA; **compute at tx-build
  time, never hardcode** — see open-questions).
- Whoever funds the order pays this deposit; the spec routes it back to the
  seller on take (with the payment) and to the owner on cancel. ⚠ Confirm the
  exact deposit-return rule before implementing (open-questions).

## 6. Validity intervals, not "current time"

- Scripts never see a clock. They see the tx's validity interval, which the
  builder chooses and the node enforces at admission.
- To prove "before expiration", the taker sets an upper bound on the interval
  and the script checks `upper_bound <= expiration`.
- Wallets/SDKs convert between slots and POSIX time; on-chain, Plutus contexts
  expose POSIX time (ms). We store `expiration` as POSIX time in the datum.

## 7. Native assets & beacons

- Native tokens need no contract — a token is (policy id, asset name, amount);
  the policy id *is* the hash of the minting policy script.
- Asset names are limited to **32 bytes**; a full asset id (28-byte policy +
  up-to-32-byte name) does not fit in a token name, which is why beacon names
  that encode assets/pairs must be **hashes** (see beacons.md).
- ADA/lovelace is not a native asset: it has the empty policy id and empty
  name in value maps, which is how the datum represents an ADA side of a pair.

## 8. Reference scripts (CIP-33) & reference inputs (CIP-31)

- A script can be stored in a UTxO once ("deployed as a reference script");
  transactions then *reference* it instead of attaching the full script,
  keeping tx sizes and fees down. Our take/cancel/update txs should use
  reference scripts for both the validator and the policy.
- Reference *inputs* let a tx read a UTxO without spending it. Not needed by
  the MVP validators, but the tx-builder uses reference-script UTxOs this way.
- Where reference scripts are parked (always-fail script vs. deployer-held
  address) is a deployment decision — see deployment.md and open-questions.

## 9. Collateral

- Txs that run scripts must include collateral (a pure-ADA input from the
  wallet). CIP-30 wallets manage this; the backend tx-builder must leave
  collateral selection to the wallet or set it from wallet-provided UTxOs —
  never from backend-held funds (there are none).

## 10. What this buys us

- **Non-custody by construction**: the "DApp" is just UTxOs users own/control;
  the backend is a stateless convenience layer over public chain data.
- **Composability/distribution**: anyone can index beacons and build an
  alternative frontend; the protocol lives entirely on-chain.
