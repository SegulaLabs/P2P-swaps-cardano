"use client";

import { useCallback, useEffect, useState } from "react";
import type { TxSummary } from "@/lib/types";
import {
  clearHistory,
  historyForOwner,
  HISTORY_EVENT,
  summarizeFlow,
  type HistoryEntry,
} from "@/lib/history";
import { shortId } from "@/lib/validate";
import { useOwnerCredential } from "@/hooks/useOwnerCredential";
import { ExplorerLink } from "./ExplorerLink";
import { TokenAmount, TokenAvatar } from "./Token";

const ACTION_LABEL: Record<TxSummary["action"], string> = {
  "create-order": "Create order",
  "cancel-order": "Cancel order",
  "take-order": "Take order",
  "take-order-partial": "Partial fill",
  "take-many-orders": "Take orders",
};

/** In/out money lines for one tx: token avatar + signed, coloured amount. */
function FlowCell({ summary }: { summary: TxSummary }) {
  const lines = summarizeFlow(summary);
  if (lines.length === 0)
    return <span className="muted small">see transaction ↗</span>;
  return (
    <div className="hist-flow">
      {lines.map((l, i) => (
        <span key={i} className="hist-flow-line" title={l.label}>
          <TokenAvatar assetId={l.assetId} size={18} />
          <span className={`tx-net-amt ${l.direction === "in" ? "pos" : "neg"}`}>
            {l.direction === "in" ? "+" : "−"}
            <TokenAmount assetId={l.assetId} raw={l.amount} />
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Local activity log for the connected wallet — every tx this browser
 * submitted (create / take / partial / cancel), newest first, with a one-line
 * in/out summary and a link to the on-chain transaction. Purely a convenience
 * trail (see lib/history.ts); the chain remains the source of truth.
 */
export function TxHistory() {
  const { stakeCredential } = useOwnerCredential();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  const refresh = useCallback(() => {
    setEntries(historyForOwner(stakeCredential));
  }, [stakeCredential]);

  useEffect(() => {
    refresh();
    // Same-tab writes fire HISTORY_EVENT; other tabs fire the native storage event.
    window.addEventListener(HISTORY_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(HISTORY_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  return (
    <section style={{ marginTop: "2.2rem" }}>
      <div
        className="page-title"
        style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "1rem" }}
      >
        <h2>History</h2>
        {entries.length > 0 && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              clearHistory(stakeCredential);
            }}
            title="Remove this wallet's activity from this browser (does not affect the chain)"
          >
            Clear
          </button>
        )}
      </div>

      <div className="panel">
        {entries.length === 0 ? (
          <p className="muted">
            No transactions yet from this browser. Orders you create, take, or
            cancel here will appear in this list.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>In / out</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.txHash}>
                  <td className="muted" title={new Date(e.timestamp).toLocaleString()}>
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td>
                    <span className="tx-badge tx-badge-action">
                      {ACTION_LABEL[e.summary.action]}
                    </span>
                  </td>
                  <td>
                    <FlowCell summary={e.summary} />
                  </td>
                  <td className="mono muted" title={e.txHash}>
                    {shortId(e.txHash, 6)}{" "}
                    <ExplorerLink txHash={e.txHash} className="linklike">
                      ↗
                    </ExplorerLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small">
        Stored only in this browser (not on any server) and shown for the
        connected wallet. Amounts are what moved to or from your wallet;
        network fees are not included.
      </p>
    </section>
  );
}
