/**
 * v3 partial-fill pricing — bigint mirror of the on-chain rule
 * (contracts/lib/p2p_dex/order_rules.ak::required_payment) and of
 * backend/src/protocol/datum.ts. Keep the three in lockstep
 * (docs/partial-fills.md §1). Never floats.
 */

/**
 * The ask owed for a partial fill of `take`: ceil(take * ask / offer).
 * Rounding always favours the seller.
 */
export function requiredPayment(take: bigint, ask: bigint, offer: bigint): bigint {
  if (take <= 0n || ask <= 0n || offer <= 0n)
    throw new Error("requiredPayment: all arguments must be positive");
  return (take * ask + offer - 1n) / offer;
}

/**
 * The largest valid partial take affordable with `spend` of the ask asset:
 * requiredPayment(take) <= spend, take < offer, requiredPayment(take) < ask.
 * Returns 0n when no valid take fits.
 */
export function maxTakeForSpend(spend: bigint, ask: bigint, offer: bigint): bigint {
  if (spend <= 0n || ask <= 0n || offer <= 0n) return 0n;
  let take = (spend * offer) / ask;
  const askCap = ((ask - 1n) * offer) / ask;
  if (take > askCap) take = askCap;
  if (take > offer - 1n) take = offer - 1n;
  return take > 0n ? take : 0n;
}

/**
 * Clamp a user-entered take amount to the valid partial range
 * [1, min(offer-1, largest take with required < ask)]; 0n = nothing valid.
 */
export function clampTake(take: bigint, ask: bigint, offer: bigint): bigint {
  if (offer <= 1n || ask <= 1n) return 0n;
  const max = maxTakeForSpend(ask - 1n, ask, offer); // spend cap = ask-1 => required < ask
  if (max <= 0n) return 0n;
  if (take < 1n) return 1n;
  return take > max ? max : take;
}
