/**
 * Collapse an owner's order rows into **positions**. On-chain a partial fill
 * spends one order UTxO and creates a continuation with a new id, so a single
 * seller intent shows up as a chain of rows linked by `parentOrderId` /
 * `rootOrderId`. Users think of that chain as ONE order being filled over time
 * (like a resting limit order on an exchange), so we present it as one position
 * — original size, remaining size, and the individual fills underneath.
 *
 * A plain (never-partially-filled) order is just a chain of length 1 and renders
 * exactly like before.
 */
import type { Order } from "./types";

export interface FillEvent {
  /** offered-asset units sold in this fill. */
  soldOffered: bigint;
  /** ask-asset units the seller received for it. */
  receivedAsk: bigint;
  /** the tx that executed the fill (the continuation's creating tx), if known. */
  txHash?: string;
  kind: "fill" | "final" | "cancel";
}

export interface Position {
  rootId: string;
  /** root → … → tip, ordered by parent links. */
  chain: Order[];
  /** the first order in the chain (its amounts are the original size). */
  original: Order;
  /** the current/most-recent order (its amounts are what remains). */
  tip: Order;
}

/** Order a group's members root → tip by following parent→child links. */
function orderChain(
  rootId: string,
  members: Order[]
): Order[] {
  const memberIds = new Set(members.map((m) => m.orderId));
  const childByParent = new Map<string, Order>();
  for (const m of members) {
    if (m.parentOrderId) childByParent.set(m.parentOrderId, m);
  }
  // Head is the root row if present, else whichever member has no in-group
  // parent (defensive: lineage rows can lag a sync behind the tip).
  const head =
    members.find((m) => m.orderId === rootId) ??
    members.find((m) => !m.parentOrderId || !memberIds.has(m.parentOrderId)) ??
    members[0];

  const chain: Order[] = [];
  const seen = new Set<string>();
  let cur: Order | undefined = head;
  while (cur && !seen.has(cur.orderId)) {
    chain.push(cur);
    seen.add(cur.orderId);
    cur = childByParent.get(cur.orderId);
  }
  // Any members not reachable from head (broken links) still get shown.
  for (const m of members) if (!seen.has(m.orderId)) chain.push(m);
  return chain;
}

export function groupPositions(orders: Order[]): Position[] {
  const groups = new Map<string, Order[]>();
  for (const o of orders) {
    const root = o.rootOrderId ?? o.orderId;
    const g = groups.get(root);
    if (g) g.push(o);
    else groups.set(root, [o]);
  }

  const positions: Position[] = [];
  for (const [rootId, members] of groups) {
    const chain = orderChain(rootId, members);
    positions.push({
      rootId,
      chain,
      original: chain[0]!,
      tip: chain[chain.length - 1]!,
    });
  }

  // Keep the backend's ordering (most-recent activity first): rank each
  // position by the earliest index any of its rows had in the input list.
  const idx = new Map(orders.map((o, i) => [o.orderId, i] as const));
  positions.sort(
    (a, b) =>
      Math.min(...a.chain.map((o) => idx.get(o.orderId) ?? 0)) -
      Math.min(...b.chain.map((o) => idx.get(o.orderId) ?? 0))
  );
  return positions;
}

export type PositionTone = "open" | "partial" | "expired" | "done" | "unknown";

export interface PositionStatus {
  label: string;
  tone: PositionTone;
  /** 0..1 fraction of the original offer that has been sold. */
  filledFraction: number;
  canCancel: boolean;
  /** Past its expiration: unfillable, remainder + deposit claimable by the
   *  owner (a claim IS a cancel tx — the validator has no expiry gate there). */
  expired: boolean;
}

/** Expiry is a property of the clock, not the UTxO — derive it at render time. */
export function isExpired(o: Order, nowPosixMs: number): boolean {
  return o.expiration !== undefined && o.expiration <= nowPosixMs;
}

export function positionStatus(
  p: Position,
  nowPosixMs = Date.now()
): PositionStatus {
  const original = BigInt(p.original.offeredAmount);
  const remaining = BigInt(p.tip.offeredAmount);
  const isDone = p.tip.status === "taken" || p.tip.status === "cancelled";
  const soldSoFar = isDone ? original : original - remaining;
  const filledFraction =
    original > 0n ? Number(soldSoFar) / Number(original) : 0;

  const multi = p.chain.length > 1;
  switch (p.tip.status) {
    case "open":
      if (isExpired(p.tip, nowPosixMs))
        // Takers can't fill it any more; the funds sit locked until claimed.
        return { label: "expired", tone: "expired", filledFraction: multi ? filledFraction : 0, canCancel: true, expired: true };
      return multi
        ? { label: "partially filled", tone: "partial", filledFraction, canCancel: true, expired: false }
        : { label: "open", tone: "open", filledFraction: 0, canCancel: true, expired: false };
    case "partially_filled":
      // Continuation not yet surfaced this sync (rare with the same-pass fix).
      return { label: "partially filled", tone: "partial", filledFraction, canCancel: false, expired: false };
    case "taken":
      return { label: "filled", tone: "done", filledFraction: 1, canCancel: false, expired: false };
    case "cancelled":
      return { label: "cancelled", tone: "done", filledFraction, canCancel: false, expired: false };
    default:
      return { label: p.tip.status, tone: "unknown", filledFraction, canCancel: false, expired: false };
  }
}

/** The individual fills (and closing event) that make up a position's history. */
export function fillEvents(p: Position): FillEvent[] {
  const events: FillEvent[] = [];
  for (let i = 0; i < p.chain.length - 1; i++) {
    const cur = p.chain[i]!;
    const next = p.chain[i + 1]!;
    const soldOffered = BigInt(cur.offeredAmount) - BigInt(next.offeredAmount);
    if (soldOffered <= 0n) continue; // defensive: no real fill sells 0
    events.push({
      soldOffered,
      receivedAsk: BigInt(cur.requestedAmount) - BigInt(next.requestedAmount),
      // The continuation's own creating tx IS the fill tx.
      txHash: next.txHash,
      kind: "fill",
    });
  }
  const tip = p.tip;
  if (tip.status === "taken") {
    events.push({
      soldOffered: BigInt(tip.offeredAmount),
      receivedAsk: BigInt(tip.requestedAmount),
      kind: "final",
    });
  } else if (tip.status === "cancelled") {
    events.push({ soldOffered: 0n, receivedAsk: 0n, kind: "cancel" });
  }
  return events;
}
