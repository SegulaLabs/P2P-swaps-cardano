//// Shared test fixtures: deterministic keys/hashes and builders for order
//// outputs, spend inputs, and transactions. Test-only module.

use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{AssetName, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, ScriptPurpose, Spend,
  Transaction,
}
use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/interval.{Finite, Interval, IntervalBound, NegativeInfinity}
use p2p_dex/beacon_rules
use p2p_dex/types.{
  AssetClass, CancelOrder, OrderDatum, OrderRedeemer, PaymentTag, TakeOrder,
  TakeOrderPartial,
}

// ---------------------------------------------------------------- constants

pub const order_hash: ScriptHash =
  #"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"

pub const beacon_policy =
  #"0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e"

pub const owner_key: VerificationKeyHash =
  #"01010101010101010101010101010101010101010101010101010101"

pub const other_key: VerificationKeyHash =
  #"02020202020202020202020202020202020202020202020202020202"

pub const seller_payment_key: VerificationKeyHash =
  #"03030303030303030303030303030303030303030303030303030303"

pub const taker_key: VerificationKeyHash =
  #"04040404040404040404040404040404040404040404040404040404"

const tx_id_1 =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"

const tx_id_2 =
  #"d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2"

pub const default_deposit = 2_000_000

// ------------------------------------------------------------------- assets

pub fn ada() -> AssetClass {
  AssetClass { policy_id: "", asset_name: "" }
}

pub fn token_a() -> AssetClass {
  AssetClass {
    policy_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    asset_name: "TOKA",
  }
}

pub fn token_b() -> AssetClass {
  AssetClass {
    policy_id: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    asset_name: "TOKB",
  }
}

// ------------------------------------------------------------------- datums

/// Offer 100 TOKA, ask 250 TOKB, no expiration.
pub fn base_datum() -> OrderDatum {
  OrderDatum {
    version: 1,
    beacon_policy_id: beacon_policy,
    owner: VerificationKey(owner_key),
    payment_address: Address {
      payment_credential: VerificationKey(seller_payment_key),
      stake_credential: None,
    },
    offer: token_a(),
    offer_amount: 100,
    ask: token_b(),
    ask_amount: 250,
    expiration: None,
    allow_partial_fill: False,
  }
}

pub fn ada_offer_datum() -> OrderDatum {
  OrderDatum { ..base_datum(), offer: ada(), offer_amount: 5_000_000 }
}

pub fn ada_ask_datum() -> OrderDatum {
  OrderDatum { ..base_datum(), ask: ada(), ask_amount: 5_000_000 }
}

/// v3: the base order with partial fills enabled.
pub fn partial_datum() -> OrderDatum {
  OrderDatum { ..base_datum(), allow_partial_fill: True }
}

pub fn ada_offer_partial_datum() -> OrderDatum {
  OrderDatum { ..ada_offer_datum(), allow_partial_fill: True }
}

pub fn ada_ask_partial_datum() -> OrderDatum {
  OrderDatum { ..ada_ask_datum(), allow_partial_fill: True }
}

/// Mirror of order_rules.required_payment: ceil(take * ask / offer).
pub fn required_of(take: Int, datum: OrderDatum) -> Int {
  ( take * datum.ask_amount + datum.offer_amount - 1 ) / datum.offer_amount
}

/// The continuation datum a valid partial fill of `take` must produce.
pub fn reduced_datum(datum: OrderDatum, take: Int) -> OrderDatum {
  OrderDatum {
    ..datum,
    offer_amount: datum.offer_amount - take,
    ask_amount: datum.ask_amount - required_of(take, datum),
  }
}

// ---------------------------------------------------------------- addresses

pub fn order_address(stake_key: VerificationKeyHash) -> Address {
  Address {
    payment_credential: Script(order_hash),
    stake_credential: Some(Inline(VerificationKey(stake_key))),
  }
}

pub fn key_address(key: VerificationKeyHash) -> Address {
  Address { payment_credential: VerificationKey(key), stake_credential: None }
}

// ------------------------------------------------------------------- values

/// The exact 5-beacon set for a datum (assumes key owner).
pub fn full_beacons(datum: OrderDatum) -> Value {
  expect VerificationKey(owner) = datum.owner
  beacon_rules.beacon_set(datum.beacon_policy_id, datum, owner)
}

/// Arbitrary beacon-policy token bundle, for adversarial variants.
pub fn beacons_of(entries: List<(AssetName, Int)>) -> Value {
  list.foldl(
    entries,
    assets.zero,
    fn(entry, acc) { assets.add(acc, beacon_policy, entry.1st, entry.2nd) },
  )
}

/// A well-formed order UTxO value: deposit + offer + all five beacons.
pub fn order_value(datum: OrderDatum, deposit: Int) -> Value {
  let base =
    if datum.offer == ada() {
      assets.from_lovelace(datum.offer_amount + deposit)
    } else {
      assets.from_lovelace(deposit)
        |> assets.add(
            datum.offer.policy_id,
            datum.offer.asset_name,
            datum.offer_amount,
          )
    }
  assets.merge(base, full_beacons(datum))
}

// ------------------------------------------------------------------ outputs

pub fn order_output(datum: OrderDatum, value: Value) -> Output {
  Output {
    address: order_address(owner_key),
    value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

/// The exact seller payment for a take: ask amount + returned deposit,
/// tagged (v2) with the consumed order's OutputReference.
pub fn payment_output(
  datum: OrderDatum,
  deposit: Int,
  ref: OutputReference,
) -> Output {
  let value =
    if datum.ask == ada() {
      assets.from_lovelace(datum.ask_amount + deposit)
    } else {
      assets.from_lovelace(deposit)
        |> assets.add(
            datum.ask.policy_id,
            datum.ask.asset_name,
            datum.ask_amount,
          )
    }
  Output {
    address: datum.payment_address,
    value,
    datum: InlineDatum(PaymentTag { order_ref: ref }),
    reference_script: None,
  }
}

/// v3: the continuation output a valid partial fill of `take` must recreate —
/// the consumed order's exact value minus the taken offer (deposit + remaining
/// offer + all five beacons), under the reduced datum, at the same address.
pub fn continuation_output(datum: OrderDatum, deposit: Int, take: Int) -> Output {
  Output {
    address: order_address(owner_key),
    value: assets.add(
      order_value(datum, deposit),
      datum.offer.policy_id,
      datum.offer.asset_name,
      -take,
    ),
    datum: InlineDatum(reduced_datum(datum, take)),
    reference_script: None,
  }
}

/// v3: the tagged partial payment — exactly required_of(take) of the ask.
/// No deposit is returned; on token asks the TAKER funds the output's
/// min-ADA (fixed at 1.4 tADA here for realism).
pub fn partial_payment_output(
  datum: OrderDatum,
  take: Int,
  ref: OutputReference,
) -> Output {
  let required = required_of(take, datum)
  let value =
    if datum.ask == ada() {
      assets.from_lovelace(required)
    } else {
      assets.from_lovelace(1_400_000)
        |> assets.add(datum.ask.policy_id, datum.ask.asset_name, required)
    }
  Output {
    address: datum.payment_address,
    value,
    datum: InlineDatum(PaymentTag { order_ref: ref }),
    reference_script: None,
  }
}

/// What the taker keeps (not validated on-chain; realism only).
pub fn buyer_output(datum: OrderDatum) -> Output {
  let value =
    if datum.offer == ada() {
      assets.from_lovelace(datum.offer_amount)
    } else {
      assets.from_lovelace(1_000_000)
        |> assets.add(
            datum.offer.policy_id,
            datum.offer.asset_name,
            datum.offer_amount,
          )
    }
  Output {
    address: key_address(taker_key),
    value,
    datum: NoDatum,
    reference_script: None,
  }
}

// ------------------------------------------------------------------- inputs

pub fn own_ref() -> OutputReference {
  OutputReference { transaction_id: tx_id_1, output_index: 0 }
}

/// The second order's reference (batch/double-satisfaction fixtures).
pub fn second_ref() -> OutputReference {
  OutputReference { transaction_id: tx_id_2, output_index: 1 }
}

pub fn order_input(datum: OrderDatum, deposit: Int) -> Input {
  Input {
    output_reference: own_ref(),
    output: order_output(datum, order_value(datum, deposit)),
  }
}

/// A second, distinct order input (batch/double-satisfaction fixtures).
pub fn second_order_input(datum: OrderDatum, deposit: Int) -> Input {
  Input {
    output_reference: second_ref(),
    output: order_output(datum, order_value(datum, deposit)),
  }
}

/// Plain wallet funding input (fees/collateral realism).
pub fn wallet_input(key: VerificationKeyHash) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: tx_id_2,
      output_index: 0,
    },
    output: Output {
      address: key_address(key),
      value: assets.from_lovelace(10_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// ------------------------------------------------------------- transactions

/// One entry of the tx redeemer map. v3 rules read sibling spend redeemers
/// (rank pairing), so spend fixtures must populate Transaction.redeemers the
/// way the ledger does.
pub fn spend_redeemer(
  ref: OutputReference,
  redeemer: OrderRedeemer,
) -> Pair<ScriptPurpose, Data> {
  let raw: Data = redeemer
  Pair(Spend(ref), raw)
}

/// Creation tx: one order output + the matching beacon mint by default.
pub fn create_tx(outputs: List<Output>, mint: Value) -> Transaction {
  Transaction { ..transaction.placeholder, outputs: outputs, mint: mint }
}

pub fn valid_create_tx(datum: OrderDatum, deposit: Int) -> Transaction {
  create_tx(
    [order_output(datum, order_value(datum, deposit))],
    full_beacons(datum),
  )
}

/// Spend tx: order input + taker/owner wallet input, given outputs, burning
/// the five beacons in the mint field (rules check outputs, not mint — the
/// burn is here for ledger realism). Redeemer defaults to TakeOrder;
/// valid_cancel_tx overrides it (only take paths ever read redeemers).
pub fn spend_tx(
  datum: OrderDatum,
  deposit: Int,
  outputs: List<Output>,
  signatories: List<VerificationKeyHash>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [wallet_input(taker_key), order_input(datum, deposit)],
    outputs: outputs,
    mint: assets.negate(full_beacons(datum)),
    extra_signatories: signatories,
    redeemers: [spend_redeemer(own_ref(), TakeOrder)],
  }
}

pub fn valid_cancel_tx(datum: OrderDatum, deposit: Int) -> Transaction {
  let return_value =
    if datum.offer == ada() {
      assets.from_lovelace(datum.offer_amount + deposit)
    } else {
      assets.from_lovelace(deposit)
        |> assets.add(
            datum.offer.policy_id,
            datum.offer.asset_name,
            datum.offer_amount,
          )
    }
  let base =
    spend_tx(
      datum,
      deposit,
      [
        Output {
          address: key_address(owner_key),
          value: return_value,
          datum: NoDatum,
          reference_script: None,
        },
      ],
      [owner_key],
    )
  Transaction { ..base, redeemers: [spend_redeemer(own_ref(), CancelOrder)] }
}

pub fn valid_take_tx(datum: OrderDatum, deposit: Int) -> Transaction {
  spend_tx(
    datum,
    deposit,
    [payment_output(datum, deposit, own_ref()), buyer_output(datum)],
    [],
  )
}

/// v2 batch: TWO order inputs taken in one tx, each with its own tagged
/// payment. Same datum for both — the tags alone must disambiguate.
pub fn valid_batch_take_tx(datum: OrderDatum, deposit: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      wallet_input(taker_key),
      order_input(datum, deposit),
      second_order_input(datum, deposit),
    ],
    outputs: [
      payment_output(datum, deposit, own_ref()),
      payment_output(datum, deposit, second_ref()),
      buyer_output(datum),
    ],
    mint: assets.negate(
      assets.merge(full_beacons(datum), full_beacons(datum)),
    ),
    extra_signatories: [],
    redeemers: [
      spend_redeemer(own_ref(), TakeOrder),
      spend_redeemer(second_ref(), TakeOrder),
    ],
  }
}

/// v3: a single valid partial take of `take` units. Pure-partial txs burn
/// nothing — the beacons ride into the continuation and the mint policy
/// never runs.
pub fn valid_partial_take_tx(
  datum: OrderDatum,
  deposit: Int,
  take: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [wallet_input(taker_key), order_input(datum, deposit)],
    outputs: [
      partial_payment_output(datum, take, own_ref()),
      continuation_output(datum, deposit, take),
      buyer_output(datum),
    ],
    redeemers: [spend_redeemer(own_ref(), TakeOrderPartial { take_amount: take })],
  }
}

/// v3 mixed batch: order #1 (own_ref) fully taken, order #2 (second_ref)
/// partially taken. Inputs listed in ledger (ascending outref) order; only
/// the full order's beacons are burned.
pub fn valid_mixed_batch_tx(
  full_datum: OrderDatum,
  part_datum: OrderDatum,
  deposit: Int,
  take: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      order_input(full_datum, deposit),
      wallet_input(taker_key),
      second_order_input(part_datum, deposit),
    ],
    outputs: [
      payment_output(full_datum, deposit, own_ref()),
      partial_payment_output(part_datum, take, second_ref()),
      continuation_output(part_datum, deposit, take),
      buyer_output(full_datum),
    ],
    mint: assets.negate(full_beacons(full_datum)),
    redeemers: [
      spend_redeemer(own_ref(), TakeOrder),
      spend_redeemer(second_ref(), TakeOrderPartial { take_amount: take }),
    ],
  }
}

/// v3 twin batch: TWO byte-identical partial-enabled orders partially taken
/// in one tx — the attack shape rank pairing exists for, as a positive
/// fixture: two continuations, in the same relative order as the inputs
/// (own_ref ranks 0, second_ref ranks 1).
pub fn valid_twin_partial_batch_tx(
  datum: OrderDatum,
  deposit: Int,
  take_1: Int,
  take_2: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      order_input(datum, deposit),
      wallet_input(taker_key),
      second_order_input(datum, deposit),
    ],
    outputs: [
      partial_payment_output(datum, take_1, own_ref()),
      partial_payment_output(datum, take_2, second_ref()),
      continuation_output(datum, deposit, take_1),
      continuation_output(datum, deposit, take_2),
      buyer_output(datum),
    ],
    redeemers: [
      spend_redeemer(own_ref(), TakeOrderPartial { take_amount: take_1 }),
      spend_redeemer(second_ref(), TakeOrderPartial { take_amount: take_2 }),
    ],
  }
}

/// Validity range with a finite upper bound (expiration fixtures).
pub fn range_with_upper(upper: Int) -> Interval<Int> {
  Interval {
    lower_bound: IntervalBound {
      bound_type: NegativeInfinity,
      is_inclusive: True,
    },
    upper_bound: IntervalBound { bound_type: Finite(upper), is_inclusive: True },
  }
}
