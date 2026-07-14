//// Beacon minting policy — thin wrapper over p2p_dex/beacon_rules
//// (rules live in lib so tests can drive them with fixture transactions).
//// Implementation contract: docs/mvp-contract-decisions.md §3/§4.
////
//// This policy enforces ORDER CREATION (spending validators don't run when a
//// UTxO is created). Parameterized by the order validator's script hash —
//// that one-directional dependency resolves the validator↔policy cycle
//// (protocol-spec.md §1.1). Parameter application: `aiken blueprint apply`
//// (see contracts/README.md).

use aiken/crypto.{ScriptHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use p2p_dex/beacon_rules
use p2p_dex/types.{BeaconRedeemer, BurnBeacons, MintBeacons}

validator beacon(order_script_hash: ScriptHash) {
  mint(redeemer: BeaconRedeemer, policy_id: PolicyId, self: Transaction) {
    when redeemer is {
      MintBeacons ->
        beacon_rules.mint_beacons_ok(order_script_hash, policy_id, self)
      BurnBeacons -> beacon_rules.burn_beacons_ok(policy_id, self)
    }
  }

  // The beacon policy has no other purpose.
  else(_) {
    fail
  }
}
