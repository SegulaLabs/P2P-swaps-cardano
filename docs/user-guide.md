# User Guide — running and operating your own Beacon DEX

This app is **self-hosted by design**: nobody runs it as a service for you.
You download it, run it on your own machine, connect your own browser wallet,
and trade peer-to-peer on **Cardano preprod** (test network). Your funds sit
in on-chain order UTxOs governed by validators — never with a middleman.

> **Preprod only. Experimental. Not externally audited. Never use mainnet
> funds.** The software refuses to run against mainnet by design.

## 1. What you need

| Thing | Where | Cost |
|---|---|---|
| Node.js ≥ 20 **or** Docker | https://nodejs.org / https://docs.docker.com/get-docker/ | free |
| A CIP-30 browser wallet (Eternl, Lace, …) set to **preprod** | wallet's website / extension store | free |
| Test ADA (tADA) | official faucet: https://docs.cardano.org/cardano-testnets/tools/faucet | free |

That's it — nothing to sign up for. The app defaults to
[Koios](https://koios.rest), a free keyless Cardano chain API, so it works
out of the box. This is how *your* copy of the app reads the chain and
submits transactions — your personal connection to Cardano, which is what
keeps this decentralized. If you'd rather use
[Blockfrost](https://blockfrost.io) instead (its own free **preprod**
project id, starts with `preprod`; a mainnet id is rejected), you can set
that up front or switch anytime from the app's own **Settings** page —
no restart needed either way.

## 2. Start it

**Option A — one command, no Docker (recommended first try):**

```bash
git clone https://github.com/SegulaLabs/P2P-swaps-cardano.git
cd P2P-swaps-cardano
./ship.sh
```

The first run asks which chain provider to use (Koios needs no key — just
press Enter), installs, builds and starts everything. Then open
**http://localhost:3000**. Next time, `./ship.sh` goes straight to
starting. `./ship.sh --help` lists the few options (`--configure` to
change provider, `--rebuild`, `--postgres`).

**Option B — Docker only:**

```bash
git clone https://github.com/SegulaLabs/P2P-swaps-cardano.git
cd P2P-swaps-cardano
cp .env.example .env        # works as-is — Koios needs no key
docker compose up --build -d
```

Same result: **http://localhost:3000**. Stop with `docker compose down`.
(`down -v` also wipes the local order cache — harmless, it rebuilds from the
chain.)

Running it on a home server? Just open `http://<server-ip>:3000` from any
device on your network — the browser talks only to the site itself (the
frontend proxies API calls to the backend internally), so no extra
configuration is needed. Don't expose the ports to the public internet.

## 3. Set up the wallet

1. Install Eternl or Lace, create/restore a **throwaway test wallet** —
   never reuse a wallet that holds mainnet funds.
2. Switch the wallet to the **preprod** network (wallet settings).
3. Fund it from the faucet (link above). Give it a few minutes to arrive.
4. In the app, click **Connect wallet** and approve the connection.

## 4. Trading

- **Order book** — pick a market in the sidebar. Every order you see is a
  live UTxO on chain, discovered via beacon tokens. Click **Refresh** to
  re-scan the chain (the order book is a cache; the chain is the truth).
- **Create an order** — choose what you offer and what you ask, amounts, and
  whether to **allow partial fills**. Creating locks your offered asset plus
  a ~3.5 tADA deposit (returned in full when the order is taken or
  cancelled).
- **Take an order** — pay exactly what the seller asked, receive the offered
  asset. Orders that allow it can be taken **partially** (a slider sets how
  much); the remainder stays on the book as a continuation order.
- **Smart fill** — enter how much you want to spend/receive and the app
  routes it across several orders in one atomic transaction.
- **Arbitrage** — scans the open book for profitable cycles you can execute
  in one transaction.
- **My orders** — your open orders (matched by your wallet's stake key);
  cancel reclaims the asset and the deposit. Only your wallet can cancel.

Every action ends the same way: the app shows a **transaction preview**, you
confirm, and **your wallet** pops up to sign. Nothing moves without your
signature.

## 5. Read this before signing (security)

- **Always check your wallet's own display of the transaction, not just the
  app's preview.** The preview is built by your local backend; the audit's
  F-01 finding notes that a *compromised* backend could show a benign
  summary while the transaction does something else with *your* funds. The
  wallet's display decodes the real transaction — trust that.
- The on-chain validators guarantee sellers are paid exactly what they
  asked, deposits return, and only owners can cancel — no backend, including
  a malicious one, can steal *locked* order funds.
- Two people can race for the same order; the loser's transaction simply
  fails and nothing is lost.
- If you use Blockfrost, keep your project id private (it's a quota, not a
  spending key — but it's yours).

## 6. Everyday operations

| Task | How |
|---|---|
| Start / stop | `./ship.sh` / Ctrl-C — or `docker compose up -d` / `down` |
| See what version you run | footer of the site, or `curl localhost:3001/health` |
| Update to a new release | `git pull` (or `git checkout vX.Y.Z`), then `./ship.sh --rebuild` or `docker compose up --build -d` |
| Switch provider / change key | The app's **Settings** page (no restart), or `./ship.sh --configure` / edit `.env` / `backend/.env` |
| Force order-book refresh | **Refresh** button in the UI |
| Wipe the local cache | Docker: `docker compose down -v`; ship.sh without `--postgres` keeps no cache at all |

## 7. Troubleshooting

- **Trading buttons return errors / 503** — no provider configured, or a
  Blockfrost id that doesn't start with `preprod`. Check the **Settings**
  page, or fix via `./ship.sh --configure` (or `.env` for Docker) and
  restart.
- **"Backend unreachable" banner** — the backend isn't running or crashed:
  `docker compose ps` should show it healthy; `docker compose logs backend
  --tail=30` shows why not.
- **Wallet won't connect or shows no funds** — the wallet is probably on
  mainnet or preview; switch it to **preprod**. Fund via the faucet.
- **Port 3000/3001 already in use** — stop the other program, or (Docker)
  set `FRONTEND_PORT` / `BACKEND_PORT` in `.env`.
- **Order book looks stale or empty** — click **Refresh**; if you run
  without PostgreSQL the cache re-syncs on every restart, give it a moment.
- **A take fails right after clicking** — someone else took that order
  first (the chain is first-come-first-served). Refresh and retry.
