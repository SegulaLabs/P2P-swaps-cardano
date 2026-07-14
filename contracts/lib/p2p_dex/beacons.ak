//// Pure beacon token-name derivation — mvp-contract-decisions.md §3.
////
//// Scheme (all under the single beacon policy):
////   OrderBeacon = constant ASCII "order"
////   PairBeacon  = sha2_256(#"00" ++ lp(id_lo) ++ lp(id_hi))   (undirected)
////   OfferBeacon = sha2_256(#"01" ++ offer_id)
////   AskBeacon   = sha2_256(#"02" ++ ask_id)
////   OwnerBeacon = owner staking key hash, verbatim (28 bytes)
//// where id = policy_id ++ asset_name, (id_lo, id_hi) is the pair's ids
//// sorted lexicographically, and lp(x) = length_byte(x) ++ x.
////
//// IMPLEMENTATION REFINEMENT over MCD §3 (documented there under
//// "implementation deviations"): the pair encoding length-prefixes each
//// asset id. Without it, the variable-length asset-name boundary makes two
//// different pairs able to produce the same concatenation (asset ids in a
//// datum need not exist on-chain, so the ambiguity would be exploitable for
//// order-book spam). Offer/Ask names need no prefix: a single id parses
//// unambiguously because the policy id is fixed 28 bytes.
////
//// The backend mirrors this derivation byte-for-byte
//// (backend/src/services/beacons.ts) — change both together or neither.

use aiken/crypto.{VerificationKeyHash, sha2_256}
use aiken/primitive/bytearray
use cardano/assets.{AssetName, ada_asset_name, ada_policy_id}
use p2p_dex/types.{AssetClass}

/// Constant OrderBeacon token name: ASCII "order" (#"6f72646572").
pub const order_beacon_name: AssetName = "order"

/// ADA/lovelace is encoded as the empty policy id + empty asset name.
pub fn is_ada(a: AssetClass) -> Bool {
  a.policy_id == ada_policy_id && a.asset_name == ada_asset_name
}

/// Raw asset id: policy_id ++ asset_name (empty for ADA).
pub fn asset_id(a: AssetClass) -> ByteArray {
  bytearray.concat(a.policy_id, a.asset_name)
}

/// Length-prefixed asset id (length always fits one byte: 28 + 32 max).
fn length_prefixed(id: ByteArray) -> ByteArray {
  bytearray.push(id, bytearray.length(id))
}

/// Undirected pair beacon: same name whichever side is offered.
pub fn pair_beacon_name(a: AssetClass, b: AssetClass) -> AssetName {
  let ia = asset_id(a)
  let ib = asset_id(b)
  let body =
    when bytearray.compare(ia, ib) is {
      Less -> bytearray.concat(length_prefixed(ia), length_prefixed(ib))
      _ -> bytearray.concat(length_prefixed(ib), length_prefixed(ia))
    }
  sha2_256(bytearray.push(body, 0x00))
}

pub fn offer_beacon_name(offer: AssetClass) -> AssetName {
  sha2_256(bytearray.push(asset_id(offer), 0x01))
}

pub fn ask_beacon_name(ask: AssetClass) -> AssetName {
  sha2_256(bytearray.push(asset_id(ask), 0x02))
}

/// OwnerBeacon: the owner's staking key hash, verbatim (28 bytes — fits the
/// 32-byte token-name limit and makes by-owner asset queries direct).
pub fn owner_beacon_name(owner_key_hash: VerificationKeyHash) -> AssetName {
  owner_key_hash
}
