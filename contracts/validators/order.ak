//// Order spending validator — thin wrapper over p2p_dex/order_rules
//// (rules live in lib so tests can drive them with fixture transactions).
//// Implementation contract: docs/mvp-contract-decisions.md §5/§6/§8.
////
//// Runs ONLY when an order UTxO is spent; creation is enforced by the beacon
//// minting policy (validators/beacon.ak). UpdateOrder is postponed post-MVP
//// (mvp-contract-decisions.md §7). v3: cancels and full takes destroy all
//// five beacons; partial takes (docs/partial-fills.md) instead carry them
//// into an exactly-checked continuation order output.

use cardano/transaction.{OutputReference, Transaction}
use p2p_dex/order_rules
use p2p_dex/types.{
  CancelOrder, OrderDatum, OrderRedeemer, TakeOrder, TakeOrderPartial,
}

validator order {
  spend(
    datum: Option<OrderDatum>,
    redeemer: OrderRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    // A UTxO parked here without a parseable OrderDatum is permanently
    // unspendable — accepted by design (mvp-contract-decisions.md §5 note).
    expect Some(order_datum) = datum

    when redeemer is {
      CancelOrder -> order_rules.cancel_ok(order_datum, own_ref, self)
      TakeOrder -> order_rules.take_ok(order_datum, own_ref, self)
      TakeOrderPartial { take_amount } ->
        order_rules.take_partial_ok(order_datum, take_amount, own_ref, self)
    }
  }

  // Any other purpose (mint/withdraw/publish/...) is invalid for this script.
  else(_) {
    fail
  }
}
