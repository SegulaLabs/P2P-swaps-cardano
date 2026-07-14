//// Order validator tests — the adversarial list from
//// mvp-contract-decisions.md §11 steps 4–5.
////
//// Deliberately absent (per MCD, which wins over generic checklists):
////  - "offered asset returns to owner" / "deposit returns to owner" on
////    Cancel: the owner's signature IS the guarantee (MCD §5) — with the
////    owner signing, all released value is under their control by
////    construction; no output constraint exists to test.
////  - "buyer receives the offered asset" on Take: the taker authors the tx,
////    so value conservation routes the offer wherever they direct (MCD §6);
////    there is no on-chain check to test.
////  - continuation outputs WITHOUT beacons are allowed on purpose (they are
////    donations, invisible to discovery) — covered by positive tests below.

use cardano/address.{VerificationKey}
use cardano/assets
use cardano/transaction.{InlineDatum, NoDatum, Output, Transaction}
use p2p_dex/order_rules.{cancel_ok, take_ok, take_partial_ok}
use p2p_dex/types.{OrderDatum}
use tests/fixtures as f

// ================================================================== Cancel

test valid_cancel_passes() {
  cancel_ok(
    f.base_datum(),
    f.own_ref(),
    f.valid_cancel_tx(f.base_datum(), f.default_deposit),
  )
}

test valid_cancel_ada_offer_passes() {
  cancel_ok(
    f.ada_offer_datum(),
    f.own_ref(),
    f.valid_cancel_tx(f.ada_offer_datum(), f.default_deposit),
  )
}

test cancel_by_non_owner_fails() {
  let d = f.base_datum()
  let tx =
    Transaction {
      ..f.valid_cancel_tx(d, f.default_deposit),
      extra_signatories: [f.other_key],
    }
  !cancel_ok(d, f.own_ref(), tx)
}

test cancel_without_signature_fails() {
  let d = f.base_datum()
  let tx =
    Transaction {
      ..f.valid_cancel_tx(d, f.default_deposit),
      extra_signatories: [],
    }
  !cancel_ok(d, f.own_ref(), tx)
}

test cancel_with_beacon_leakage_fails() {
  // One beacon smuggled into the owner's return output instead of burned.
  let d = f.base_datum()
  let leaky =
    Output {
      address: f.key_address(f.owner_key),
      value: assets.from_lovelace(f.default_deposit)
        |> assets.add(d.offer.policy_id, d.offer.asset_name, d.offer_amount)
        |> assets.add(d.beacon_policy_id, "order", 1),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    Transaction { ..f.valid_cancel_tx(d, f.default_deposit), outputs: [leaky] }
  !cancel_ok(d, f.own_ref(), tx)
}

test cancel_with_two_order_inputs_fails() {
  let d = f.base_datum()
  let base = f.valid_cancel_tx(d, f.default_deposit)
  let tx =
    Transaction {
      ..base,
      inputs: [f.second_order_input(d, f.default_deposit), ..base.inputs],
    }
  !cancel_ok(d, f.own_ref(), tx)
}

test cancel_with_beaconed_continuation_fails() {
  // "Continuation order" = full order UTxO recreated at the validator: its
  // beacons in an output violate the burn-all rule.
  let d = f.base_datum()
  let continuation =
    f.order_output(d, f.order_value(d, f.default_deposit))
  let tx =
    Transaction {
      ..f.valid_cancel_tx(d, f.default_deposit),
      outputs: [continuation],
    }
  !cancel_ok(d, f.own_ref(), tx)
}

test cancel_with_beaconless_donation_output_passes() {
  // A beacon-less output at the validator address is a harmless donation
  // (invisible to discovery) — allowed by design.
  let d = f.base_datum()
  let donation =
    Output {
      address: f.order_address(f.owner_key),
      value: assets.from_lovelace(1_000_000),
      datum: InlineDatum(d),
      reference_script: None,
    }
  let base = f.valid_cancel_tx(d, f.default_deposit)
  let tx = Transaction { ..base, outputs: [donation, ..base.outputs] }
  cancel_ok(d, f.own_ref(), tx)
}

// ==================================================================== Take

test valid_take_passes() {
  take_ok(
    f.base_datum(),
    f.own_ref(),
    f.valid_take_tx(f.base_datum(), f.default_deposit),
  )
}

test valid_take_ada_offer_passes() {
  take_ok(
    f.ada_offer_datum(),
    f.own_ref(),
    f.valid_take_tx(f.ada_offer_datum(), f.default_deposit),
  )
}

test valid_take_ada_ask_passes() {
  take_ok(
    f.ada_ask_datum(),
    f.own_ref(),
    f.valid_take_tx(f.ada_ask_datum(), f.default_deposit),
  )
}

fn take_with_payment(datum: OrderDatum, payment: Output) -> Transaction {
  Transaction {
    ..f.valid_take_tx(datum, f.default_deposit),
    outputs: [payment, f.buyer_output(datum)],
  }
}

test take_underpays_ask_fails() {
  let d = f.base_datum()
  let short =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      value: assets.from_lovelace(f.default_deposit)
        |> assets.add(d.ask.policy_id, d.ask.asset_name, d.ask_amount - 1),
    }
  !take_ok(d, f.own_ref(), take_with_payment(d, short))
}

test take_partial_fill_attempt_fails() {
  // "Fill half, pay half" — exactness rejects any amount != ask_amount.
  let d = f.base_datum()
  let half =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      value: assets.from_lovelace(f.default_deposit)
        |> assets.add(d.ask.policy_id, d.ask.asset_name, d.ask_amount / 2),
    }
  !take_ok(d, f.own_ref(), take_with_payment(d, half))
}

test take_overpays_ask_fails() {
  // Exact means exact — over-delivery is rejected too (keeps previews and
  // future batching semantics unambiguous; documented in MCD §2).
  let d = f.base_datum()
  let over =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      value: assets.from_lovelace(f.default_deposit)
        |> assets.add(d.ask.policy_id, d.ask.asset_name, d.ask_amount + 1),
    }
  !take_ok(d, f.own_ref(), take_with_payment(d, over))
}

test take_pays_wrong_asset_fails() {
  let d = f.base_datum()
  let wrong =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      value: assets.from_lovelace(f.default_deposit)
        |> assets.add(f.token_a().policy_id, f.token_a().asset_name, d.ask_amount),
    }
  !take_ok(d, f.own_ref(), take_with_payment(d, wrong))
}

test take_missing_seller_payment_fails() fail {
  // expect [payment] crashes when no tagged payment output exists at all.
  let d = f.base_datum()
  let tx =
    Transaction {
      ..f.valid_take_tx(d, f.default_deposit),
      outputs: [f.buyer_output(d)],
    }
  take_ok(d, f.own_ref(), tx)
}

test take_payment_untagged_fails() fail {
  // v2: a correct payment WITHOUT the PaymentTag datum is invisible to the
  // tag filter — expect [payment] crashes on the empty list.
  let d = f.base_datum()
  let untagged =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      datum: NoDatum,
    }
  take_ok(d, f.own_ref(), take_with_payment(d, untagged))
}

test take_payment_with_wrong_tag_fails() fail {
  // v2: tagged with a DIFFERENT order's reference — not this order's payment.
  let d = f.base_datum()
  let wrong_tag = f.payment_output(d, f.default_deposit, f.second_ref())
  take_ok(d, f.own_ref(), take_with_payment(d, wrong_tag))
}

test take_tagged_payment_at_wrong_address_fails() {
  // v2: right tag, right value, wrong destination.
  let d = f.base_datum()
  let hijacked =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      address: f.key_address(f.taker_key),
    }
  !take_ok(d, f.own_ref(), take_with_payment(d, hijacked))
}

test take_with_duplicate_tag_outputs_fails() fail {
  // v2: two outputs tagged with the SAME order ref — ambiguous, rejected
  // (expect [payment] crashes on a 2-element list).
  let d = f.base_datum()
  let base = f.valid_take_tx(d, f.default_deposit)
  let dup = f.payment_output(d, f.default_deposit, f.own_ref())
  take_ok(d, f.own_ref(), Transaction { ..base, outputs: [dup, ..base.outputs] })
}

test take_with_untagged_extra_output_to_seller_passes() {
  // v2: the tag identifies the payment, so extra UNTAGGED value at the
  // seller's address (e.g. taker change on a self-take) is a harmless gift —
  // the old "exactly one output at payment_address" rule is retired.
  let d = f.base_datum()
  let base = f.valid_take_tx(d, f.default_deposit)
  let change_to_seller =
    Output {
      address: d.payment_address,
      value: assets.from_lovelace(3_000_000),
      datum: NoDatum,
      reference_script: None,
    }
  take_ok(
    d,
    f.own_ref(),
    Transaction { ..base, outputs: [change_to_seller, ..base.outputs] },
  )
}

test take_payment_with_foreign_asset_fails() {
  let d = f.base_datum()
  let tainted =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      value: assets.from_lovelace(f.default_deposit)
        |> assets.add(d.ask.policy_id, d.ask.asset_name, d.ask_amount)
        |> assets.add(f.token_a().policy_id, f.token_a().asset_name, 1),
    }
  !take_ok(d, f.own_ref(), take_with_payment(d, tainted))
}

test take_payment_with_foreign_datum_fails() fail {
  // A payment carrying some OTHER inline datum (here: an OrderDatum) fails
  // the soft-cast to PaymentTag gracefully — the output is simply not a
  // recognized payment, so no tagged output exists and the run crashes.
  let d = f.base_datum()
  let with_datum =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      datum: InlineDatum(d),
    }
  take_ok(d, f.own_ref(), take_with_payment(d, with_datum))
}

test take_shorts_deposit_return_fails() {
  let d = f.base_datum()
  let short_deposit =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      value: assets.from_lovelace(f.default_deposit - 1)
        |> assets.add(d.ask.policy_id, d.ask.asset_name, d.ask_amount),
    }
  !take_ok(d, f.own_ref(), take_with_payment(d, short_deposit))
}

test take_ada_ask_shorts_deposit_fails() {
  let d = f.ada_ask_datum()
  let short =
    Output {
      ..f.payment_output(d, f.default_deposit, f.own_ref()),
      value: assets.from_lovelace(d.ask_amount + f.default_deposit - 1),
    }
  !take_ok(d, f.own_ref(), take_with_payment(d, short))
}

test take_with_beacon_leakage_fails() {
  // A single beacon rerouted into the buyer's output instead of burned.
  let d = f.base_datum()
  let base = f.valid_take_tx(d, f.default_deposit)
  let leaky_buyer =
    Output {
      ..f.buyer_output(d),
      value: assets.from_lovelace(1_000_000)
        |> assets.add(d.offer.policy_id, d.offer.asset_name, d.offer_amount)
        |> assets.add(d.beacon_policy_id, "order", 1),
    }
  let tx =
    Transaction {
      ..base,
      outputs: [f.payment_output(d, f.default_deposit, f.own_ref()), leaky_buyer],
    }
  !take_ok(d, f.own_ref(), tx)
}

// ======================================================= v2 batched takes

test batch_take_two_orders_passes() {
  // The headline v2 feature: two orders, ONE tx, each validator run finds its
  // own tagged payment. Same datum on both orders — tags alone disambiguate.
  let d = f.base_datum()
  let tx = f.valid_batch_take_tx(d, f.default_deposit)
  and {
    take_ok(d, f.own_ref(), tx),
    take_ok(d, f.second_ref(), tx),
  }
}

test batch_take_double_satisfaction_fails() fail {
  // THE attack TakeManyOrders must block: two order inputs, but only ONE
  // payment output (tagged for the first order). The first order validates;
  // the second finds no output tagged with ITS ref and crashes — the seller
  // of order #2 cannot be shorted by a shared payment.
  let d = f.base_datum()
  let base = f.valid_batch_take_tx(d, f.default_deposit)
  let tx =
    Transaction {
      ..base,
      outputs: [
        f.payment_output(d, f.default_deposit, f.own_ref()),
        f.buyer_output(d),
      ],
    }
  and {
    take_ok(d, f.own_ref(), tx),
    take_ok(d, f.second_ref(), tx),
  }
}

test batch_take_underpaying_second_order_fails() {
  // Both payments present, but order #2's payment is short by 1 — its own
  // exact-value check rejects it (order #1 is unaffected).
  let d = f.base_datum()
  let base = f.valid_batch_take_tx(d, f.default_deposit)
  let short_second =
    Output {
      ..f.payment_output(d, f.default_deposit, f.second_ref()),
      value: assets.from_lovelace(f.default_deposit)
        |> assets.add(d.ask.policy_id, d.ask.asset_name, d.ask_amount - 1),
    }
  let tx =
    Transaction {
      ..base,
      outputs: [
        f.payment_output(d, f.default_deposit, f.own_ref()),
        short_second,
        f.buyer_output(d),
      ],
    }
  and {
    take_ok(d, f.own_ref(), tx),
    !take_ok(d, f.second_ref(), tx),
  }
}

test batch_take_with_expired_order_fails() {
  // One expired order poisons the whole batch: its own expiry check fails
  // against the shared validity range.
  let fresh = f.base_datum()
  let expired = OrderDatum { ..f.base_datum(), expiration: Some(1_000) }
  let base = f.valid_batch_take_tx(fresh, f.default_deposit)
  let tx =
    Transaction { ..base, validity_range: f.range_with_upper(2_000) }
  and {
    take_ok(fresh, f.own_ref(), tx),
    !take_ok(expired, f.second_ref(), tx),
  }
}

test cancel_smuggled_into_batch_take_fails() {
  // Cancel keeps the one-order-input rule, so a cancel bundled with a take
  // (2 order inputs) fails even with the owner's signature present.
  let d = f.base_datum()
  let base = f.valid_batch_take_tx(d, f.default_deposit)
  let tx = Transaction { ..base, extra_signatories: [f.owner_key] }
  !cancel_ok(d, f.second_ref(), tx)
}

test take_with_beaconed_continuation_fails() {
  let d = f.base_datum()
  let base = f.valid_take_tx(d, f.default_deposit)
  let continuation = f.order_output(d, f.order_value(d, f.default_deposit))
  let tx = Transaction { ..base, outputs: [continuation, ..base.outputs] }
  !take_ok(d, f.own_ref(), tx)
}

test take_with_beaconless_donation_output_passes() {
  let d = f.base_datum()
  let base = f.valid_take_tx(d, f.default_deposit)
  let donation =
    Output {
      address: f.order_address(f.owner_key),
      value: assets.from_lovelace(1_000_000),
      datum: NoDatum,
      reference_script: None,
    }
  take_ok(
    d,
    f.own_ref(),
    Transaction { ..base, outputs: [donation, ..base.outputs] },
  )
}

test take_wrong_datum_version_fails() {
  // Defensive re-check: the policy blocks this at mint; the validator
  // double-checks for free.
  let d = OrderDatum { ..f.base_datum(), version: 2 }
  !take_ok(d, f.own_ref(), f.valid_take_tx(d, f.default_deposit))
}

// -- expiration

const expiry = 1_800_000_000_000

fn expiring_datum() -> OrderDatum {
  OrderDatum { ..f.base_datum(), expiration: Some(expiry) }
}

test take_before_expiration_passes() {
  let d = expiring_datum()
  let tx =
    Transaction {
      ..f.valid_take_tx(d, f.default_deposit),
      validity_range: f.range_with_upper(expiry - 1),
    }
  take_ok(d, f.own_ref(), tx)
}

test take_at_expiration_boundary_passes() {
  // Conservative rule: finite upper bound <= expiration (open-questions #24).
  let d = expiring_datum()
  let tx =
    Transaction {
      ..f.valid_take_tx(d, f.default_deposit),
      validity_range: f.range_with_upper(expiry),
    }
  take_ok(d, f.own_ref(), tx)
}

test take_after_expiration_fails() {
  let d = expiring_datum()
  let tx =
    Transaction {
      ..f.valid_take_tx(d, f.default_deposit),
      validity_range: f.range_with_upper(expiry + 1),
    }
  !take_ok(d, f.own_ref(), tx)
}

test take_expired_without_upper_bound_fails() {
  // placeholder validity range is (-inf, +inf): no finite upper bound.
  let d = expiring_datum()
  !take_ok(d, f.own_ref(), f.valid_take_tx(d, f.default_deposit))
}

test cancel_after_expiration_still_passes() {
  // Expiry never locks the owner out of cancelling.
  let d = expiring_datum()
  cancel_ok(d, f.own_ref(), f.valid_cancel_tx(d, f.default_deposit))
}

// ==================================================== v3 partial fills

// Fixture recap: partial_datum() offers 100 TOKA, asks 250 TOKB, partial
// fills enabled. required_of(take) = ceil(take * 250 / 100).

fn partial_with_payment(
  datum: OrderDatum,
  take: Int,
  payment: Output,
) -> Transaction {
  let base = f.valid_partial_take_tx(datum, f.default_deposit, take)
  Transaction {
    ..base,
    outputs: [
      payment,
      f.continuation_output(datum, f.default_deposit, take),
      f.buyer_output(datum),
    ],
  }
}

fn partial_with_continuation(
  datum: OrderDatum,
  take: Int,
  continuation: Output,
) -> Transaction {
  let base = f.valid_partial_take_tx(datum, f.default_deposit, take)
  Transaction {
    ..base,
    outputs: [
      f.partial_payment_output(datum, take, f.own_ref()),
      continuation,
      f.buyer_output(datum),
    ],
  }
}

// -- positive paths

test valid_partial_take_passes() {
  let d = f.partial_datum()
  take_partial_ok(d, 40, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, 40))
}

test valid_partial_take_ada_offer_passes() {
  let d = f.ada_offer_partial_datum()
  take_partial_ok(
    d,
    2_000_000,
    f.own_ref(),
    f.valid_partial_take_tx(d, f.default_deposit, 2_000_000),
  )
}

test valid_partial_take_ada_ask_passes() {
  let d = f.ada_ask_partial_datum()
  take_partial_ok(d, 40, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, 40))
}

test partial_take_one_unit_passes() {
  // Smallest fill: take 1, required = ceil(250/100) = 3 — rounding favours
  // the seller.
  let d = f.partial_datum()
  take_partial_ok(d, 1, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, 1))
}

test partial_take_of_continuation_passes() {
  // Sequential fills: partially take the continuation of a previous partial
  // fill (same beacon names — they never depend on amounts).
  let d = f.reduced_datum(f.partial_datum(), 40)
  take_partial_ok(d, 25, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, 25))
}

test full_take_of_partial_enabled_order_passes() {
  // The LAST fill goes through TakeOrder: exact remaining ask + deposit
  // returned, all beacons burned — allow_partial_fill never blocks it.
  let d = f.partial_datum()
  take_ok(d, f.own_ref(), f.valid_take_tx(d, f.default_deposit))
}

test partial_payment_extra_lovelace_passes() {
  // Token ask: payment lovelace is unconstrained (taker-funded min-ADA;
  // excess is a seller gift).
  let d = f.partial_datum()
  let payment = f.partial_payment_output(d, 40, f.own_ref())
  let topped = Output { ..payment, value: assets.add(payment.value, "", "", 600_000) }
  take_partial_ok(d, 40, f.own_ref(), partial_with_payment(d, 40, topped))
}

test partial_ada_ask_overpay_passes() {
  // ADA ask: >= required, like the full-fill rule.
  let d = f.ada_ask_partial_datum()
  let payment = f.partial_payment_output(d, 40, f.own_ref())
  let over = Output { ..payment, value: assets.add(payment.value, "", "", 1_000_000) }
  take_partial_ok(d, 40, f.own_ref(), partial_with_payment(d, 40, over))
}

// -- bounds and rounding attacks

test partial_take_zero_fails() {
  let d = f.partial_datum()
  !take_partial_ok(d, 0, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, 0))
}

test partial_take_negative_fails() {
  let d = f.partial_datum()
  !take_partial_ok(d, -10, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, -10))
}

test partial_take_full_amount_fails() {
  // Taking everything must use TakeOrder (which returns the deposit).
  let d = f.partial_datum()
  !take_partial_ok(
    d,
    d.offer_amount,
    f.own_ref(),
    f.valid_partial_take_tx(d, f.default_deposit, d.offer_amount),
  )
}

test partial_take_more_than_offer_fails() {
  let d = f.partial_datum()
  !take_partial_ok(d, 150, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, 150))
}

test partial_exhausting_ask_fails() {
  // offer 100, ask 3: take 99 → required = ceil(297/100) = 3 == ask, so the
  // remainder would ask for 0 — rejected; the taker must fill fully instead.
  let d = OrderDatum { ..f.partial_datum(), ask_amount: 3 }
  !take_partial_ok(d, 99, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, 99))
}

test partial_underpays_by_one_fails() {
  let d = f.partial_datum()
  let payment = f.partial_payment_output(d, 40, f.own_ref())
  let short =
    Output {
      ..payment,
      value: assets.add(payment.value, d.ask.policy_id, d.ask.asset_name, -1),
    }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_payment(d, 40, short))
}

test partial_token_ask_overpay_fails() {
  // Exactly `required` of the ask asset: over-delivery would desync the
  // reduced datum from what was actually paid — rejected, like v2 full fills.
  let d = f.partial_datum()
  let payment = f.partial_payment_output(d, 40, f.own_ref())
  let over =
    Output {
      ..payment,
      value: assets.add(payment.value, d.ask.policy_id, d.ask.asset_name, 1),
    }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_payment(d, 40, over))
}

test partial_ada_ask_underpays_fails() {
  let d = f.ada_ask_partial_datum()
  let payment = f.partial_payment_output(d, 40, f.own_ref())
  let short = Output { ..payment, value: assets.add(payment.value, "", "", -1) }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_payment(d, 40, short))
}

test partial_payment_with_foreign_asset_fails() {
  let d = f.partial_datum()
  let payment = f.partial_payment_output(d, 40, f.own_ref())
  let tainted =
    Output {
      ..payment,
      value: assets.add(payment.value, f.token_a().policy_id, f.token_a().asset_name, 1),
    }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_payment(d, 40, tainted))
}

test partial_on_full_fill_only_order_fails() {
  // allow_partial_fill == False keeps v2 semantics under the v3 script.
  let d = f.base_datum()
  !take_partial_ok(d, 40, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, 40))
}

test partial_missing_payment_fails() fail {
  // No PaymentTag-tagged output at all — expect [payment] crashes.
  let d = f.partial_datum()
  let base = f.valid_partial_take_tx(d, f.default_deposit, 40)
  let tx =
    Transaction {
      ..base,
      outputs: [f.continuation_output(d, f.default_deposit, 40), f.buyer_output(d)],
    }
  take_partial_ok(d, 40, f.own_ref(), tx)
}

// -- continuation value attacks

test partial_missing_continuation_fails() fail {
  // No beacon-bearing output: this run's rank has no continuation to claim.
  let d = f.partial_datum()
  let base = f.valid_partial_take_tx(d, f.default_deposit, 40)
  let tx =
    Transaction {
      ..base,
      outputs: [f.partial_payment_output(d, 40, f.own_ref()), f.buyer_output(d)],
    }
  take_partial_ok(d, 40, f.own_ref(), tx)
}

test partial_continuation_skims_deposit_fails() {
  let d = f.partial_datum()
  let cont = f.continuation_output(d, f.default_deposit, 40)
  let skimmed = Output { ..cont, value: assets.add(cont.value, "", "", -1) }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_continuation(d, 40, skimmed))
}

test partial_continuation_shorts_offer_fails() {
  // Taker keeps one more unit than the redeemer admits.
  let d = f.partial_datum()
  let cont = f.continuation_output(d, f.default_deposit, 40)
  let short =
    Output {
      ..cont,
      value: assets.add(cont.value, d.offer.policy_id, d.offer.asset_name, -1),
    }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_continuation(d, 40, short))
}

test partial_continuation_missing_beacon_fails() {
  let d = f.partial_datum()
  let cont = f.continuation_output(d, f.default_deposit, 40)
  let stripped =
    Output { ..cont, value: assets.add(cont.value, f.beacon_policy, "order", -1) }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_continuation(d, 40, stripped))
}

test partial_continuation_double_beacon_fails() {
  // Routing a second order's beacon into this continuation (instead of
  // burning it) breaks the exact-value pin.
  let d = f.partial_datum()
  let cont = f.continuation_output(d, f.default_deposit, 40)
  let doubled =
    Output { ..cont, value: assets.add(cont.value, f.beacon_policy, "order", 1) }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_continuation(d, 40, doubled))
}

test partial_continuation_with_foreign_token_fails() {
  let d = f.partial_datum()
  let cont = f.continuation_output(d, f.default_deposit, 40)
  let tainted =
    Output {
      ..cont,
      value: assets.add(cont.value, d.ask.policy_id, d.ask.asset_name, 1),
    }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_continuation(d, 40, tainted))
}

// -- continuation datum-diff attacks

fn cont_with_datum(datum: OrderDatum, take: Int, lying: OrderDatum) -> Output {
  Output {
    ..f.continuation_output(datum, f.default_deposit, take),
    datum: InlineDatum(lying),
  }
}

test partial_continuation_wrong_offer_amount_fails() {
  let d = f.partial_datum()
  let lying =
    OrderDatum { ..f.reduced_datum(d, 40), offer_amount: d.offer_amount - 40 + 1 }
  !take_partial_ok(
    d,
    40,
    f.own_ref(),
    partial_with_continuation(d, 40, cont_with_datum(d, 40, lying)),
  )
}

test partial_continuation_wrong_ask_amount_fails() {
  // Remainder priced cheaper than the original ratio.
  let good = f.reduced_datum(f.partial_datum(), 40)
  let lying = OrderDatum { ..good, ask_amount: good.ask_amount - 1 }
  let d = f.partial_datum()
  !take_partial_ok(
    d,
    40,
    f.own_ref(),
    partial_with_continuation(d, 40, cont_with_datum(d, 40, lying)),
  )
}

test partial_continuation_changed_payment_address_fails() {
  let d = f.partial_datum()
  let lying =
    OrderDatum {
      ..f.reduced_datum(d, 40),
      payment_address: f.key_address(f.taker_key),
    }
  !take_partial_ok(
    d,
    40,
    f.own_ref(),
    partial_with_continuation(d, 40, cont_with_datum(d, 40, lying)),
  )
}

test partial_continuation_changed_owner_fails() {
  let d = f.partial_datum()
  let lying =
    OrderDatum { ..f.reduced_datum(d, 40), owner: VerificationKey(f.taker_key) }
  !take_partial_ok(
    d,
    40,
    f.own_ref(),
    partial_with_continuation(d, 40, cont_with_datum(d, 40, lying)),
  )
}

test partial_continuation_strips_expiration_fails() {
  let d = OrderDatum { ..f.partial_datum(), expiration: Some(expiry) }
  let lying = OrderDatum { ..f.reduced_datum(d, 40), expiration: None }
  let tx =
    Transaction {
      ..partial_with_continuation(d, 40, cont_with_datum(d, 40, lying)),
      validity_range: f.range_with_upper(expiry - 1),
    }
  !take_partial_ok(d, 40, f.own_ref(), tx)
}

test partial_continuation_flips_flag_fails() {
  // Downgrading the continuation to full-fill-only against the seller's terms.
  let d = f.partial_datum()
  let lying = OrderDatum { ..f.reduced_datum(d, 40), allow_partial_fill: False }
  !take_partial_ok(
    d,
    40,
    f.own_ref(),
    partial_with_continuation(d, 40, cont_with_datum(d, 40, lying)),
  )
}

test partial_continuation_changed_version_fails() {
  let d = f.partial_datum()
  let lying = OrderDatum { ..f.reduced_datum(d, 40), version: 2 }
  !take_partial_ok(
    d,
    40,
    f.own_ref(),
    partial_with_continuation(d, 40, cont_with_datum(d, 40, lying)),
  )
}

// -- injectivity / rank pairing

test mixed_batch_full_and_partial_passes() {
  // One tx: order #1 fully taken (beacons burned), order #2 partially taken
  // (beacons ride into its continuation). Both runs approve.
  let full_d = f.base_datum()
  let part_d = f.partial_datum()
  let tx = f.valid_mixed_batch_tx(full_d, part_d, f.default_deposit, 40)
  and {
    take_ok(full_d, f.own_ref(), tx),
    take_partial_ok(part_d, 40, f.second_ref(), tx),
  }
}

test twin_partial_batch_passes() {
  // TWO byte-identical orders partially taken in one tx: rank pairing gives
  // each run its own continuation (input order == continuation order).
  let d = f.partial_datum()
  let tx = f.valid_twin_partial_batch_tx(d, f.default_deposit, 10, 20)
  and {
    take_partial_ok(d, 10, f.own_ref(), tx),
    take_partial_ok(d, 20, f.second_ref(), tx),
  }
}

test twin_partial_batch_equal_takes_passes() {
  // Even with IDENTICAL takes (indistinguishable continuations) the count
  // check forces two distinct outputs — no theft possible, tx valid.
  let d = f.partial_datum()
  let tx = f.valid_twin_partial_batch_tx(d, f.default_deposit, 25, 25)
  and {
    take_partial_ok(d, 25, f.own_ref(), tx),
    take_partial_ok(d, 25, f.second_ref(), tx),
  }
}

test twin_partials_sharing_one_continuation_fails() {
  // THE attack rank pairing exists to kill: two partial inputs, ONE
  // continuation. The first run already fails the |C| == |S| count.
  let d = f.partial_datum()
  let base = f.valid_twin_partial_batch_tx(d, f.default_deposit, 25, 25)
  let tx =
    Transaction {
      ..base,
      outputs: [
        f.partial_payment_output(d, 25, f.own_ref()),
        f.partial_payment_output(d, 25, f.second_ref()),
        f.continuation_output(d, f.default_deposit, 25),
        f.buyer_output(d),
      ],
    }
  !take_partial_ok(d, 25, f.own_ref(), tx)
}

test twin_partials_sharing_one_continuation_second_run_fails() fail {
  // Same attack, second run: its rank (1) has no continuation — crashes.
  let d = f.partial_datum()
  let base = f.valid_twin_partial_batch_tx(d, f.default_deposit, 25, 25)
  let tx =
    Transaction {
      ..base,
      outputs: [
        f.partial_payment_output(d, 25, f.own_ref()),
        f.partial_payment_output(d, 25, f.second_ref()),
        f.continuation_output(d, f.default_deposit, 25),
        f.buyer_output(d),
      ],
    }
  take_partial_ok(d, 25, f.second_ref(), tx)
}

test twin_partials_swapped_continuations_fail() {
  // Continuations present but in the WRONG rank order — each run sees the
  // other's expected value/datum and rejects.
  let d = f.partial_datum()
  let base = f.valid_twin_partial_batch_tx(d, f.default_deposit, 10, 20)
  let tx =
    Transaction {
      ..base,
      outputs: [
        f.partial_payment_output(d, 10, f.own_ref()),
        f.partial_payment_output(d, 20, f.second_ref()),
        f.continuation_output(d, f.default_deposit, 20),
        f.continuation_output(d, f.default_deposit, 10),
        f.buyer_output(d),
      ],
    }
  and {
    !take_partial_ok(d, 10, f.own_ref(), tx),
    !take_partial_ok(d, 20, f.second_ref(), tx),
  }
}

test partial_continuation_wrong_stake_cred_fails() {
  // Right value, right datum, but the address' staking credential hijacked —
  // the order would vanish from the owner's CIP-0089 grouping.
  let d = f.partial_datum()
  let cont =
    Output {
      ..f.continuation_output(d, f.default_deposit, 40),
      address: f.order_address(f.other_key),
    }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_continuation(d, 40, cont))
}

test partial_continuation_at_key_address_fails() {
  // Beacons rerouted to the taker's own wallet as a fake continuation.
  let d = f.partial_datum()
  let cont =
    Output {
      ..f.continuation_output(d, f.default_deposit, 40),
      address: f.key_address(f.taker_key),
    }
  !take_partial_ok(d, 40, f.own_ref(), partial_with_continuation(d, 40, cont))
}

test partial_with_extra_beacon_output_fails() {
  // A second beacon-bearing output (dust leak) breaks |C| == |S| for the run.
  let d = f.partial_datum()
  let base = f.valid_partial_take_tx(d, f.default_deposit, 40)
  let dust =
    Output {
      address: f.key_address(f.taker_key),
      value: assets.from_lovelace(1_000_000)
        |> assets.add(f.beacon_policy, "order", 1),
      datum: NoDatum,
      reference_script: None,
    }
  let tx = Transaction { ..base, outputs: [dust, ..base.outputs] }
  !take_partial_ok(d, 40, f.own_ref(), tx)
}

test mixed_batch_unburned_beacons_fail_both_runs() {
  // Mixed batch where the FULL order's beacons leak into an extra output
  // instead of being burned: |C| == 2 but |S| == 1 — every run rejects.
  let full_d = f.base_datum()
  let part_d = f.partial_datum()
  let base = f.valid_mixed_batch_tx(full_d, part_d, f.default_deposit, 40)
  let leak =
    Output {
      address: f.key_address(f.taker_key),
      value: assets.merge(assets.from_lovelace(1_000_000), f.full_beacons(full_d)),
      datum: NoDatum,
      reference_script: None,
    }
  let tx = Transaction { ..base, outputs: [leak, ..base.outputs], mint: assets.zero }
  and {
    !take_ok(full_d, f.own_ref(), tx),
    !take_partial_ok(part_d, 40, f.second_ref(), tx),
  }
}

// -- partial fills and expiration

test partial_take_before_expiration_passes() {
  let d = OrderDatum { ..f.partial_datum(), expiration: Some(expiry) }
  let tx =
    Transaction {
      ..f.valid_partial_take_tx(d, f.default_deposit, 40),
      validity_range: f.range_with_upper(expiry - 1),
    }
  take_partial_ok(d, 40, f.own_ref(), tx)
}

test partial_take_after_expiration_fails() {
  let d = OrderDatum { ..f.partial_datum(), expiration: Some(expiry) }
  let tx =
    Transaction {
      ..f.valid_partial_take_tx(d, f.default_deposit, 40),
      validity_range: f.range_with_upper(expiry + 1),
    }
  !take_partial_ok(d, 40, f.own_ref(), tx)
}

test partial_take_expired_without_upper_bound_fails() {
  let d = OrderDatum { ..f.partial_datum(), expiration: Some(expiry) }
  !take_partial_ok(d, 40, f.own_ref(), f.valid_partial_take_tx(d, f.default_deposit, 40))
}
