/**
 * Client-side transaction history. The backend keeps no per-user activity log
 * (it only indexes live order UTxOs), so every tx this app submits is recorded
 * locally in the browser, keyed by the wallet's staking credential — the same
 * identity /orders/by-owner uses. History is cosmetic: the chain is the source
 * of truth, this is just a convenience trail of what YOU did here.
 */

import type { AssetId, TxSummary } from "./types";

export interface HistoryEntry {
  txHash: string;
  /** ms since epoch, when the tx was submitted from this browser. */
  timestamp: number;
  /** owner staking-credential hash, or null if it couldn't be derived. */
  owner: string | null;
  summary: TxSummary;
}

/** One signed money movement for the wallet in a tx (raw units). */
export interface FlowLine {
  direction: "in" | "out";
  label: string;
  assetId: AssetId;
  amount: string;
}

/**
 * The net effect on the wallet, using the same direction rules the pre-sign
 * TransactionPreview shows:
 *   take*  → receive `offered`, pay `requested`
 *   create → lock `offered` (+ refundable deposit) out
 *   cancel → get `offered` back (+ deposit) in
 * Mixed-asset take-many batches omit aggregates on the backend; those simply
 * yield fewer lines (the tx link still resolves the full detail on-chain).
 */
export function summarizeFlow(s: TxSummary): FlowLine[] {
  const lines: FlowLine[] = [];
  const isTake = s.action.startsWith("take");

  if ((isTake || s.action === "cancel-order") && s.offered) {
    lines.push({
      direction: "in",
      label: s.action === "cancel-order" ? "Returned" : "Received",
      assetId: s.offered.assetId,
      amount: s.offered.amount,
    });
  }
  if (isTake && s.requested) {
    lines.push({ direction: "out", label: "Paid", assetId: s.requested.assetId, amount: s.requested.amount });
  }
  if (s.action === "create-order" && s.offered) {
    lines.push({ direction: "out", label: "Locked", assetId: s.offered.assetId, amount: s.offered.amount });
  }
  if (s.action === "create-order" && s.depositLovelace) {
    lines.push({ direction: "out", label: "Deposit", assetId: "lovelace", amount: s.depositLovelace });
  }
  if (s.action === "cancel-order" && s.depositLovelace) {
    lines.push({ direction: "in", label: "Deposit", assetId: "lovelace", amount: s.depositLovelace });
  }
  return lines;
}

const KEY = "beacon-dex:tx-history:v1";
const MAX_ENTRIES = 200;
/** Fired on the window after any mutation so open views refresh in-tab
 *  (the native `storage` event only fires in OTHER tabs). */
export const HISTORY_EVENT = "beacon-dex:history-changed";

function read(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function write(entries: HistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
    window.dispatchEvent(new Event(HISTORY_EVENT));
  } catch {
    /* private-mode / quota — history is best-effort, never block a tx. */
  }
}

/** All entries, newest first. */
export function loadHistory(): HistoryEntry[] {
  return read().sort((a, b) => b.timestamp - a.timestamp);
}

/** Entries for one owner (plus legacy owner-less entries), newest first. */
export function historyForOwner(owner: string | null): HistoryEntry[] {
  return loadHistory().filter((e) => e.owner === owner || e.owner === null);
}

/** Prepend a freshly-submitted tx. De-dupes on txHash (idempotent). */
export function recordHistory(entry: HistoryEntry): void {
  const existing = read().filter((e) => e.txHash !== entry.txHash);
  write([entry, ...existing]);
}

/** Clear this owner's entries (and legacy owner-less ones). Pass nothing to wipe all. */
export function clearHistory(owner?: string | null): void {
  if (owner === undefined) {
    write([]);
    return;
  }
  write(read().filter((e) => e.owner !== owner && e.owner !== null));
}
