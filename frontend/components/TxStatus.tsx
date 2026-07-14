"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { shortId } from "@/lib/validate";
import { ExplorerLink } from "./ExplorerLink";

/**
 * Success state after a submit: a green check badge, a live confirmation
 * status, and a link to the transaction on Cardanoscan. Polls the backend for
 * confirmations (the indexer needs a couple before the order cache updates)
 * and auto-dismisses via `onSettled` once settled.
 *
 * `onDismiss` (optional) lets the user leave immediately instead of waiting
 * out the confirmation poll — the tx was already submitted and recorded to
 * local history; this component unmounting doesn't stop it confirming, it
 * just stops watching. Callers that chain a NEXT signed transaction off of
 * this one settling (batch/queue flows) should only offer `onDismiss` when
 * leaving early is safe (i.e. it won't skip a required on-chain-state wait —
 * abandoning a queue is fine, racing ahead of confirmation is not).
 */
export function TxStatus({
  txHash,
  onSettled,
  onDismiss,
  dismissLabel = "Back to Trade",
  note,
}: {
  txHash: string;
  onSettled?: () => void;
  onDismiss?: () => void;
  dismissLabel?: string;
  note?: React.ReactNode;
}) {
  const [confirmations, setConfirmations] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await api.txStatus(txHash);
        if (stop) return;
        setConfirmations(res.found ? res.confirmations : 0);
        if (res.found && res.confirmations >= 2) {
          onSettled?.();
          return; // settled — stop polling
        }
      } catch (e) {
        if (!stop) setError(String(e));
      }
      if (!stop) setTimeout(poll, 10_000);
    };
    poll();
    return () => {
      stop = true;
    };
  }, [txHash, onSettled]);

  const settled = confirmations !== null && confirmations >= 2;
  const status = settled
    ? "Confirmed on-chain"
    : confirmations === null
      ? "Checking…"
      : confirmations === 0
        ? "Waiting for a block…"
        : `${confirmations} confirmation${confirmations === 1 ? "" : "s"}`;

  return (
    <div className="tx-success">
      <div className="tx-success-badge" aria-hidden>
        <svg viewBox="0 0 72 72" width="88" height="88">
          <circle className="tx-ring" cx="36" cy="36" r="34" />
          <circle className="tx-disc" cx="36" cy="36" r="27" />
          <path className="tx-tick" d="M24 37.5 l8.5 8.5 l16 -18" />
        </svg>
      </div>

      <h3 className="tx-success-title">Transaction submitted</h3>
      <p className="tx-success-status">
        <span className={settled ? "tx-status-dot ok" : "tx-status-dot"} />
        {status}
      </p>

      <div className="tx-success-hash mono">{shortId(txHash, 10)}</div>
      <ExplorerLink txHash={txHash} className="btn btn-ghost tx-success-link">
        View on Cardanoscan ↗
      </ExplorerLink>

      {settled && (
        <p className="muted small tx-success-note">
          The order book will reflect this within one indexer pass.
        </p>
      )}
      {error && <p className="warn tx-success-note">status check failed: {error}</p>}

      {onDismiss && (
        <>
          {note && <p className="muted small tx-success-note">{note}</p>}
          <button
            type="button"
            className="btn btn-primary tx-success-link"
            style={{ marginTop: ".6rem" }}
            onClick={onDismiss}
          >
            {dismissLabel}
          </button>
        </>
      )}
    </div>
  );
}
