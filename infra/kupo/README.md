# Kupo (placeholder — not used yet)

Future self-hosted chain indexer, replacing Blockfrost for order discovery
(docs/deployment.md §7). Kupo can match UTxOs by pattern — including
`<beacon-policy-id>.*` — which fits beacon discovery exactly and handles
rollbacks natively.

Planned when we get here:
- add a `kupo` service to ../docker-compose.yml (needs ogmios/cardano-node)
- match patterns: the beacon policy id, the order validator address
- implement `KupoProvider` against the `ChainProvider` interface
  (backend/src/services/chain-provider.ts) and diff it against Blockfrost on
  preprod before switching
