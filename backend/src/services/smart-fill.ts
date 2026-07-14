import { maxTakeForSpend, requiredPayment } from "../protocol/datum.js";
import {
  isOrderExpired,
  type AssetId,
  type Order,
  type PairId,
  type SmartFillRoute,
} from "../types.js";

/**
 * Smart Fill route planner — PURE, off-chain, no network/DB. Given a pair's
 * open orders and a taker's target, pick the best set of WHOLE existing orders
 * to fill, cheapest effective price first — plus (v3, docs/partial-fills.md)
 * at most ONE marginal PARTIAL leg on a partial-fill-enabled order, to spend
 * leftover budget (spend mode) or hit the target exactly (receive mode).
 *
 * The target is bidirectional (like any swap UI):
 *  - mode "spend":   fill as much as possible WITHOUT exceeding `limit` spend.
 *  - mode "receive": fill the cheapest orders UNTIL received >= `limit`
 *                    (a partial last leg hits the target exactly when the
 *                    order allows it; otherwise the whole order overshoots).
 *
 * v2 execution (docs/take-many-orders.md): legs are grouped into
 * TakeManyOrders batches of up to `maxOrdersPerTx` — each batch settles in
 * ONE atomic transaction; a route needing several batches is atomic within
 * each batch but not across them. This planner does NOT settle anything.
 * All math is bigint — prices compared by cross-multiply, never floats.
 */

export interface SmartFillParams {
  spendAsset: AssetId;
  receiveAsset: AssetId;
  /** "spend" = limit is a max spend; "receive" = limit is a target receive. */
  mode: "spend" | "receive";
  /** Raw amount of the constraining side (spend asset if "spend", else receive). */
  limit: bigint;
  /** Batch cap for TakeManyOrders txs (config MAX_ORDERS_PER_TX). */
  maxOrdersPerTx?: number;
  /** v3 dust guard: skip a marginal partial leg that would spend less than
   *  this (raw spend-asset units; config SMART_FILL_MIN_PARTIAL_SPEND). A
   *  partial leg also costs the taker ~1.4 ADA min-ADA on token asks. */
  minPartialSpend?: bigint;
  /** Clock for expiry filtering (POSIX ms); injectable for tests. */
  nowPosixMs?: number;
}

/** "policyId.name" (or "lovelace") for the asset an order OFFERS to the taker. */
function offeredAssetId(o: Order): AssetId {
  return o.offeredPolicyId === ""
    ? "lovelace"
    : `${o.offeredPolicyId}.${o.offeredAssetName}`;
}

/** "policyId.name" (or "lovelace") for the asset an order REQUESTS from the taker. */
function requestedAssetId(o: Order): AssetId {
  return o.requestedPolicyId === ""
    ? "lovelace"
    : `${o.requestedPolicyId}.${o.requestedAssetName}`;
}

/** Canonical pair id: the two asset ids sorted lexicographically, joined by "_". */
export function pairIdOf(a: AssetId, b: AssetId): PairId {
  return [a, b].sort().join("_");
}

/**
 * spend/receive as a fixed-precision decimal string, bigint-safe (no float).
 * Returns "" when receive is 0.
 */
export function ratioToDecimal(
  numerator: bigint,
  denominator: bigint,
  precision = 8
): string {
  if (denominator === 0n) return "";
  const scale = 10n ** BigInt(precision);
  const scaled = (numerator * scale) / denominator;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(precision, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/**
 * True iff order `a` has a strictly better effective price than `b`
 * (a.requested/a.offered < b.requested/b.offered), by cross-multiplication.
 * All amounts are positive (guaranteed at order creation, §4).
 */
function cheaper(a: Order, b: Order): boolean {
  return (
    BigInt(a.requestedAmount) * BigInt(b.offeredAmount) <
    BigInt(b.requestedAmount) * BigInt(a.offeredAmount)
  );
}

/**
 * Plan a Smart Fill route from a pair's open orders. `orders` is expected to be
 * the open orders for the derived pair (e.g. from OrdersRepo.listByPair); this
 * function does the side/asset filtering itself so it stays independently
 * testable and never duplicates order-book queries.
 */
export function planSmartFill(
  orders: Order[],
  {
    spendAsset,
    receiveAsset,
    mode,
    limit,
    maxOrdersPerTx = 8,
    minPartialSpend = 1n,
    nowPosixMs = Date.now(),
  }: SmartFillParams
): SmartFillRoute {
  const pairId = pairIdOf(spendAsset, receiveAsset);
  const warnings: string[] = [];

  // Taker's side of the book: the order must OFFER what the user wants to
  // receive and REQUEST what the user is spending. Only open, positive-amount,
  // non-expired orders are eligible (an expired order can't be taken at all —
  // the builder would reject it with order_expired).
  const candidates = orders
    .filter(
      (o) =>
        o.status === "open" &&
        !isOrderExpired(o, nowPosixMs) &&
        offeredAssetId(o) === receiveAsset &&
        requestedAssetId(o) === spendAsset &&
        BigInt(o.offeredAmount) > 0n &&
        BigInt(o.requestedAmount) > 0n
    )
    // Cheapest effective price first; tie-break to fewer txs (bigger receive),
    // then orderId for a stable, deterministic order.
    .sort((a, b) => {
      if (cheaper(a, b)) return -1;
      if (cheaper(b, a)) return 1;
      const ra = BigInt(a.offeredAmount);
      const rb = BigInt(b.offeredAmount);
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
    });

  // Greedy WHOLE-order selection, cheapest first. "spend" mode stops when the
  // next order would exceed the budget; "receive" mode stops once the target
  // receive is met. v3 adds at most ONE marginal PARTIAL leg afterwards.
  const legs: SmartFillRoute["legs"] = [];
  let remaining = mode === "spend" ? limit : 0n; // spend budget (spend mode only)
  let totalSpend = 0n;
  let totalReceive = 0n;
  let skippedByBudget = false;
  const selected = new Set<string>();

  const pushPartialLeg = (o: Order, take: bigint, spend: bigint) => {
    selected.add(o.orderId);
    totalSpend += spend;
    totalReceive += take;
    legs.push({
      orderId: o.orderId,
      spend: spend.toString(),
      receive: take.toString(),
      price: ratioToDecimal(spend, take),
      ...(o.expiration !== undefined ? { expiration: o.expiration } : {}),
      partial: true,
      takeAmount: take.toString(),
    });
  };

  for (const o of candidates) {
    const spend = BigInt(o.requestedAmount);
    const offered = BigInt(o.offeredAmount);

    if (mode === "receive") {
      if (totalReceive >= limit) break;
      const needed = limit - totalReceive;
      // v3: when the whole order would overshoot the target and it allows
      // partial fills, take exactly what's needed and stop.
      if (needed < offered && o.allowPartialFill) {
        const required = requiredPayment(needed, spend, offered);
        if (required < spend) {
          pushPartialLeg(o, needed, required);
          break;
        }
      }
    }
    if (mode === "spend" && spend > remaining) {
      skippedByBudget = true;
      continue;
    }
    selected.add(o.orderId);
    remaining -= spend;
    totalSpend += spend;
    totalReceive += offered;
    legs.push({
      orderId: o.orderId,
      spend: o.requestedAmount,
      receive: o.offeredAmount,
      price: ratioToDecimal(spend, offered),
      ...(o.expiration !== undefined ? { expiration: o.expiration } : {}),
    });
  }

  // v3, spend mode: use the leftover budget with ONE partial leg on the
  // cheapest partial-enabled order not already taken whole. Below the dust
  // threshold the leftover stays honestly unused (warned below).
  let partialSkippedAsDust = false;
  if (mode === "spend" && remaining > 0n && legs.length < candidates.length) {
    for (const o of candidates) {
      if (selected.has(o.orderId) || !o.allowPartialFill) continue;
      const take = maxTakeForSpend(
        remaining,
        BigInt(o.requestedAmount),
        BigInt(o.offeredAmount)
      );
      if (take <= 0n) continue;
      const required = requiredPayment(
        take,
        BigInt(o.requestedAmount),
        BigInt(o.offeredAmount)
      );
      if (required < minPartialSpend) {
        partialSkippedAsDust = true;
        continue;
      }
      remaining -= required;
      pushPartialLeg(o, take, required);
      break;
    }
  }

  // v2: legs settle in TakeManyOrders batches of up to maxOrdersPerTx —
  // each batch is one atomic tx.
  const transactionCount = Math.ceil(legs.length / maxOrdersPerTx);
  const atomic = legs.length > 0 && transactionCount === 1;

  if (candidates.length === 0) {
    warnings.push(
      `No open orders on ${pairId} let you spend ${spendAsset} to receive ${receiveAsset}.`
    );
  } else if (legs.length === 0) {
    const cheapest = candidates[0]!.requestedAmount;
    warnings.push(
      `Max spend ${limit.toString()} is below the cheapest order's ${cheapest} and no partial-fill-enabled order can absorb it; increase it to fill at least one order.`
    );
  } else {
    if (transactionCount > 1)
      warnings.push(
        `Route needs ${transactionCount} transactions (at most ${maxOrdersPerTx} orders fit in one) — each transaction is atomic, but orders can be taken by others between them.`
      );
    if (mode === "spend" && skippedByBudget && remaining > 0n)
      warnings.push(
        partialSkippedAsDust
          ? `${remaining.toString()} of max spend is left unused (below the ${minPartialSpend.toString()} dust threshold for a partial fill).`
          : `${remaining.toString()} of max spend is left unused: the remaining orders don't allow partial fills.`
      );
    if (legs.some((l) => l.partial))
      warnings.push(
        "Route includes a partial fill: the order's remainder stays on the book, and you fund ~1.4 ADA min-ADA on the seller's payment if the spend asset is a token."
      );
    if (mode === "receive" && totalReceive < limit)
      warnings.push(
        `Only ${totalReceive.toString()} of your ${limit.toString()} target is available in open orders; taking everything routable.`
      );
    if (mode === "receive" && totalReceive > limit)
      warnings.push(
        `The route receives ${totalReceive.toString()} (target was ${limit.toString()}) — the last order doesn't allow partial fills, so it is taken whole.`
      );
  }

  return {
    pairId,
    spendAsset,
    receiveAsset,
    mode,
    requested: limit.toString(),
    legs,
    totalSpend: totalSpend.toString(),
    totalReceive: totalReceive.toString(),
    averagePrice: ratioToDecimal(totalSpend, totalReceive),
    transactionCount,
    maxOrdersPerTx,
    atomic,
    candidateCount: candidates.length,
    warnings,
  };
}
