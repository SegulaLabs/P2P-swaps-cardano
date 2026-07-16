# Changelog

All notable changes to this project. Versions are shown in the site footer
and on `GET /health` (`appVersion`), so bug reports can name exactly what
they run. Protocol epochs (on-chain script hashes) are listed per release —
orders created under older epochs stay cancellable by their owners but are
invisible to newer indexers.

## v0.1.0 — 2026-07-15

First self-hostable release. **Cardano preprod only — not externally
audited; never use mainnet funds.**

- Protocol **v3** (opt-in partial fills):
  order validator `1757ecd8fdc1c3d095906f13f17acdf8262a7c2363ac69ddeb256f8b`,
  beacon policy `c14dc44ed1e2025bae03895af442f2fa9d387deb526b6518b5aa8702`.
  Create / take / cancel, atomic multi-order takes (v2), opt-in partial
  fills with continuation orders (v3), smart fill routing, arbitrage
  scanner. Live-verified on preprod.
- One-command self-hosting: `./ship.sh` (Node only) or
  `docker compose up --build` (production images + PostgreSQL).
- Release images published to GHCR on version tags.
- In-repo adversarial security audit (`Audit/`): on-chain trust boundary
  strong, no way to steal locked value; open High finding **F-01**
  (backend-provided preview — always read your wallet's own display before
  signing).

Prior protocol epochs (pre-release): v2 `4d0a1335…94b8` / `a88c60a8…c9b0`,
v1 `89389051…46ab` / `264ed623…cc0a`.
