#!/usr/bin/env bash
# ship.sh — run your own Beacon DEX with one command (no Docker required).
#
#   ./ship.sh              first run: asks for your Blockfrost preprod id,
#                          then installs, builds and starts everything
#   ./ship.sh --configure  re-run the setup questions (e.g. new key)
#   ./ship.sh --rebuild    force a clean rebuild of backend + frontend
#   ./ship.sh --postgres   also start PostgreSQL via Docker (optional;
#                          without it an in-memory order cache is used,
#                          which is fine for a personal instance)
#
# Prefer Docker for everything? Use:  cp .env.example .env  &&  docker compose up --build
#
# Cardano PREPROD ONLY. Non-custodial: your browser wallet signs everything;
# this software never sees a private key. See docs/user-guide.md.

set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
CONFIGURE=0 REBUILD=0 POSTGRES=0

for arg in "$@"; do
  case "$arg" in
    --configure) CONFIGURE=1 ;;
    --rebuild)   REBUILD=1 ;;
    --postgres)  POSTGRES=1 ;;
    --version)   echo "Beacon DEX v$VERSION"; exit 0 ;;
    -h|--help)   sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

say()  { printf '\033[1;36m[ship]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[ship]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- prereqs
command -v node >/dev/null 2>&1 || fail "Node.js >= 20 is required — install it from https://nodejs.org and re-run."
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js >= 20 is required (you have $(node --version))."
command -v npm >/dev/null 2>&1 || fail "npm is required (it normally ships with Node.js)."

say "Beacon DEX v$VERSION — self-hosted, Cardano PREPROD only."

# ---------------------------------------------------------------- configure
if [ ! -f backend/.env ] || [ "$CONFIGURE" = 1 ]; then
  echo
  say "One-time setup. You need a FREE Blockfrost project id for PREPROD:"
  say "  1. Sign up at https://blockfrost.io"
  say "  2. Create a project on the *Cardano preprod* network"
  say "  3. Paste its project id below (it starts with \"preprod\")"
  echo
  BF_KEY="${BLOCKFROST_PROJECT_ID_PREPROD:-}"
  if [ -z "$BF_KEY" ]; then
    printf 'Blockfrost preprod project id (Enter to skip -> read-only mode): '
    read -r BF_KEY
  fi
  if [ -n "$BF_KEY" ] && [ "${BF_KEY#preprod}" = "$BF_KEY" ]; then
    fail "That doesn't look like a PREPROD project id (they start with \"preprod\"). Mainnet keys are refused by design."
  fi
  sed "s|^BLOCKFROST_PROJECT_ID_PREPROD=.*|BLOCKFROST_PROJECT_ID_PREPROD=$BF_KEY|" \
    backend/.env.example > backend/.env
  cp frontend/.env.example frontend/.env.local
  say "Wrote backend/.env and frontend/.env.local (never committed)."
  [ -z "$BF_KEY" ] && say "No key set: the app boots read-only; run ./ship.sh --configure once you have one."
fi

# ---------------------------------------------------------------- postgres (optional)
if [ "$POSTGRES" = 1 ]; then
  command -v docker >/dev/null 2>&1 || fail "--postgres needs Docker (https://docs.docker.com/get-docker/)."
  [ -f .env ] || cp .env.example .env
  say "Starting PostgreSQL (order cache) via Docker…"
  docker compose -f infra/docker-compose.yml --env-file .env up -d
else
  say "Running without PostgreSQL: using the in-memory order cache (fine for one user; re-syncs from the chain)."
fi

# ---------------------------------------------------------------- install + build
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  say "Installing dependencies (first run takes a few minutes)…"
  npm install --no-audit --no-fund
fi

if [ "$REBUILD" = 1 ] || [ ! -d backend/dist ] || [ ! -d frontend/.next ]; then
  say "Building backend + frontend…"
  npm run build
fi

# ---------------------------------------------------------------- run
echo
say "Starting Beacon DEX v$VERSION:"
say "  frontend  http://localhost:3000   <- open this in the browser with your wallet"
say "            (from another device: http://<this-machine-ip>:3000)"
say "  backend   http://localhost:3001/health"
say "Wallet: use a CIP-30 wallet (Eternl/Lace) set to PREPROD, funded from"
say "the faucet: https://docs.cardano.org/cardano-testnets/tools/faucet"
say "Stop with Ctrl-C. Operating guide: docs/user-guide.md"
echo

exec npx concurrently -n backend,frontend -c blue,green \
  "npm run start --workspace backend" \
  "npm run start --workspace frontend"
