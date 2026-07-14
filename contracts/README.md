# Contracts (Aiken)

Two validators. The implementation contract is
**[docs/mvp-contract-decisions.md](../docs/mvp-contract-decisions.md)**
(background in [docs/protocol-spec.md](../docs/protocol-spec.md)):

- `validators/order.ak` — spending validator for order UTxOs
  (CancelOrder / TakeOrder / TakeOrderPartial; UpdateOrder is postponed
  post-MVP so that every full spend destroys all beacons).
- `validators/beacon.ak` — minting policy for the 5 beacon tokens; enforces
  order **creation** rules (spending validators don't run on creation).
  Parameterized by the order validator's script hash.

Shared types live in `lib/p2p_dex/types.ak`; rule logic lives in
`lib/p2p_dex/beacon_rules.ak` and `lib/p2p_dex/order_rules.ak` (so tests drive
it with fixture transactions from `lib/tests/fixtures.ak`) and the
`validators/*.ak` files are thin wrappers. Tests live in `lib/tests/` (Aiken
compiles `lib/` and `validators/` — a top-level `tests/` dir is not part of the
standard layout; see docs/open-questions.md #11).

## Status

**Implemented — protocol v3 (opt-in partial fills).** `aiken check` passes
**130 tests** (84 order + 46 beacon; aiken v1.1.23 + stdlib v2.2.0), covering
the adversarial lists in mvp-contract-decisions.md §11: counterfeit/missing/
renamed beacon sets, address and datum attacks, value exactness,
double-satisfaction (two order inputs), beacon leakage/smuggling,
payment-shape attacks, deposit shorting, expiration boundaries, and — for v3 —
continuation-datum drift, price rounding (`ceil`), deposit retention, and
mixed partial/full batches.

Protocol history (each redeploy = new hashes; older orders become invisible to
the indexer but stay cancellable by their owner):

| Version | Adds | Order validator | Beacon policy |
|---|---|---|---|
| v1 | MVP create/take/cancel | `89389051…46ab` | `264ed623…cc0a` |
| v2 | atomic `TakeManyOrders` + `PaymentTag` | `4d0a1335…94b8` | `a88c60a8…c9b0` |
| **v3 (current)** | opt-in `TakeOrderPartial` + continuations | `1757ecd8fdc1c3d095906f13f17acdf8262a7c2363ac69ddeb256f8b` | `c14dc44ed1e2025bae03895af442f2fa9d387deb526b6518b5aa8702` |

After changing contracts: `npm run contracts:build` (root) re-syncs
`backend/src/protocol/plutus.json`, then update the pinned ids in
`backend/src/protocol/blueprint.test.ts` and `backend/.env.example`.

## Audit

An adversarial audit ([Audit/security-audit-fable5.md](../Audit/security-audit-fable5.md),
2026-07-13) attacked these validators as a hostile creator, seller, taker,
colluding pair, and raw-tx builder. **No ledger-valid transaction could steal
locked value, underpay a seller, double-satisfy one payment across two orders,
forge or leak beacons, or drift a partial-fill continuation.** The material
risk is off-chain (F-01, the backend-provided preview — see the root README).

Two *contract-level* hardening candidates remain open while the scripts are
still unfrozen: unbounded `ask` asset identifiers allow unfillable order-book
spam (F-02), and order creation is permissionless in the owner field (F-03).
The 5 audit regression tests are **not** part of the 130 above — they live in
[Audit/regression-tests/](../Audit/regression-tests/README.md) so the protocol
source tree stays unmodified.

## Toolchain note (aarch64 dev containers)

`aikup` has **no prebuilt binary for aarch64-linux** (typical Apple-Silicon
Docker). The npm distribution works instead:

```bash
npm i -D @aiken-lang/aiken   # anywhere convenient
npx aiken --version          # v1.1.23 verified in this container
```

## Commands

```bash
aiken check      # typecheck + run tests (or: npx aiken check)
aiken build      # emit plutus.json (CIP-57 blueprint)
aiken docs       # generate docs from doc-comments
```

The beacon policy needs the order validator hash applied as a parameter after
`aiken build` (`aiken blueprint apply` — exact workflow: open-questions #12).
