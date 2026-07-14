//// Shared protocol types for the P2P beacon DEX (MVP, preprod).
//// Spec: docs/protocol-spec.md §2–5. Field semantics must not drift from the
//// spec — update the spec first, then this file.
////
//// ⚠ Written against aiken stdlib v2 module layout (cardano/address,
//// cardano/assets). Verify imports compile against the pinned toolchain
//// before implementing logic (docs/open-questions.md #10).

use cardano/address.{Address, Credential}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{OutputReference}

/// A native asset (or ADA as the empty policy id + empty name).
pub type AssetClass {
  policy_id: PolicyId,
  asset_name: AssetName,
}

/// Inline datum attached to every order UTxO.
pub type OrderDatum {
  /// Protocol version; 1 for MVP.
  version: Int,
  /// The beacon policy id; checked by the minting policy at creation to equal
  /// its own hash, so spending code may trust it afterwards.
  beacon_policy_id: PolicyId,
  /// Owner's STAKING credential. MVP: must be a VerificationKey credential
  /// (script owners rejected at mint time — open-questions #8).
  owner: Credential,
  /// Where the ask payment must go on TakeOrder.
  payment_address: Address,
  /// Asset being sold.
  offer: AssetClass,
  /// Amount of `offer` locked in the order. Strictly positive.
  offer_amount: Int,
  /// Asset the owner wants in return.
  ask: AssetClass,
  /// Amount of `ask` that must reach `payment_address`. Strictly positive.
  ask_amount: Int,
  /// Optional expiry as POSIX time in ms (NOT a slot — docs/eutxo.md §6).
  expiration: Option<Int>,
  /// Seller opt-in to partial fills (v3, docs/partial-fills.md). When True the
  /// order may be consumed piecewise via TakeOrderPartial, each fill leaving a
  /// continuation order with proportionally reduced amounts. When False the
  /// order is full-fill-only (v2 semantics).
  allow_partial_fill: Bool,
}

/// Inline datum REQUIRED on every TakeOrder seller-payment output (v2).
/// Naming the consumed order's OutputReference makes the order→payment
/// mapping 1:1 (injective), which is what keeps double satisfaction closed
/// now that one transaction may take many orders — docs/take-many-orders.md §3.
pub type PaymentTag {
  /// The OutputReference of the order UTxO this output settles.
  order_ref: OutputReference,
}

/// Spending redeemers for the order validator.
/// UpdateOrder is deliberately absent — postponed post-MVP so that every
/// full spend destroys all beacons (docs/mvp-contract-decisions.md §7).
/// Constructor indices are load-bearing off-chain (indexer classification):
/// 0 = Cancel, 1 = Take, 2 = TakeOrderPartial — append only.
pub type OrderRedeemer {
  /// Owner reclaims the order; all beacons destroyed.
  CancelOrder
  /// Full fill: exact tagged payment (ask + deposit) to `payment_address`,
  /// all beacons destroyed. v2: many orders may be taken in one tx — each
  /// needs its own PaymentTag-tagged payment output.
  TakeOrder
  /// v3 partial fill (requires datum.allow_partial_fill): consume
  /// `take_amount` of the offer, pay ceil(take_amount * ask / offer) of the
  /// ask (deposit NOT returned), and recreate the order as a continuation
  /// output carrying the deposit, the remaining offer, all five beacons, and
  /// the reduced datum — docs/partial-fills.md.
  TakeOrderPartial { take_amount: Int }
}

/// Minting redeemers for the beacon policy.
pub type BeaconRedeemer {
  /// Mint the exact 5-beacon set into valid order outputs only.
  MintBeacons
  /// Burn-only (all amounts negative). Safe unconditionally: spending the
  /// UTxO that holds beacons always runs the order validator.
  BurnBeacons
}
