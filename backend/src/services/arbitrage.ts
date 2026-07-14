import { maxTakeForSpend, requiredPayment } from "../protocol/datum.js";
import {
  isOrderExpired,
  type ArbitrageLeg,
  type ArbitrageOpportunity,
  type ArbitrageScan,
  type AssetId,
  type Order,
} from "../types.js";
import { ratioToDecimal } from "./smart-fill.js";

/**
 * Arbitrage finder — PURE, off-chain, no network/DB (docs/arbitrage.md).
 *
 * Taking an order converts assets for the taker: pay the ask, receive the
 * offer — a directed edge `askAsset -> offerAsset` at rate offer/ask. A cycle
 * of orders whose rates multiply above 1 AND whose amounts chain (whole
 * orders, or trimmed via v3 partial fills where the seller allows it) is a
 * riskless profit: settled as ONE atomic TakeManyOrders tx, the cycle funds
 * itself — assets released by one order pay the next order's ask inside the
 * same transaction, so the wallet never fronts any of the cycle's assets.
 *
 * v1 scope: 2-cycles (a crossed pair) and 3-cycles (triangles), one order per
 * edge, top-K candidate orders per edge. All math is bigint — prices compared
 * by cross-multiplication, never floats.
 */

export interface ArbitrageParams {
  /** Fee estimate per (single) TakeManyOrders tx, lovelace. */
  feeEstimateLovelace?: bigint;
  /** Candidate orders considered per directed edge for 2-cycles. */
  directTopK?: number;
  /** Candidate orders considered per directed edge for 3-cycles. */
  triangularTopK?: number;
  /** Keep at most this many opportunities (best margin first). */
  maxOpportunities?: number;
  /** Clock for expiry filtering (POSIX ms); injectable for tests. */
  nowPosixMs?: number;
}

/** Mirrors the tx builder: min-ADA the taker funds on a partial payment leg. */
const PARTIAL_PAYMENT_LOVELACE = 1_400_000n;

function offeredAssetId(o: Order): AssetId {
  return o.offeredPolicyId === ""
    ? "lovelace"
    : `${o.offeredPolicyId}.${o.offeredAssetName}`;
}

function requestedAssetId(o: Order): AssetId {
  return o.requestedPolicyId === ""
    ? "lovelace"
    : `${o.requestedPolicyId}.${o.requestedAssetName}`;
}

/** Better rate first: a.offer/a.ask > b.offer/b.ask by cross-multiplication. */
function betterRate(a: Order, b: Order): boolean {
  return (
    BigInt(a.offeredAmount) * BigInt(b.requestedAmount) >
    BigInt(b.offeredAmount) * BigInt(a.requestedAmount)
  );
}

/**
 * Size one rotation of a cycle: the anchor (first) order is taken whole;
 * walking forward, each later leg must be paid entirely out of what the
 * previous leg delivered — trimmed with a partial fill when the ask exceeds
 * the carry and the seller allows it, rejected otherwise (NO wallet top-ups).
 * Returns null when the amounts cannot chain or nothing is left over.
 */
function sizeRotation(cycle: Order[]): ArbitrageLeg[] | null {
  const legs: ArbitrageLeg[] = [];
  let carry = 0n; // amount of legs[i].payAsset available from the previous leg
  for (let i = 0; i < cycle.length; i++) {
    const o = cycle[i]!;
    const ask = BigInt(o.requestedAmount);
    const offer = BigInt(o.offeredAmount);
    let pay = ask;
    let receive = offer;
    let takeAmount: bigint | undefined;
    if (i > 0 && ask > carry) {
      if (!o.allowPartialFill) return null;
      const take = maxTakeForSpend(carry, ask, offer);
      if (take <= 0n) return null;
      takeAmount = take;
      pay = requiredPayment(take, ask, offer);
      receive = take;
    }
    legs.push({
      orderId: o.orderId,
      payAsset: requestedAssetId(o),
      payAmount: pay.toString(),
      receiveAsset: offeredAssetId(o),
      receiveAmount: receive.toString(),
      ...(o.expiration !== undefined ? { expiration: o.expiration } : {}),
      ...(takeAmount !== undefined
        ? { partial: true, takeAmount: takeAmount.toString() }
        : {}),
    });
    carry = receive;
  }
  return legs;
}

/** Per-asset taker net over the legs (pay negative, receive positive). */
function netsOf(legs: ArbitrageLeg[]): Map<AssetId, bigint> {
  const nets = new Map<AssetId, bigint>();
  for (const l of legs) {
    nets.set(l.payAsset, (nets.get(l.payAsset) ?? 0n) - BigInt(l.payAmount));
    nets.set(
      l.receiveAsset,
      (nets.get(l.receiveAsset) ?? 0n) + BigInt(l.receiveAmount)
    );
  }
  return nets;
}

/** Riskless = every asset nets >= 0 and at least one nets > 0. */
function isRiskless(nets: Map<AssetId, bigint>): boolean {
  let positive = false;
  for (const v of nets.values()) {
    if (v < 0n) return false;
    if (v > 0n) positive = true;
  }
  return positive;
}

/** Taker-funded lovelace on partial legs (docs/partial-fills.md §1). */
function partialMinAdaOf(legs: ArbitrageLeg[]): bigint {
  let total = 0n;
  for (const l of legs) {
    if (!l.partial) continue;
    if (l.payAsset !== "lovelace") total += PARTIAL_PAYMENT_LOVELACE;
    else {
      const pay = BigInt(l.payAmount);
      if (pay < PARTIAL_PAYMENT_LOVELACE)
        total += PARTIAL_PAYMENT_LOVELACE - pay;
    }
  }
  return total;
}

interface Evaluated {
  legs: ArbitrageLeg[];
  nets: Map<AssetId, bigint>;
  partialMinAda: bigint;
  lovelaceNetAfterCosts: bigint;
}

/**
 * Try every rotation of the order cycle (each choice of anchor leg trims
 * differently) and keep the best sizing: fewest partial legs, then largest
 * fee-adjusted lovelace net. Returns null when no rotation chains.
 */
function evaluateCycle(orders: Order[], fee: bigint): Evaluated | null {
  let best: Evaluated | null = null;
  for (let r = 0; r < orders.length; r++) {
    const rotated = [...orders.slice(r), ...orders.slice(0, r)];
    const legs = sizeRotation(rotated);
    if (!legs) continue;
    const nets = netsOf(legs);
    if (!isRiskless(nets)) continue;
    const partialMinAda = partialMinAdaOf(legs);
    const candidate: Evaluated = {
      legs,
      nets,
      partialMinAda,
      lovelaceNetAfterCosts:
        (nets.get("lovelace") ?? 0n) - fee - partialMinAda,
    };
    if (
      !best ||
      partialCount(candidate.legs) < partialCount(best.legs) ||
      (partialCount(candidate.legs) === partialCount(best.legs) &&
        candidate.lovelaceNetAfterCosts > best.lovelaceNetAfterCosts)
    )
      best = candidate;
  }
  return best;
}

function partialCount(legs: ArbitrageLeg[]): number {
  return legs.reduce((n, l) => n + (l.partial ? 1 : 0), 0);
}

/** Quoted margin of the cycle: Π offer / Π ask − 1 (bigint, pre-sizing). */
function marginOf(orders: Order[]): { num: bigint; den: bigint } {
  let po = 1n;
  let pa = 1n;
  for (const o of orders) {
    po *= BigInt(o.offeredAmount);
    pa *= BigInt(o.requestedAmount);
  }
  return { num: po - pa, den: pa };
}

function toOpportunity(
  orders: Order[],
  evaluated: Evaluated,
  fee: bigint
): ArbitrageOpportunity {
  const { legs, nets, partialMinAda, lovelaceNetAfterCosts } = evaluated;
  const margin = marginOf(orders);
  const warnings: string[] = [
    "The order book is a cache — if any leg is taken by someone else first, this transaction fails WHOLE and no funds move (atomic).",
  ];
  if (partialCount(legs) > 0)
    warnings.push(
      `${partialCount(legs)} leg(s) are partial fills: no deposit is returned on those and you fund ${partialMinAda} lovelace of min-ADA on the sellers' payments.`
    );
  if (lovelaceNetAfterCosts < 0n)
    warnings.push(
      `After the ~${fee} lovelace fee estimate the ADA line is negative (${lovelaceNetAfterCosts}) — the profit of this cycle is in tokens; you pay ADA to collect it.`
    );
  const expirations = legs
    .map((l) => l.expiration)
    .filter((e): e is number => e !== undefined);
  return {
    id: legs
      .map((l) => l.orderId)
      .sort()
      .join("+"),
    kind: legs.length === 2 ? "direct" : "triangular",
    cycle: legs.map((l) => l.payAsset),
    legs,
    net: [...nets.entries()]
      .filter(([, v]) => v !== 0n)
      .map(([assetId, v]) => ({ assetId, amount: v.toString() })),
    marginPct: ratioToDecimal(margin.num * 100n, margin.den, 4),
    estimatedFeeLovelace: fee.toString(),
    partialMinAdaLovelace: partialMinAda.toString(),
    lovelaceNetAfterCosts: lovelaceNetAfterCosts.toString(),
    ...(expirations.length > 0
      ? { expiresAt: Math.min(...expirations) }
      : {}),
    warnings,
  };
}

/**
 * Scan the open book for riskless cycles. `orders` is the whole cached book
 * (any pair, any status — filtering happens here so the finder stays
 * independently testable).
 */
export function findArbitrage(
  orders: Order[],
  {
    feeEstimateLovelace = 1_000_000n,
    directTopK = 4,
    triangularTopK = 2,
    maxOpportunities = 20,
    nowPosixMs = Date.now(),
  }: ArbitrageParams = {}
): ArbitrageScan {
  const open = orders.filter(
    (o) =>
      o.status === "open" &&
      !isOrderExpired(o, nowPosixMs) &&
      BigInt(o.offeredAmount) > 0n &&
      BigInt(o.requestedAmount) > 0n
  );

  // Directed edges: ask asset -> offer asset, best rate first (deterministic
  // tie-break by orderId so scans are stable across refreshes).
  const edges = new Map<AssetId, Map<AssetId, Order[]>>();
  for (const o of open) {
    const from = requestedAssetId(o);
    const to = offeredAssetId(o);
    if (from === to) continue; // malformed; creation forbids it anyway
    const byTo = edges.get(from) ?? new Map<AssetId, Order[]>();
    const list = byTo.get(to) ?? [];
    list.push(o);
    byTo.set(to, list);
    edges.set(from, byTo);
  }
  for (const byTo of edges.values())
    for (const list of byTo.values())
      list.sort((a, b) => {
        if (betterRate(a, b)) return -1;
        if (betterRate(b, a)) return 1;
        return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
      });

  const edge = (from: AssetId, to: AssetId): Order[] =>
    edges.get(from)?.get(to) ?? [];

  // A rate-product pre-filter: Π offer > Π ask is NECESSARY for a riskless
  // cycle (with any rate product <= 1, all-nonnegative nets are impossible).
  const rateProductPositive = (cycle: Order[]): boolean => {
    const { num } = marginOf(cycle);
    return num > 0n;
  };

  const found = new Map<string, { orders: Order[]; ev: Evaluated }>();
  const consider = (cycle: Order[]) => {
    if (!rateProductPositive(cycle)) return;
    const id = cycle
      .map((o) => o.orderId)
      .sort()
      .join("+");
    if (found.has(id)) return;
    const ev = evaluateCycle(cycle, feeEstimateLovelace);
    if (ev) found.set(id, { orders: cycle, ev });
  };

  const assets = [...edges.keys()];

  // 2-cycles: every asset pair traded in both directions (a crossed book).
  for (const a of assets)
    for (const b of edges.get(a)!.keys()) {
      if (a >= b) continue; // unordered pair once
      for (const o1 of edge(a, b).slice(0, directTopK))
        for (const o2 of edge(b, a).slice(0, directTopK)) consider([o1, o2]);
    }

  // 3-cycles: anchor at the lexicographically smallest asset so each cycle
  // orientation is enumerated exactly once (the reverse orientation uses the
  // opposite edges and is a different cycle, visited via its own b/c choice).
  for (const a of assets)
    for (const b of edges.get(a)!.keys()) {
      if (b <= a) continue;
      for (const c of edges.get(b)?.keys() ?? []) {
        if (c <= a || c === b) continue;
        if (edge(c, a).length === 0) continue;
        for (const o1 of edge(a, b).slice(0, triangularTopK))
          for (const o2 of edge(b, c).slice(0, triangularTopK))
            for (const o3 of edge(c, a).slice(0, triangularTopK))
              consider([o1, o2, o3]);
      }
    }

  // Best quoted margin first (bigint fraction comparison), then stable by id.
  const ranked = [...found.entries()].sort(([ia, a], [ib, b]) => {
    const ma = marginOf(a.orders);
    const mb = marginOf(b.orders);
    const cmp = ma.num * mb.den - mb.num * ma.den;
    if (cmp !== 0n) return cmp > 0n ? -1 : 1;
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });

  const opportunities = ranked
    .slice(0, maxOpportunities)
    .map(([, { orders: cycle, ev }]) =>
      toOpportunity(cycle, ev, feeEstimateLovelace)
    );

  const warnings: string[] = [];
  if (opportunities.length === 0)
    warnings.push(
      "No riskless cycles in the current open book — prices don't cross, or crossing orders' amounts can't chain (no partial fills allowed)."
    );

  return {
    opportunities,
    scannedOrders: open.length,
    pairCount: new Set(open.map((o) => o.pairId)).size,
    generatedAtMs: nowPosixMs,
    warnings,
  };
}
