# Ogmios (placeholder — not used yet)

Future websocket bridge to a self-hosted cardano-node: protocol parameters,
tx evaluation/submission, chain tip — the non-indexing half of dropping
Blockfrost (Kupo covers indexing; see ../kupo/README.md and
docs/deployment.md §7).

Planned when we get here:
- add `cardano-node` (preprod) + `ogmios` services to ../docker-compose.yml
- point the tx-builder's provider implementation at Ogmios for
  params/evaluate/submit
