# Security Policy

This is an **experimental, unaudited preprod-only MVP** — see
[README.md](README.md) and [docs/security.md](docs/security.md) for the
current threat model and known issues (including F-01, an already-tracked
High finding). Since the app only ever runs against Cardano **preprod**
(test-network ADA with no real value) and refuses to boot against mainnet,
the worst case for most bugs here is a broken preprod tx or a leaked
preprod-only key material check bypass — please still report it.

## Reporting a vulnerability

Preferred: open a
[GitHub Security Advisory](https://github.com/SegulaLabs/P2P-swaps-cardano/security/advisories/new)
on this repo (private until you and the maintainers agree to disclose).

If that's not available to you, open a regular issue with as little detail
as possible (e.g. "potential fund-safety issue, please contact me") and a
maintainer will follow up to get details privately.

Please include:
- Whether the issue is on-chain (contracts in `contracts/`) or off-chain
  (backend/frontend) — see [docs/mvp-contract-decisions.md](docs/mvp-contract-decisions.md)
  for the trust boundary.
- Steps to reproduce, ideally against preprod (never send real funds).
- What you'd expect the [Aiken tests](contracts/) or
  [audit regression tests](Audit/regression-tests/README.md) to have
  caught, if relevant.

## Scope

In scope: the order validator + beacon policy (`contracts/`), the backend's
transaction-building and indexing logic, and anything that could let
someone move funds they don't own or bypass the non-custodial guarantee
(docs/security.md §1).

Out of scope: this is preprod-only by design — reports about mainnet
behavior, or about the already-documented F-01 preview-trust gap (tracked,
not silently ignored), aren't news to us, but linking new exploitation
paths for either is still welcome.
