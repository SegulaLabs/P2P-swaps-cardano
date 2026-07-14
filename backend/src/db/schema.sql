-- P2P Beacon DEX — indexer cache schema (PostgreSQL).
-- THE CHAIN IS THE SOURCE OF TRUTH; every table here is a rebuildable cache
-- except tx_history, which is an append-only audit convenience.
-- Applied automatically by infra/docker-compose.yml on first boot.

CREATE TABLE IF NOT EXISTS assets (
  asset_id        text PRIMARY KEY,          -- 'lovelace' | 'policyHex.nameHex'
  policy_id       text NOT NULL,
  asset_name_hex  text NOT NULL,
  ticker          text,
  display_name    text,
  decimals        integer,                   -- cosmetic; NULL = unknown
  fetched_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO assets (asset_id, policy_id, asset_name_hex, ticker, display_name, decimals)
  VALUES ('lovelace', '', '', 'tADA', 'Preprod ADA', 6)
  ON CONFLICT DO NOTHING;

-- pair_id = the two asset_ids sorted lexicographically, joined by '_'
-- (matches the undirected PairBeacon, mvp-contract-decisions.md §3).
CREATE TABLE IF NOT EXISTS pairs (
  pair_id           text PRIMARY KEY,
  asset_a           text NOT NULL REFERENCES assets(asset_id),
  asset_b           text NOT NULL REFERENCES assets(asset_id),
  pair_beacon_name  text NOT NULL,
  first_seen_slot   bigint,
  CHECK (asset_a < asset_b)
);

-- Seeded by deployment/boot only; no admin mutation surface.
CREATE TABLE IF NOT EXISTS protocol_versions (
  version                 integer PRIMARY KEY,
  network                 text NOT NULL CHECK (network = 'preprod'),
  order_validator_hash    text NOT NULL,
  beacon_policy_id        text NOT NULL,
  is_active               boolean NOT NULL DEFAULT false,
  deployed_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS protocol_versions_one_active
  ON protocol_versions (is_active) WHERE is_active;
-- v3 = partial fills (docs/partial-fills.md). Earlier versions are inserted
-- by operators only if their orders still need draining (v2 = TakeManyOrders,
-- hashes in e2e/blueprint-v2.plutus.json).
INSERT INTO protocol_versions (version, network, order_validator_hash, beacon_policy_id, is_active)
  VALUES (3, 'preprod',
          '1757ecd8fdc1c3d095906f13f17acdf8262a7c2363ac69ddeb256f8b',
          'c14dc44ed1e2025bae03895af442f2fa9d387deb526b6518b5aa8702',
          true)
  ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS reference_scripts (
  script_hash   text PRIMARY KEY,
  version       integer NOT NULL REFERENCES protocol_versions(version),
  purpose       text NOT NULL CHECK (purpose IN ('order-validator','beacon-policy')),
  tx_hash       text NOT NULL,
  output_index  integer NOT NULL,
  UNIQUE (tx_hash, output_index)
);

-- One row per order UTxO ever observed (order_id = 'txHash#index').
CREATE TABLE IF NOT EXISTS orders (
  order_id               text PRIMARY KEY,
  tx_hash                text NOT NULL,
  output_index           integer NOT NULL,
  status                 text NOT NULL CHECK (status IN ('open','taken','partially_filled','cancelled','unknown')),
  version                integer NOT NULL,
  allow_partial_fill     boolean NOT NULL DEFAULT false,
  pair_id                text NOT NULL REFERENCES pairs(pair_id),
  contract_address       text NOT NULL,
  owner_stake_credential text NOT NULL,      -- hex; == OwnerBeacon token name
  payment_address        text NOT NULL,
  offered_policy_id      text NOT NULL,
  offered_asset_name     text NOT NULL,      -- hex
  offered_amount         numeric(38,0) NOT NULL CHECK (offered_amount > 0),
  requested_policy_id    text NOT NULL,
  requested_asset_name   text NOT NULL,      -- hex
  requested_amount       numeric(38,0) NOT NULL CHECK (requested_amount > 0),
  deposit_lovelace       numeric(38,0) NOT NULL,
  pair_beacon            text NOT NULL,
  offer_beacon           text NOT NULL,
  ask_beacon             text NOT NULL,
  owner_beacon           text NOT NULL,
  expiration_posix_ms    bigint,             -- NULL = no expiry
  inline_datum_cbor      text NOT NULL,      -- raw, for re-verification
  created_at_slot        bigint,
  spent_at_slot          bigint,
  created_tx_hash        text,
  spent_tx_hash          text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_by_pair_open
  ON orders (pair_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS orders_by_owner
  ON orders (owner_stake_credential);
CREATE INDEX IF NOT EXISTS orders_by_status
  ON orders (status);

-- Partial-fill lineage (v3): a partial take spends the parent order and the
-- continuation appears as a NEW order row; this table links the chain.
-- root_order_id = the original (first) order in the fill sequence.
CREATE TABLE IF NOT EXISTS order_lineage (
  child_order_id  text PRIMARY KEY,
  parent_order_id text NOT NULL,
  root_order_id   text NOT NULL
);
CREATE INDEX IF NOT EXISTS order_lineage_by_root
  ON order_lineage (root_order_id);

-- Append-only log of classified protocol transactions.
CREATE TABLE IF NOT EXISTS tx_history (
  tx_hash      text NOT NULL,
  order_id     text NOT NULL REFERENCES orders(order_id),
  action       text NOT NULL CHECK (action IN ('create','take','take-partial','cancel','unknown-spend')),
  slot         bigint,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, order_id)
);

-- Single-row sync cursor (exposed as orderbook.syncedToSlot).
CREATE TABLE IF NOT EXISTS indexer_cursor (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  synced_to_slot   bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO indexer_cursor (id) VALUES (true) ON CONFLICT DO NOTHING;
