# Contracts (Aiken)

Two validators. The implementation contract is
**[docs/mvp-contract-decisions.md](../docs/mvp-contract-decisions.md)**
(background in [docs/protocol-spec.md](../docs/protocol-spec.md)):

- `validators/order.ak` — spending validator for order UTxOs
  (CancelOrder / TakeOrder; UpdateOrder is postponed post-MVP).
- `validators/beacon.ak` — minting policy for the 5 beacon tokens; enforces
  order **creation** rules (spending validators don't run on creation).
  Parameterized by the order validator's script hash.

Shared types live in `lib/p2p_dex/types.ak`. Tests live in
`lib/tests/` (Aiken compiles `lib/` and `validators/` — a top-level `tests/`
dir is not part of the standard layout; see docs/open-questions.md #11).

## Status

**Implemented.** `aiken check` passes **77 tests** (aiken v1.1.23 + stdlib
v2.2.0), covering the adversarial lists in mvp-contract-decisions.md §11:
counterfeit/missing/renamed beacon sets, address and datum attacks, value
exactness, double-satisfaction (two order inputs), beacon leakage/smuggling,
payment-shape attacks, deposit shorting, and expiration boundaries.

Layout: rule logic lives in `lib/p2p_dex/beacon_rules.ak` and
`lib/p2p_dex/order_rules.ak` (so tests drive it with fixture transactions
from `lib/tests/fixtures.ak`); the `validators/*.ak` files are thin wrappers.

Current identities (regenerate + update after ANY change):
- order validator: `4d0a13355316e80d8addbc93c7bf2fba1a4a6563e6097e87c11794b8` (v2; v1 was `89389051`
- beacon policy (order-hash applied): `a88c60a8e8be899466eff52542ee57fd728540be1ed59d4e3ca2c9b0`

After changing contracts: `npm run contracts:build` (root) re-syncs
`backend/src/protocol/plutus.json`, then update the pinned ids in
`backend/src/protocol/blueprint.test.ts` and `backend/.env.example`.
Deployment to preprod still requires the security.md §5 gate items that
remain open (live smoke test, review).

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
