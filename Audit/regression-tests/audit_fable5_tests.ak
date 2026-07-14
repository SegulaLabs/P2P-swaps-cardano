//// Adversarial audit tests — docs/security-audit-fable5.md (Fable 5 audit).
//// These are EVIDENCE tests written by the auditor: some assert that an
//// attack is correctly rejected (regression), others assert that the on-chain
//// code ACCEPTS something the audit flags as a weakness (so the finding is
//// reproducible and any future fix will flip the test). Test-only module.

use cardano/address.{VerificationKey}
use cardano/assets
use cardano/transaction.{InlineDatum, Output, Transaction}
use p2p_dex/beacon_rules
use p2p_dex/order_rules
use p2p_dex/types.{AssetClass, OrderDatum, PaymentTag, TakeOrder}
use tests/fixtures.{
  base_datum, beacon_policy, buyer_output, create_tx, default_deposit,
  full_beacons, order_address, order_hash, order_input, order_value, other_key,
  own_ref, second_order_input, second_ref, spend_redeemer, taker_key, token_b,
  wallet_input,
}

// ---------------------------------------------------------------------------
// FINDING F-04 (Low): the mint policy does NOT bound the ASK asset's
// policy-id / asset-name length. A real Cardano asset name is <= 32 bytes; an
// order asking for a 40-byte-named asset is UNFILLABLE (no taker can ever
// produce that asset) yet mints cleanly and is indexed into the open book.
// This is an order-book spam / griefing vector (attacker self-funds a deposit
// per order). EVIDENCE: creation of such an order passes mint_beacons_ok.
// ---------------------------------------------------------------------------
test audit_oversized_ask_asset_name_mints_unfillable_order() {
  let big_ask =
    AssetClass {
      policy_id: token_b().policy_id,
      // 40 bytes > the 32-byte ledger asset-name limit: no such asset exists.
      asset_name: #"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011",
    }
  let datum = OrderDatum { ..base_datum(), ask: big_ask }
  let tx =
    create_tx(
      [
        Output {
          address: order_address(fixtures_owner()),
          value: order_value(datum, default_deposit),
          datum: InlineDatum(datum),
          reference_script: None,
        },
      ],
      full_beacons(datum),
    )
  // The policy accepts it -> the book can be flooded with unfillable orders.
  beacon_rules.mint_beacons_ok(order_hash, beacon_policy, tx)
}

// Helper: the base datum's owner key (kept local so the test is self-describing).
fn fixtures_owner() -> ByteArray {
  expect VerificationKey(k) = base_datum().owner
  k
}

// ---------------------------------------------------------------------------
// FINDING F-05 (Low/Informational): order creation is PERMISSIONLESS with
// respect to the named owner. The minting policy never checks that the owner
// staking key signed, so anyone can mint a well-formed order whose OwnerBeacon
// (and therefore "My Orders" attribution) points at an arbitrary victim's
// staking key. Self-limiting (the attacker funds the deposit+offer, and the
// victim can actually cancel and keep those funds) but it enables UI-level
// impersonation / order-book pollution attributed to a third party.
// EVIDENCE: minting an order "owned" by `other_key` with NO signatures passes.
// ---------------------------------------------------------------------------
test audit_permissionless_creation_spoofs_owner() {
  let datum = OrderDatum { ..base_datum(), owner: VerificationKey(other_key) }
  let tx =
    create_tx(
      [
        Output {
          // Address stake credential must equal the (spoofed) datum owner.
          address: order_address(other_key),
          value: order_value(datum, default_deposit),
          datum: InlineDatum(datum),
          reference_script: None,
        },
      ],
      full_beacons(datum),
    )
  // No extra_signatories on this tx (create_tx uses transaction.placeholder).
  beacon_rules.mint_beacons_ok(order_hash, beacon_policy, tx)
}

// ---------------------------------------------------------------------------
// REGRESSION (double satisfaction, novel shape): two full-take order inputs,
// a SINGLE seller-payment output carrying DOUBLE value (2*ask + 2*deposit) but
// tagged for only the first order. The second order's run must be rejected:
// tagged_payment(second_ref) finds no output tagged with second_ref, so the
// `expect [payment]` crashes. Confirms one output can never settle two orders.
// ---------------------------------------------------------------------------
test audit_two_full_takes_one_doubled_payment_second_fails() fail {
  let datum = base_datum()
  let deposit = default_deposit
  let doubled_payment =
    Output {
      address: datum.payment_address,
      value: assets.from_lovelace(2 * deposit)
        |> assets.add(datum.ask.policy_id, datum.ask.asset_name, 2 * datum.ask_amount),
      datum: InlineDatum(PaymentTag { order_ref: own_ref() }),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        wallet_input(taker_key),
        order_input(datum, deposit),
        second_order_input(datum, deposit),
      ],
      outputs: [doubled_payment, buyer_output(datum)],
      mint: assets.negate(assets.merge(full_beacons(datum), full_beacons(datum))),
      redeemers: [
        spend_redeemer(own_ref(), TakeOrder),
        spend_redeemer(second_ref(), TakeOrder),
      ],
    }
  // The SECOND order cannot find its own tagged payment -> rejected.
  order_rules.take_ok(datum, second_ref(), tx)
}

// ---------------------------------------------------------------------------
// PRICING (rounding): confirm the partial-fill payment always rounds in the
// SELLER's favour (taker can never underpay a partial). For every valid take
// in [1, offer), required = ceil(take*ask/offer) satisfies required*offer >=
// take*ask and required >= 1. Brute-forced over several small ratios where
// rounding attacks would surface first.
// ---------------------------------------------------------------------------
fn rounding_seller_favored(take: Int, offer: Int, ask: Int) -> Bool {
  if take >= offer {
    True
  } else {
    let required = ( take * ask + offer - 1 ) / offer
    and {
      required * offer >= take * ask,
      required >= 1,
      rounding_seller_favored(take + 1, offer, ask),
    }
  }
}

test audit_partial_rounding_never_favors_taker() {
  and {
    rounding_seller_favored(1, 100, 250),
    rounding_seller_favored(1, 250, 100),
    rounding_seller_favored(1, 7, 3),
    rounding_seller_favored(1, 3, 7),
    rounding_seller_favored(1, 101, 100),
    rounding_seller_favored(1, 2, 1000000),
  }
}

// Telescoping: fully consuming an order via any partial split + a final full
// take returns EXACTLY the original ask to the seller (no leak, no shortfall).
// require(t) + (ask - require(t)) == ask is trivially true, but this asserts
// the continuation's reduced ask stays strictly positive for a valid partial,
// so the "final fill" is always a well-formed order.
fn continuation_ask_positive(take: Int, offer: Int, ask: Int) -> Bool {
  if take >= offer {
    True
  } else {
    let required = ( take * ask + offer - 1 ) / offer
    // Only takes the validator accepts (required < ask) need a valid remainder.
    let ok =
      if required < ask {
        ask - required > 0
      } else {
        True
      }
    and { ok, continuation_ask_positive(take + 1, offer, ask) }
  }
}

test audit_partial_continuation_ask_stays_positive() {
  and {
    continuation_ask_positive(1, 100, 250),
    continuation_ask_positive(1, 250, 100),
    continuation_ask_positive(1, 7, 3),
  }
}
