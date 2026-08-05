# Contributing

Issues and PRs are welcome. This is an experimental, unaudited MVP
(preprod-only by design — see [README.md](README.md) and
[docs/security.md](docs/security.md)), so please keep that scope in mind:
mainnet support, custodial features, or anything that would let the backend
sign or hold funds is out of scope.

## Dev setup

See [docs/development.md](docs/development.md) for prerequisites, running
the dev servers, and the contracts workflow. Quick version:

```bash
npm install
cp backend/.env.example backend/.env     # works as-is: Koios, no key needed
cp frontend/.env.example frontend/.env.local
npm run dev                              # backend :3001 + frontend :3000
```

## Before opening a PR

```bash
npm run contracts:check   # Aiken tests, only if you touched contracts/
npm test                  # contracts + backend + frontend
npm run typecheck
npm run build
```

- Keep changes scoped; explain the *why* in the PR description, not just
  the what.
- If you touch the Aiken contracts, update the compiled blueprint
  (`npm run contracts:build`) and the pinned hashes in
  `backend/src/protocol/blueprint.test.ts` / `backend/.env.example` —
  boot fails on a mismatch on purpose.
- If you touch the chain-provider layer (`backend/src/services/chain-provider.ts`),
  note which parts you verified against live preprod data vs. unit tests
  only — this project's existing culture (see the file's own comments) is
  to be explicit about that gap rather than assume parity between
  providers.

## Reporting a security issue

Please don't open a public issue — see [SECURITY.md](SECURITY.md).
