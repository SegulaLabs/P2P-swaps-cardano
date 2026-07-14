import {
  deserializeDatum,
  mConStr0,
  mConStr1,
  mConStr2,
  type Data,
} from "@meshsdk/core";
import type { AssetClassHex } from "./beacons.js";

/**
 * OrderDatum codec — mirrors contracts/lib/p2p_dex/types.ak exactly.
 *
 * On-chain shape (Plutus Data):
 *   OrderDatum = Constr 0 [ version, beacon_policy_id, owner,
 *                           payment_address, offer, offer_amount,
 *                           ask, ask_amount, expiration, allow_partial_fill ]
 *   Credential  = Constr 0 [key_hash] | Constr 1 [script_hash]
 *   Address     = Constr 0 [payment_credential, stake_option]
 *   stake       = Some(Inline(cred)) = Constr 0 [Constr 0 [cred]] | None = Constr 1 []
 *   AssetClass  = Constr 0 [policy_id, asset_name]
 *   Option<Int> = Constr 0 [i] | Constr 1 []
 *   Bool        = False = Constr 0 [], True = Constr 1 []  (PlutusTx/Aiken convention)
 *
 * Redeemers: OrderRedeemer Cancel=Constr 0, Take=Constr 1,
 *            TakeOrderPartial=Constr 2 [take_amount] (v3, append-only);
 *            BeaconRedeemer Mint=Constr 0, Burn=Constr 1.
 */

export interface OrderDatumFields {
  version: number;
  beaconPolicyId: string;
  /** hex key hash of the owner's staking key (MVP: key owners only) */
  ownerKeyHash: string;
  /** payment address parts (key payment credential enforced on-chain) */
  paymentPubKeyHash: string;
  paymentStakeKeyHash: string | null;
  offer: AssetClassHex;
  offerAmount: bigint;
  ask: AssetClassHex;
  askAmount: bigint;
  /** POSIX ms or null */
  expiration: number | null;
  allowPartialFill: boolean;
}

function credentialKey(hash: string): Data {
  return mConStr0([hash]);
}

function keyAddress(pubKeyHash: string, stakeKeyHash: string | null): Data {
  const stake =
    stakeKeyHash === null
      ? mConStr1([])
      : mConStr0([mConStr0([credentialKey(stakeKeyHash)])]);
  return mConStr0([credentialKey(pubKeyHash), stake]);
}

function assetClass(a: AssetClassHex): Data {
  return mConStr0([a.policyId, a.assetNameHex]);
}

/** Mesh-format Data value for txOutInlineDatumValue(..., "Mesh"). */
export function encodeOrderDatum(d: OrderDatumFields): Data {
  return mConStr0([
    d.version,
    d.beaconPolicyId,
    credentialKey(d.ownerKeyHash),
    keyAddress(d.paymentPubKeyHash, d.paymentStakeKeyHash),
    assetClass(d.offer),
    d.offerAmount,
    assetClass(d.ask),
    d.askAmount,
    d.expiration === null ? mConStr1([]) : mConStr0([d.expiration]),
    d.allowPartialFill ? mConStr1([]) : mConStr0([]),
  ]);
}

/**
 * PaymentTag — the inline datum REQUIRED on every take payment output (v2):
 *   PaymentTag      = Constr 0 [ order_ref ]
 *   OutputReference = Constr 0 [ transaction_id (bytes), output_index (int) ]
 * Mirrors contracts/lib/p2p_dex/types.ak::PaymentTag (take-many-orders.md §3.1).
 */
export function encodePaymentTag(orderTxHash: string, outputIndex: number): Data {
  return mConStr0([mConStr0([orderTxHash, outputIndex])]);
}

export const CANCEL_REDEEMER: Data = mConStr0([]);
export const TAKE_REDEEMER: Data = mConStr1([]);
export const MINT_BEACONS_REDEEMER: Data = mConStr0([]);
export const BURN_BEACONS_REDEEMER: Data = mConStr1([]);

/** v3 TakeOrderPartial redeemer — consume `takeAmount` of the offer. */
export function takePartialRedeemer(takeAmount: bigint): Data {
  return mConStr2([takeAmount]);
}

// ---------------------------------------------------------------- pricing
// Single source of truth for partial-fill math (docs/partial-fills.md §1);
// mirrors order_rules.required_payment exactly. All bigint — never floats.

/**
 * The ask owed for a partial fill of `take`: ceil(take * ask / offer).
 * Rounding always favours the seller. The continuation datum reduces by
 * exactly this (ask' = ask - required), independent of actual overpayment.
 */
export function requiredPayment(take: bigint, ask: bigint, offer: bigint): bigint {
  if (take <= 0n || ask <= 0n || offer <= 0n)
    throw new Error("requiredPayment: all arguments must be positive");
  return (take * ask + offer - 1n) / offer;
}

/**
 * The largest valid partial take affordable with `spend` of the ask asset:
 * requiredPayment(take) <= spend, take < offer (offer' > 0), and
 * requiredPayment(take) < ask (ask' > 0). Returns 0n when no valid take fits.
 */
export function maxTakeForSpend(spend: bigint, ask: bigint, offer: bigint): bigint {
  if (spend <= 0n || ask <= 0n || offer <= 0n) return 0n;
  // ceil(take*ask/offer) <= s  <=>  take*ask <= s*offer  <=>  take <= floor(s*offer/ask)
  let take = (spend * offer) / ask;
  // required < ask  <=>  take <= floor((ask-1)*offer/ask)
  const askCap = ((ask - 1n) * offer) / ask;
  if (take > askCap) take = askCap;
  if (take > offer - 1n) take = offer - 1n;
  return take > 0n ? take : 0n;
}

// ---------------------------------------------------------------- decoding
// deserializeDatum returns JSON-schema style nodes:
//   { constructor: bigint, fields: [...] } | { int: bigint } | { bytes: hex }

type Node = Record<string, unknown>;

// NB: `"constructor" in obj` is true for EVERY object via the prototype
// chain — deserializeDatum nodes carry it as an OWN key, so use hasOwn.
function constr(node: unknown, expected?: number): Node[] {
  const n = node as Node;
  if (n === null || typeof n !== "object" || !Object.hasOwn(n, "constructor"))
    throw new Error("datum: expected constructor node");
  const alt = Number(n["constructor" as keyof Node]);
  if (expected !== undefined && alt !== expected)
    throw new Error(`datum: expected constr ${expected}, got ${alt}`);
  return n.fields as Node[];
}

function constrAlt(node: unknown): number {
  const n = node as Node;
  if (n === null || typeof n !== "object" || !Object.hasOwn(n, "constructor"))
    throw new Error("datum: expected constructor node");
  return Number(n["constructor" as keyof Node]);
}

function asInt(node: unknown): bigint {
  const n = node as Node;
  if (n === null || typeof n !== "object" || !("int" in n))
    throw new Error("datum: expected int node");
  return BigInt(n.int as bigint | number | string);
}

function asBytes(node: unknown): string {
  const n = node as Node;
  if (n === null || typeof n !== "object" || !("bytes" in n))
    throw new Error("datum: expected bytes node");
  return (n.bytes as string).toLowerCase();
}

function decodeAssetClass(node: unknown): AssetClassHex {
  const [policy, name] = constr(node, 0);
  return { policyId: asBytes(policy), assetNameHex: asBytes(name) };
}

/**
 * Decode + validate an inline-datum CBOR hex into OrderDatumFields.
 * Throws on anything that is not a well-formed v1 key-owner order datum —
 * the indexer treats a throw as "not a protocol order".
 */
export function decodeOrderDatum(inlineDatumCborHex: string): OrderDatumFields {
  const root = deserializeDatum(inlineDatumCborHex);
  const f = constr(root, 0);
  if (f.length !== 10) throw new Error("datum: expected 10 fields");

  const version = Number(asInt(f[0]));
  const beaconPolicyId = asBytes(f[1]);

  const ownerFields = constr(f[2], 0); // VerificationKey credential only
  const ownerKeyHash = asBytes(ownerFields[0]);

  const [payCred, stakeOpt] = constr(f[3], 0);
  const payFields = constr(payCred, 0); // key payment credential only
  const paymentPubKeyHash = asBytes(payFields[0]);
  let paymentStakeKeyHash: string | null = null;
  if (constrAlt(stakeOpt) === 0) {
    const [inline] = constr(stakeOpt, 0);
    const [stakeCred] = constr(inline, 0); // Inline
    const stakeFields = constr(stakeCred, 0); // key stake credential
    paymentStakeKeyHash = asBytes(stakeFields[0]);
  }

  const offer = decodeAssetClass(f[4]);
  const offerAmount = asInt(f[5]);
  const ask = decodeAssetClass(f[6]);
  const askAmount = asInt(f[7]);

  const expiration =
    constrAlt(f[8]) === 0 ? Number(asInt(constr(f[8], 0)[0])) : null;
  const allowPartialFill = constrAlt(f[9]) === 1;

  if (version !== 1) throw new Error("datum: unsupported version");
  if (offerAmount <= 0n || askAmount <= 0n)
    throw new Error("datum: non-positive amount");

  return {
    version,
    beaconPolicyId,
    ownerKeyHash,
    paymentPubKeyHash,
    paymentStakeKeyHash,
    offer,
    offerAmount,
    ask,
    askAmount,
    expiration,
    allowPartialFill,
  };
}
