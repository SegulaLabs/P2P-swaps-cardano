# Beacon Design

Beacon tokens are ordinary Cardano native assets used as **on-chain tags**:
they exist so that off-chain code can find protocol UTxOs by querying a
provider for a (policy id, token name) pair, with no central registry.
The pattern follows the distributed-DApp approach (CIP-0089 — verified
**Active**, "Distributed DApps & Beacon Tokens" — and fallen-icarus protocols
such as cardano-swaps, whose README was reviewed on 2026-07-06).

> **Naming and lifecycle are now DECIDED** — the exact derivation scheme and
> per-action lifecycle table live in
> [mvp-contract-decisions.md](mvp-contract-decisions.md) §3, which supersedes
> the proposals below where they differ (notably: `sha2_256` with `#"00"` /
> `#"01"` / `#"02"` domain prefixes, and UpdateOrder is postponed so **every**
> spend burns all five beacons).

## 1. The five MVP beacons

All five live under **one minting policy** (one policy id for the whole
protocol version). Each valid order UTxO holds exactly one of each.

| Beacon | Question it answers | Token name derivation (proposal ⚠) |
|---|---|---|
| **OrderBeacon** | "Is this a v1 protocol order at all?" | constant bytes, e.g. UTF-8 `"order"` |
| **PairBeacon** | "Which trading pair?" (undirected) | `hash( sort(offer_asset_id, ask_asset_id) )` |
| **OfferBeacon** | "Which asset is being sold?" | `hash( 0x01 ∥ offer_policy ∥ offer_name )` |
| **AskBeacon** | "Which asset is being bought?" | `hash( 0x02 ∥ ask_policy ∥ ask_name )` |
| **OwnerBeacon** | "Whose order is this?" | the owner's 28-byte staking-credential key hash, verbatim |

Derivation notes:

- Token names are capped at **32 bytes**, and a full asset id (28-byte policy
  id + up to 32-byte asset name) doesn't fit — hence hashing. `blake2b_224`
  (28 bytes, available in Aiken stdlib) is the working proposal; the exact
  hash and tag bytes are an open question until fixed in code and tests.
- The `0x01`/`0x02` domain-separation prefixes keep an asset's Offer-name and
  Ask-name distinct, and distinct from a PairBeacon name.
- The PairBeacon is **undirected** (asset ids sorted lexicographically before
  hashing): one query returns both sides of the book for a pair; direction
  comes from the Offer/Ask beacons or the datum.
- ADA is encoded as empty policy id + empty asset name inside the hash input.
- OwnerBeacon uses the raw credential hash (28 bytes fits) so
  `GET /orders/by-owner/:stakeCredential` is a single asset query.

## 2. Lifecycle

| Event | Beacon action | Enforced by |
|---|---|---|
| Create order | mint all 5 into the new order UTxO | minting policy (`MintBeacons`) |
| Take order | burn all 5 | order validator requires the burn; policy allows burn |
| Cancel order | burn all 5 | same |
| Update order (price/expiration only) | beacons move unchanged into the continuation UTxO | order validator (policy not invoked — nothing minted/burned) |

## 3. Why beacons can't be counterfeited or leaked

Two failure modes must be impossible:

1. **Counterfeit**: beacons minted into a non-order UTxO (or an order UTxO
   with bad terms). Prevented by the minting policy: any output holding this
   policy's tokens must sit at the order validator address with a fully valid
   inline datum, the exact 5-beacon set with names matching that datum, and
   the offered asset present. A different policy id is by definition not our
   beacon — indexers only ever query our policy id.
2. **Leak**: real beacons escaping an order UTxO when it is spent. A minting
   policy does *not* run when tokens merely move, so this is the **spending
   validator's job**: every redeemer path either burns the beacons
   (take/cancel) or forces them into a valid continuation order (update).

Residual (accepted) noise: garbage UTxOs at the validator address with **no
beacons** are possible and harmless — discovery is beacon-driven, so honest
software never sees them. The indexer must still verify the full beacon set +
datum before caching anything (defense in depth).

## 4. Discovery / indexing

Provider-agnostic strategy (see `backend/src/services/chain-provider.ts`):

- **By pair** (order book): query UTxOs holding `(policy, PairBeacon(pair))`.
- **By owner** (my orders): query UTxOs holding `(policy, OwnerBeacon(cred))`.
- **All orders** (full sync): query UTxOs holding `(policy, OrderBeacon)`.

Blockfrost exposes asset→addresses/UTxO lookups (⚠ exact endpoints, paging and
rate limits to verify); Kupo can match on `policy_id.*` patterns and is the
planned self-hosted upgrade. The indexer:

1. queries beacon holders → candidate UTxOs;
2. validates: correct address, exact beacon set, well-formed inline datum,
   names re-derived from datum match the actual token names;
3. upserts into PostgreSQL (`orders`, `pairs`, `assets`);
4. marks orders spent/cancelled/taken by watching consumption of those UTxOs
   (tx_history).

The DB is a cache; on any doubt, re-fetch from chain. Front-ends must treat
"order shown" as "order probably still open" — takes can race (eutxo.md §1).

## 5. Deliberate non-features

- No beacon for price levels (needs sorted off-chain index anyway).
- No per-pair minting policies (one policy, many names — fewer scripts to
  audit; revisit only if query patterns demand it ⚠).
- No "beacon = fee token" or any tokenomics. Beacons are tags, worth nothing.
