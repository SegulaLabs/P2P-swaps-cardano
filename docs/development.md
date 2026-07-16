# Development setup

For *running* the app as a user, see [user-guide.md](user-guide.md) — this
page is for working on the code.

## Prerequisites

- **Node.js ≥ 20** + npm (workspaces are used).
- **Docker** for the dev PostgreSQL (optional — without it the backend
  falls back to an in-memory order cache).
- **Aiken** only if you touch the contracts: `aikup`
  (https://aiken-lang.org), or on aarch64-linux dev containers the npm
  distribution `@aiken-lang/aiken` (already a root devDependency). Pinned:
  aiken v1.1.23 / stdlib v2.2.0. The compiled blueprint
  (`backend/src/protocol/plutus.json`) is **committed**, so everyone else
  never needs Aiken.
- A **Blockfrost preprod** project id in `backend/.env` for anything that
  touches the chain (tx building, indexing, e2e).

## Setup

```bash
npm install
cp .env.example .env                     # root: postgres credentials
docker compose -f infra/docker-compose.yml --env-file .env up -d   # postgres (optional)

cp backend/.env.example backend/.env     # ← add BLOCKFROST_PROJECT_ID_PREPROD
cp frontend/.env.example frontend/.env.local

npm run dev                              # tsx watch :3001 + next dev :3000
```

## Validate

```bash
npm run contracts:check   # 130 Aiken tests (needs aiken)
npm test                  # contracts + backend (120) + frontend (66)
npm run typecheck
npm run build             # backend tsc + frontend next build
```

## Contracts

After ANY contract change:

```bash
npm run contracts:build   # aiken build + sync plutus.json into the backend
```

then update the pinned ids in `backend/src/protocol/blueprint.test.ts` and
`backend/.env.example` (boot cross-checks fail on mismatch — that's the
point). See [deployment.md](deployment.md) for reference-script publication
and live-verification history.

## Production artifacts

- `ship.sh` — user-facing launcher (configure → build → start). Keep its
  UX dead simple; it must work on a fresh clone with only Node installed.
- `backend/Dockerfile` / `frontend/Dockerfile` — multi-stage production
  images, build context = repo root. `npm ci --workspace <ws>` deliberately
  skips root devDependencies, so Aiken never enters the images.
- `docker-compose.yml` (root) — the user-facing one-command deployment.
  `infra/docker-compose.yml` is dev-only (postgres).
- `.github/workflows/release-images.yml` — publishes GHCR images on `v*`
  tags.

## Releasing

1. Bump `version` in root, `backend/`, and `frontend/` `package.json`
   (kept in lockstep; it's shown in the UI footer and on `/health`).
2. Update `CHANGELOG.md`.
3. `git tag vX.Y.Z && git push --tags` — CI publishes the Docker images;
   create a GitHub release from the tag with the changelog entry.

## e2e (live preprod)

See [../e2e/README.md](../e2e/README.md) — smoke tests for
create/take/cancel, atomic batches (v2) and partial fills (v3), plus
market-seeding scripts. Uses throwaway faucet wallets under `e2e/wallets/`
(gitignored).
