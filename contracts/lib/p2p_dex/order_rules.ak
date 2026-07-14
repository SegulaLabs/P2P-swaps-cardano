//// Order spending rules — mvp-contract-decisions.md §5 (Cancel), §6 (Take)
//// as amended by docs/take-many-orders.md (v2): TakeOrder drops the §8
//// one-order-input rule in favour of PER-ORDER OUTPUT TAGGING, so one tx may
//// take many orders atomically. Cancel keeps the one-input rule. Kept in lib
//// so tests can drive them with fixture transactions; validators/order.ak is
//// a thin wrapper.
////
//// v3 (docs/partial-fills.md) adds TakeOrderPartial: a fill of part of the
//// offer that leaves a CONTINUATION order output carrying the deposit, the
//// remaining offer, and all five beacons. Continuations are bound to their
//// order inputs by RANK PAIRING (see partial_take_refs), the batch-safe
//// analogue of the PaymentTag mechanism.
////
//// Datum fields are trustworthy here: any UTxO that actually carries beacons
//// passed the minting policy at creation (§4 trust chain). Beacon-less
//// imitations are invisible to discovery and can't hurt anyone but their
//// creator.

use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{ScriptHash}
use aiken/interval.{Finite}
use cardano/address.{Script, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Spend, Transaction,
}
use p2p_dex/beacons
use p2p_dex/types.{OrderDatum, OrderRedeemer, PaymentTag, TakeOrderPartial}

/// Resolve the input being spent and this validator's own script hash.
fn own_input_and_hash(
  own_ref: OutputReference,
  self: Transaction,
) -> (Input, ScriptHash) {
  expect Some(own_input) = transaction.find_input(self.inputs, own_ref)
  expect Script(own_hash) = own_input.output.address.payment_credential
  (own_input, own_hash)
}

/// §8 (v2: CANCEL ONLY): exactly one input in the whole tx at this
/// validator's payment credential. Take paths use per-order output tagging
/// instead (take-many-orders.md §3); keeping the rule on Cancel also blocks
/// smuggling a cancel into a batched take.
fn only_one_order_input(self: Transaction, own_hash: ScriptHash) -> Bool {
  list.count(
    self.inputs,
    fn(input) { input.output.address.payment_credential == Script(own_hash) },
  ) == 1
}

/// §3/§5/§6: no output of the tx may carry ANY token of the beacon policy.
/// Value conservation then forces the full 5-beacon burn, and beacons can
/// never leak into change, other scripts, or fake continuation orders.
/// v3: still the rule on Cancel; take paths use beacon_accounting_ok.
fn no_beacons_in_outputs(self: Transaction, policy_id: PolicyId) -> Bool {
  list.all(
    self.outputs,
    fn(output) { dict.is_empty(assets.tokens(output.value, policy_id)) },
  )
}

/// Ceil(take_amount * ask_amount / offer_amount): the ask owed for a partial
/// fill of take_amount, with sub-unit rounding always in the seller's favour.
/// All arguments strictly positive on every path that relies on the result.
fn required_payment(take_amount: Int, ask_amount: Int, offer_amount: Int) -> Int {
  ( take_amount * ask_amount + offer_amount - 1 ) / offer_amount
}

/// v3 rank pairing, set S: the OutputReferences of ALL inputs at this
/// validator spent with a TakeOrderPartial redeemer, in tx input order.
/// The ledger sorts inputs ascending by OutputReference, so every run of this
/// validator in the tx computes the SAME canonical list, and each partial
/// run's own_ref occupies a DISTINCT rank in it — that rank names its
/// continuation output. Reading sibling redeemers is safe: any input at this
/// script is validated by this very validator with that same redeemer.
fn partial_take_refs(
  self: Transaction,
  own_hash: ScriptHash,
) -> List<OutputReference> {
  list.filter_map(
    self.inputs,
    fn(input) {
      if input.output.address.payment_credential == Script(own_hash) {
        expect Some(raw) =
          pairs.get_first(self.redeemers, Spend(input.output_reference))
        expect redeemer: OrderRedeemer = raw
        when redeemer is {
          TakeOrderPartial { .. } -> Some(input.output_reference)
          _ -> None
        }
      } else {
        None
      }
    },
  )
}

/// v3 rank pairing, list C: ALL outputs (any address) carrying any token of
/// the beacon policy, in output order. Valid continuations are the only
/// legitimate members; every take-path run pins |C| == |S| and each partial
/// run additionally pins C[rank] exactly, so no beacon can leak anywhere else.
fn beacon_bearing_outputs(
  self: Transaction,
  policy_id: PolicyId,
) -> List<Output> {
  list.filter(
    self.outputs,
    fn(output) { !dict.is_empty(assets.tokens(output.value, policy_id)) },
  )
}

/// Take-path beacon accounting (v3): the number of beacon-bearing outputs
/// equals the number of partial-fill order inputs. Each such output is
/// exact-value-pinned by exactly one partial run (rank pairing), so a fully
/// taken order's beacons have no output home and MUST be burned by value
/// conservation (positive beacon mints are impossible in a take tx — the mint
/// policy demands exactly one beacon output + all-positive mint). With zero
/// partial inputs this degenerates to v2's no_beacons_in_outputs.
fn beacon_accounting_ok(
  self: Transaction,
  own_hash: ScriptHash,
  policy_id: PolicyId,
) -> Bool {
  list.length(beacon_bearing_outputs(self, policy_id)) == list.length(
    partial_take_refs(self, own_hash),
  )
}

/// §6.5: the taker proves non-expiry with a finite validity upper bound at or
/// before the expiration. Inclusivity is deliberately ignored — requiring
/// `u <= t` is safe for both inclusive and exclusive bounds (conservative by
/// at most 1 ms; resolves open-questions #24).
fn expiration_ok(expiration: Option<Int>, self: Transaction) -> Bool {
  when expiration is {
    None -> True
    Some(t) ->
      when self.validity_range.upper_bound.bound_type is {
        Finite(upper) -> upper <= t
        _ -> False
      }
  }
}

/// CancelOrder — mvp-contract-decisions.md §5.
/// The owner's signature makes value routing their business: with the key in
/// extra_signatories, everything in the order (offer + deposit) is back under
/// the owner's control by construction — no output constraints needed.
pub fn cancel_ok(
  datum: OrderDatum,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  let (_own_input, own_hash) = own_input_and_hash(own_ref, self)
  expect VerificationKey(owner_key_hash) = datum.owner
  and {
    list.has(self.extra_signatories, owner_key_hash)?,
    only_one_order_input(self, own_hash)?,
    no_beacons_in_outputs(self, datum.beacon_policy_id)?,
  }
}

/// v2: the UNIQUE payment output tagged with this order's own
/// OutputReference. Tags are unique per order input and one-per-output, so
/// the order→payment mapping is injective by construction: N batched takes
/// need N distinct, correctly-valued payments — no output can satisfy two
/// orders (take-many-orders.md §3.3). Zero or duplicate tags crash the run.
fn tagged_payment(self: Transaction, own_ref: OutputReference) -> Output {
  expect [payment] =
    list.filter(
      self.outputs,
      fn(output) {
        when output.datum is {
          InlineDatum(data) ->
            if data is PaymentTag { order_ref }: PaymentTag {
              order_ref == own_ref
            } else {
              False
            }
          _ -> False
        }
      },
    )
  payment
}

/// TakeOrder — mvp-contract-decisions.md §6 amended by take-many-orders.md.
/// Anyone may take, and one tx may take MANY orders: each order input runs
/// this rule independently against its own tagged payment output. The seller
/// is protected by that exact payment; the buyer by authoring the tx (value
/// conservation routes the offered assets wherever the taker directs).
pub fn take_ok(
  datum: OrderDatum,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  let (own_input, own_hash) = own_input_and_hash(own_ref, self)

  // Deposit = order lovelace beyond the offered amount (offer==ADA) or all of
  // the order's lovelace (offer is a token). MCD §1.
  let deposit =
    if beacons.is_ada(datum.offer) {
      assets.lovelace_of(own_input.output.value) - datum.offer_amount
    } else {
      assets.lovelace_of(own_input.output.value)
    }

  // v2: the payment output is identified by its PaymentTag (not by being the
  // only output at the address), then must still land at payment_address.
  let payment = tagged_payment(self, own_ref)

  // §2: exact payment value — ask amount exact, lovelace >= deposit, no
  // foreign assets. (ask == ADA: lovelace >= ask_amount + deposit, no assets.)
  let payment_value_ok =
    if beacons.is_ada(datum.ask) {
      and {
        assets.lovelace_of(payment.value) >= datum.ask_amount + deposit,
        assets.is_zero(assets.without_lovelace(payment.value)),
      }
    } else {
      and {
        assets.lovelace_of(payment.value) >= deposit,
        payment.value == (
          assets.from_lovelace(assets.lovelace_of(payment.value))
            |> assets.add(
                datum.ask.policy_id,
                datum.ask.asset_name,
                datum.ask_amount,
              )
        ),
      }
    }

  and {
    // Defensive re-checks (§6.2) — free insurance on fields the minting
    // policy already validated. v3: a full take is valid regardless of
    // allow_partial_fill — it is also how the LAST fill of a partial-enabled
    // order returns the deposit.
    (datum.version == 1)?,
    (payment.address == datum.payment_address)?,
    beacon_accounting_ok(self, own_hash, datum.beacon_policy_id)?,
    payment_value_ok?,
    expiration_ok(datum.expiration, self)?,
  }
}

/// TakeOrderPartial (v3) — docs/partial-fills.md.
/// Consume take_amount of the offer, pay required = ceil(take*ask/offer) of
/// the ask to payment_address (tagged, like every take payment; the deposit
/// is NOT returned), and recreate the order as a continuation output holding
/// the input value minus the taken offer — deposit, remaining offer and all
/// five beacons — under a datum identical except both amounts reduced.
///
/// The continuation is bound to THIS order input by rank pairing: this run's
/// rank among partial-take inputs (canonical input order) selects one
/// beacon-bearing output, and |beacon-bearing outputs| must equal |partial
/// inputs|. Ranks are distinct and all runs compute the same lists, so the
/// input→continuation mapping is a bijection: two identically-datumed orders
/// can never share one continuation.
pub fn take_partial_ok(
  datum: OrderDatum,
  take_amount: Int,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  let (own_input, own_hash) = own_input_and_hash(own_ref, self)

  let required =
    required_payment(take_amount, datum.ask_amount, datum.offer_amount)

  // Same PaymentTag injectivity as full takes (take-many-orders.md §3).
  let payment = tagged_payment(self, own_ref)

  // Partial payment: exactly `required` of the ask. No deposit is returned
  // (it stays in the continuation), so payment lovelace is unconstrained
  // beyond the ledger's min-UTxO — the TAKER funds it on token asks, and any
  // excess is a gift to the seller (docs/partial-fills.md, min-ADA note).
  let payment_value_ok =
    if beacons.is_ada(datum.ask) {
      and {
        assets.lovelace_of(payment.value) >= required,
        assets.is_zero(assets.without_lovelace(payment.value)),
      }
    } else {
      payment.value == (
        assets.from_lovelace(assets.lovelace_of(payment.value))
          |> assets.add(datum.ask.policy_id, datum.ask.asset_name, required)
      )
    }

  // Rank pairing: this run's rank in S selects its continuation in C.
  let partial_refs = partial_take_refs(self, own_hash)
  expect Some(rank) = list.index_of(partial_refs, own_ref)
  let continuations =
    beacon_bearing_outputs(self, datum.beacon_policy_id)
  expect Some(continuation) = list.at(continuations, rank)

  // Continuation value: EXACTLY the consumed order minus the taken offer.
  // One equality covers everything at once — full deposit retention, the
  // exact remaining offer, exactly the five beacons, no foreign assets.
  // (Covers ADA offers too: subtracting from the lovelace entry.)
  let expected_continuation_value =
    assets.add(
      own_input.output.value,
      datum.offer.policy_id,
      datum.offer.asset_name,
      -take_amount,
    )

  // Continuation datum: identical except both amounts reduced. ask' uses
  // `required`, not the actual payment, so the reduced datum is a pure
  // function of (datum, take_amount) — overpayment is a seller bonus that
  // never cheapens the remainder.
  let expected_continuation_datum =
    OrderDatum {
      ..datum,
      offer_amount: datum.offer_amount - take_amount,
      ask_amount: datum.ask_amount - required,
    }

  let continuation_datum_ok =
    when continuation.datum is {
      InlineDatum(raw) -> {
        expect continuation_datum: OrderDatum = raw
        continuation_datum == expected_continuation_datum
      }
      _ -> False
    }

  and {
    (datum.version == 1)?,
    // Seller opt-in (also enforced at mint time for the flag's integrity).
    datum.allow_partial_fill?,
    // Bounds: strictly inside the order, and the remainder must stay a valid
    // order (offer' > 0 by take < offer; ask' > 0 by required < ask). The
    // exact final fill goes through TakeOrder and returns the deposit.
    (take_amount > 0)?,
    (take_amount < datum.offer_amount)?,
    (required < datum.ask_amount)?,
    (payment.address == datum.payment_address)?,
    payment_value_ok?,
    // Rank-pairing bijection: as many beacon-bearing outputs as partial
    // inputs, and THIS run's is exactly right.
    (list.length(continuations) == list.length(partial_refs))?,
    (continuation.address == own_input.output.address)?,
    (continuation.value == expected_continuation_value)?,
    continuation_datum_ok?,
    (continuation.reference_script == None)?,
    expiration_ok(datum.expiration, self)?,
  }
}
