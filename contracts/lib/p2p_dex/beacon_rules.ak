//// Beacon minting policy rules — mvp-contract-decisions.md §4.
//// Kept in lib so tests can drive them with fixture transactions directly;
//// validators/beacon.ak is a thin wrapper.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Output, Transaction}
use p2p_dex/beacons
use p2p_dex/types.{OrderDatum}

/// The exact 5-beacon Value for a given datum (amount 1 each).
/// The five names can never collide with each other: "order" is 5 bytes, the
/// owner key hash is 28, and the three sha2_256 names are 32 with distinct
/// domain prefixes — so adding 1 of each always yields quantities of exactly 1.
pub fn beacon_set(
  policy_id: PolicyId,
  datum: OrderDatum,
  owner_key_hash: ByteArray,
) -> Value {
  assets.zero
    |> assets.add(policy_id, beacons.order_beacon_name, 1)
    |> assets.add(policy_id, beacons.pair_beacon_name(datum.offer, datum.ask), 1)
    |> assets.add(policy_id, beacons.offer_beacon_name(datum.offer), 1)
    |> assets.add(policy_id, beacons.ask_beacon_name(datum.ask), 1)
    |> assets.add(policy_id, beacons.owner_beacon_name(owner_key_hash), 1)
}

/// MintBeacons — order creation (the spending validator does not run when a
/// UTxO is created, so everything about a new order is enforced here).
pub fn mint_beacons_ok(
  order_script_hash: ScriptHash,
  policy_id: PolicyId,
  self: Transaction,
) -> Bool {
  // (1) Exactly one output in the tx carries tokens of this policy
  //     (one order per creation tx in MVP; also: no strays anywhere else).
  expect [order_output] =
    list.filter(
      self.outputs,
      fn(o) { !dict.is_empty(assets.tokens(o.value, policy_id)) },
    )

  // (2) That output sits at the order validator's payment credential with the
  //     owner's staking credential inline (CIP-0089 personal address).
  expect Address {
    payment_credential: Script(payment_hash),
    stake_credential: Some(Inline(stake_credential)),
  } = order_output.address

  // (3) Inline datum, parseable as OrderDatum, owner is a key credential.
  expect InlineDatum(raw_datum) = order_output.datum
  expect datum: OrderDatum = raw_datum
  expect VerificationKey(owner_key_hash) = datum.owner

  // payment_address must be a key address (mvp-contract-decisions.md §2).
  let payment_address_is_key =
    when datum.payment_address.payment_credential is {
      VerificationKey(_) -> True
      Script(_) -> False
    }

  // (4) Output value is EXACTLY: deposit lovelace + offer_amount of the offer
  //     asset + the five beacons — nothing else. Lovelace amount is free (the
  //     ledger's min-UTxO rule enforces the real floor; the policy cannot know
  //     it — see docs note on ledger- vs policy-enforced checks).
  let lovelace_in_order = assets.lovelace_of(order_output.value)
  let expected_beacons = beacon_set(policy_id, datum, owner_key_hash)
  let offer_is_ada = beacons.is_ada(datum.offer)
  let expected_value =
    if offer_is_ada {
      assets.from_lovelace(lovelace_in_order)
        |> assets.merge(expected_beacons)
    } else {
      assets.from_lovelace(lovelace_in_order)
        |> assets.add(
            datum.offer.policy_id,
            datum.offer.asset_name,
            datum.offer_amount,
          )
        |> assets.merge(expected_beacons)
    }

  and {
    payment_hash == order_script_hash,
    // Address staking credential is the owner named in the datum.
    stake_credential == datum.owner,
    // Datum field rules (§4.3).
    datum.version == 1,
    datum.beacon_policy_id == policy_id,
    payment_address_is_key,
    datum.offer != datum.ask,
    datum.offer_amount > 0,
    datum.ask_amount > 0,
    // v3: allow_partial_fill is a free seller choice at creation
    // (docs/partial-fills.md) — no constraint here.
    // Beacons are worthless tags; trading them is nonsense and would tangle
    // the burn-all invariant — forbid them as offer or ask.
    datum.offer.policy_id != policy_id,
    datum.ask.policy_id != policy_id,
    // When offering ADA the lovelace must cover the offered amount
    // (deposit = lovelace - offer_amount >= 0).
    if offer_is_ada {
      lovelace_in_order >= datum.offer_amount
    } else {
      True
    },
    // (4) exact value.
    order_output.value == expected_value,
    // (5) The tx's total mint under this policy is exactly the five names,
    //     +1 each — all positive, no extra names, no mixed burn.
    assets.tokens(self.mint, policy_id) == assets.tokens(
      expected_beacons,
      policy_id,
    ),
  }
}

/// BurnBeacons — burn-only, otherwise unconstrained: beacons exist only
/// inside order UTxOs, and spending those always runs the order validator.
pub fn burn_beacons_ok(policy_id: PolicyId, self: Transaction) -> Bool {
  let minted = dict.to_pairs(assets.tokens(self.mint, policy_id))
  when minted is {
    [] -> False
    _ -> list.all(minted, fn(entry) { entry.2nd < 0 })
  }
}
