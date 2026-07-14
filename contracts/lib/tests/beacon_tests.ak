//// Beacon derivation + minting policy tests — the adversarial list from
//// mvp-contract-decisions.md §11 steps 1–3.
////
//// Known-answer digests were computed independently with node:crypto
//// (sha256) over the documented encodings; the backend TS mirror asserts the
//// same vectors (backend/src/services/beacons.test.ts).

use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{DatumHash, InlineDatum, Output}
use p2p_dex/beacon_rules.{burn_beacons_ok, mint_beacons_ok}
use p2p_dex/beacons
use p2p_dex/types.{AssetClass, OrderDatum}
use tests/fixtures as f

// ================================================================ derivation

test order_beacon_name_is_constant_order() {
  beacons.order_beacon_name == #"6f72646572"
}

test offer_beacon_known_answer() {
  beacons.offer_beacon_name(f.token_a()) == #"4da0b8673e24f057592ba16399f9ee1107c557cf91b96d810dc90ba310f6a477"
}

test ask_beacon_known_answer() {
  beacons.ask_beacon_name(f.token_b()) == #"5caacc120b143ed0364e23caeccf4ed985dfec5acf61d8030c657589748aa2fc"
}

test pair_beacon_known_answer() {
  beacons.pair_beacon_name(f.token_a(), f.token_b()) == #"d3428227f1e3343b370bc58b5ef2889c9ec285a0fc09de67706b9691f206d4f9"
}

test pair_beacon_with_ada_known_answer() {
  beacons.pair_beacon_name(f.ada(), f.token_b()) == #"4122d58532d8480701be85a62faf1b2e3f03a18f59e0bcdee7cd9cc328c065b8"
}

test pair_beacon_is_symmetric() {
  beacons.pair_beacon_name(f.token_a(), f.token_b()) == beacons.pair_beacon_name(
    f.token_b(),
    f.token_a(),
  )
}

test offer_and_ask_prefixes_differ_for_same_asset() {
  beacons.offer_beacon_name(f.token_a()) != beacons.ask_beacon_name(
    f.token_a(),
  )
}

test owner_beacon_is_verbatim_key_hash() {
  beacons.owner_beacon_name(f.owner_key) == f.owner_key
}

// ============================================================== MintBeacons

fn mint_ok(tx) {
  mint_beacons_ok(f.order_hash, f.beacon_policy, tx)
}

test valid_create_passes() {
  mint_ok(f.valid_create_tx(f.base_datum(), f.default_deposit))
}

test valid_create_with_ada_offer_passes() {
  mint_ok(f.valid_create_tx(f.ada_offer_datum(), f.default_deposit))
}

test valid_create_with_ada_ask_passes() {
  mint_ok(f.valid_create_tx(f.ada_ask_datum(), f.default_deposit))
}

// -- beacon-set attacks: output value and mint must both be the exact set

fn create_with_beacons(datum: OrderDatum, beacon_bundle) {
  let value =
    assets.from_lovelace(f.default_deposit)
      |> assets.add(
          datum.offer.policy_id,
          datum.offer.asset_name,
          datum.offer_amount,
        )
      |> assets.merge(beacon_bundle)
  f.create_tx([f.order_output(datum, value)], beacon_bundle)
}

fn names_of(datum: OrderDatum) {
  (
    beacons.order_beacon_name,
    beacons.pair_beacon_name(datum.offer, datum.ask),
    beacons.offer_beacon_name(datum.offer),
    beacons.ask_beacon_name(datum.ask),
    beacons.owner_beacon_name(f.owner_key),
  )
}

test missing_order_beacon_fails() {
  let d = f.base_datum()
  let (_o, p, of, a, ow) = names_of(d)
  !mint_ok(create_with_beacons(d, f.beacons_of([(p, 1), (of, 1), (a, 1), (ow, 1)])))
}

test missing_pair_beacon_fails() {
  let d = f.base_datum()
  let (o, _p, of, a, ow) = names_of(d)
  !mint_ok(create_with_beacons(d, f.beacons_of([(o, 1), (of, 1), (a, 1), (ow, 1)])))
}

test missing_offer_beacon_fails() {
  let d = f.base_datum()
  let (o, p, _of, a, ow) = names_of(d)
  !mint_ok(create_with_beacons(d, f.beacons_of([(o, 1), (p, 1), (a, 1), (ow, 1)])))
}

test missing_ask_beacon_fails() {
  let d = f.base_datum()
  let (o, p, of, _a, ow) = names_of(d)
  !mint_ok(create_with_beacons(d, f.beacons_of([(o, 1), (p, 1), (of, 1), (ow, 1)])))
}

test missing_owner_beacon_fails() {
  let d = f.base_datum()
  let (o, p, of, a, _ow) = names_of(d)
  !mint_ok(create_with_beacons(d, f.beacons_of([(o, 1), (p, 1), (of, 1), (a, 1)])))
}

const bogus_name =
  #"9999999999999999999999999999999999999999999999999999999999999999"

test wrong_pair_beacon_name_fails() {
  let d = f.base_datum()
  let (o, _p, of, a, ow) = names_of(d)
  !mint_ok(
    create_with_beacons(
      d,
      f.beacons_of([(o, 1), (bogus_name, 1), (of, 1), (a, 1), (ow, 1)]),
    ),
  )
}

test wrong_offer_beacon_name_fails() {
  let d = f.base_datum()
  let (o, p, _of, a, ow) = names_of(d)
  !mint_ok(
    create_with_beacons(
      d,
      f.beacons_of([(o, 1), (p, 1), (bogus_name, 1), (a, 1), (ow, 1)]),
    ),
  )
}

test wrong_ask_beacon_name_fails() {
  let d = f.base_datum()
  let (o, p, of, _a, ow) = names_of(d)
  !mint_ok(
    create_with_beacons(
      d,
      f.beacons_of([(o, 1), (p, 1), (of, 1), (bogus_name, 1), (ow, 1)]),
    ),
  )
}

test wrong_owner_beacon_name_fails() {
  let d = f.base_datum()
  let (o, p, of, a, _ow) = names_of(d)
  // OwnerBeacon naming someone else's key.
  !mint_ok(
    create_with_beacons(
      d,
      f.beacons_of([(o, 1), (p, 1), (of, 1), (a, 1), (f.other_key, 1)]),
    ),
  )
}

test extra_protocol_beacon_fails() {
  let d = f.base_datum()
  let (o, p, of, a, ow) = names_of(d)
  !mint_ok(
    create_with_beacons(
      d,
      f.beacons_of([(o, 1), (p, 1), (of, 1), (a, 1), (ow, 1), (bogus_name, 1)]),
    ),
  )
}

test doubled_order_beacon_fails() {
  let d = f.base_datum()
  let (o, p, of, a, ow) = names_of(d)
  !mint_ok(
    create_with_beacons(
      d,
      f.beacons_of([(o, 2), (p, 1), (of, 1), (a, 1), (ow, 1)]),
    ),
  )
}

// -- address attacks

test beacons_to_key_address_fails() fail {
  // expect Address{ payment_credential: Script(..) } crashes on a key address.
  let d = f.base_datum()
  let out =
    Output {
      ..f.order_output(d, f.order_value(d, f.default_deposit)),
      address: f.key_address(f.other_key),
    }
  mint_ok(f.create_tx([out], f.full_beacons(d)))
}

test beacons_to_wrong_script_hash_fails() {
  let d = f.base_datum()
  let wrong =
    Address {
      payment_credential: Script(f.beacon_policy),
      stake_credential: Some(Inline(VerificationKey(f.owner_key))),
    }
  let out =
    Output {
      ..f.order_output(d, f.order_value(d, f.default_deposit)),
      address: wrong,
    }
  !mint_ok(f.create_tx([out], f.full_beacons(d)))
}

test wrong_staking_credential_fails() {
  let d = f.base_datum()
  let out =
    Output {
      ..f.order_output(d, f.order_value(d, f.default_deposit)),
      address: f.order_address(f.other_key),
    }
  !mint_ok(f.create_tx([out], f.full_beacons(d)))
}

test missing_staking_credential_fails() fail {
  let d = f.base_datum()
  let bare =
    Address {
      payment_credential: Script(f.order_hash),
      stake_credential: None,
    }
  let out =
    Output {
      ..f.order_output(d, f.order_value(d, f.default_deposit)),
      address: bare,
    }
  mint_ok(f.create_tx([out], f.full_beacons(d)))
}

// -- datum attacks

test non_inline_datum_fails() fail {
  let d = f.base_datum()
  let out =
    Output {
      ..f.order_output(d, f.order_value(d, f.default_deposit)),
      datum: DatumHash(
        #"9999999999999999999999999999999999999999999999999999999999999999",
      ),
    }
  mint_ok(f.create_tx([out], f.full_beacons(d)))
}

test script_owner_fails() fail {
  // expect VerificationKey(owner) crashes on a script owner credential.
  let d = OrderDatum { ..f.base_datum(), owner: Script(f.order_hash) }
  // Beacons can't be derived for a script owner via full_beacons (it expects
  // a key), so hand-build the set with an arbitrary owner name.
  let (o, p, of, a, _ow) = names_of(f.base_datum())
  mint_ok(
    create_with_beacons(
      d,
      f.beacons_of([(o, 1), (p, 1), (of, 1), (a, 1), (f.owner_key, 1)]),
    ),
  )
}

test script_payment_address_fails() {
  let d =
    OrderDatum {
      ..f.base_datum(),
      payment_address: Address {
        payment_credential: Script(f.order_hash),
        stake_credential: None,
      },
    }
  !mint_ok(f.valid_create_tx(d, f.default_deposit))
}

test zero_offer_amount_fails() {
  !mint_ok(
    f.valid_create_tx(
      OrderDatum { ..f.base_datum(), offer_amount: 0 },
      f.default_deposit,
    ),
  )
}

test zero_ask_amount_fails() {
  !mint_ok(
    f.valid_create_tx(
      OrderDatum { ..f.base_datum(), ask_amount: 0 },
      f.default_deposit,
    ),
  )
}

test same_offer_and_ask_fails() {
  !mint_ok(
    f.valid_create_tx(
      OrderDatum { ..f.base_datum(), ask: f.token_a() },
      f.default_deposit,
    ),
  )
}

test allow_partial_fill_true_accepted() {
  // v3: the flag is a free seller choice at creation (docs/partial-fills.md).
  mint_ok(f.valid_create_tx(f.partial_datum(), f.default_deposit))
}

test wrong_version_fails() {
  !mint_ok(
    f.valid_create_tx(
      OrderDatum { ..f.base_datum(), version: 2 },
      f.default_deposit,
    ),
  )
}

test wrong_beacon_policy_id_in_datum_fails() {
  // Real beacons minted under the real policy — only the datum field lies.
  // (Names don't depend on beacon_policy_id, so the set is otherwise valid.)
  let lying = OrderDatum { ..f.base_datum(), beacon_policy_id: f.order_hash }
  let real_beacons = f.full_beacons(f.base_datum())
  !mint_ok(create_with_beacons(lying, real_beacons))
}

test offering_the_beacon_policy_itself_fails() {
  let d =
    OrderDatum {
      ..f.base_datum(),
      offer: AssetClass { policy_id: f.beacon_policy, asset_name: "x" },
    }
  !mint_ok(f.valid_create_tx(d, f.default_deposit))
}

// -- value attacks

test ada_offer_with_insufficient_lovelace_fails() {
  let d = f.ada_offer_datum()
  // Lovelace below the offered amount (deposit would be negative).
  let value =
    assets.from_lovelace(d.offer_amount - 1)
      |> assets.merge(f.full_beacons(d))
  !mint_ok(f.create_tx([f.order_output(d, value)], f.full_beacons(d)))
}

test missing_offered_asset_fails() {
  let d = f.base_datum()
  let value =
    assets.from_lovelace(f.default_deposit)
      |> assets.merge(f.full_beacons(d))
  !mint_ok(f.create_tx([f.order_output(d, value)], f.full_beacons(d)))
}

test short_offered_asset_fails() {
  let d = f.base_datum()
  let value =
    assets.from_lovelace(f.default_deposit)
      |> assets.add(d.offer.policy_id, d.offer.asset_name, d.offer_amount - 1)
      |> assets.merge(f.full_beacons(d))
  !mint_ok(f.create_tx([f.order_output(d, value)], f.full_beacons(d)))
}

test stray_foreign_token_in_order_fails() {
  let d = f.base_datum()
  let value =
    f.order_value(d, f.default_deposit)
      |> assets.add(f.token_b().policy_id, f.token_b().asset_name, 1)
  !mint_ok(f.create_tx([f.order_output(d, value)], f.full_beacons(d)))
}

// -- mint-field / multi-output attacks

test beacons_split_across_two_outputs_fails() fail {
  // expect [single beacon-holding output] crashes on two.
  let d = f.base_datum()
  let out = f.order_output(d, f.order_value(d, f.default_deposit))
  let smuggle =
    Output {
      address: f.key_address(f.other_key),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(f.beacon_policy, beacons.order_beacon_name, 1),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  mint_ok(f.create_tx([out, smuggle], f.full_beacons(d)))
}

test mint_exceeding_output_beacons_fails() {
  // Mint 5 correct + 1 extra name that lands nowhere valid.
  let d = f.base_datum()
  let out = f.order_output(d, f.order_value(d, f.default_deposit))
  let mint =
    f.full_beacons(d) |> assets.add(f.beacon_policy, bogus_name, 1)
  !mint_ok(f.create_tx([out], mint))
}

test mixed_mint_and_burn_fails() {
  let d = f.base_datum()
  let out = f.order_output(d, f.order_value(d, f.default_deposit))
  let mint =
    f.full_beacons(d) |> assets.add(f.beacon_policy, bogus_name, -1)
  !mint_ok(f.create_tx([out], mint))
}

// ============================================================== BurnBeacons

test pure_burn_passes() {
  let tx =
    transaction.Transaction {
      ..transaction.placeholder,
      mint: assets.negate(f.full_beacons(f.base_datum())),
    }
  burn_beacons_ok(f.beacon_policy, tx)
}

test burn_with_positive_mint_fails() {
  let mint =
    assets.negate(f.full_beacons(f.base_datum()))
      |> assets.add(f.beacon_policy, bogus_name, 1)
  let tx = transaction.Transaction { ..transaction.placeholder, mint: mint }
  !burn_beacons_ok(f.beacon_policy, tx)
}

test burn_with_no_policy_tokens_fails() {
  !burn_beacons_ok(f.beacon_policy, transaction.placeholder)
}
