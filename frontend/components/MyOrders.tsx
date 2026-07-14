"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  offeredAssetId,
  requestedAssetId,
  type Order,
} from "@/lib/types";
import {
  fillEvents,
  groupPositions,
  positionStatus,
  type Position,
} from "@/lib/positions";
import { shortId } from "@/lib/validate";
import { useOwnerCredential } from "@/hooks/useOwnerCredential";
import { useTxFlow } from "@/hooks/useTxFlow";
import { ExplorerLink } from "./ExplorerLink";
import { TokenAmount, TokenAvatar } from "./Token";
import { TransactionPreview } from "./TransactionPreview";
import { TxStatus } from "./TxStatus";

/**
 * The connected wallet's orders, keyed by its staking credential (the
 * protocol's owner identity). Cancel only — UpdateOrder is postponed
 * post-MVP (mvp-contract-decisions.md §7): cancel and recreate instead.
 *
 * Expired orders (unfillable — takers are locked out by the validator's
 * validity-bound rule) surface in a claim bar: a claim IS a cancel tx, and the
 * contract allows only ONE order input per cancel (order_rules.ak
 * only_one_order_input), so "claim all" is a QUEUE of one-signature txs
 * processed back to back, not a single batch tx.
 */
export function MyOrders() {
  const { stakeCredential } = useOwnerCredential();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const flow = useTxFlow();

  // Claim queue + selection. Selection is stored as DE-selections so that a
  // refresh (or a newly-expiring order) defaults to "claim it" without
  // re-checking boxes the user explicitly unticked.
  const [claimQueue, setClaimQueue] = useState<string[]>([]);
  const [deselected, setDeselected] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    if (!stakeCredential) return;
    api
      .ordersByOwner(stakeCredential)
      .then((r) => setOrders(r.orders))
      .catch((e) => setError(String(e)));
  }, [stakeCredential]);

  useEffect(refresh, [refresh]);

  const buildClaim = useCallback(
    (orderId: string) =>
      void flow.build((wallet) => api.buildCancelOrder({ wallet, orderId })),
    [flow]
  );

  /** Start (or continue) the claim queue: build the first, keep the rest. */
  const claimAll = useCallback(
    (orderIds: string[]) => {
      const [next, ...rest] = orderIds;
      if (!next) return;
      setClaimQueue(rest);
      buildClaim(next);
    },
    [buildClaim]
  );

  // A failed/rejected claim aborts the rest of the queue — never keep
  // auto-building txs past an error the user hasn't seen.
  useEffect(() => {
    if (flow.state.step === "error") setClaimQueue([]);
  }, [flow.state.step]);

  // See OrderBook's hardRefresh: the backend doesn't poll the chain on its
  // own, so this is what actually pulls fresh state (server-side cooldown).
  const hardRefresh = useCallback(async () => {
    setResyncing(true);
    try {
      await api.reindex();
    } catch (e) {
      setError(String(e));
    } finally {
      setResyncing(false);
      refresh();
    }
  }, [refresh]);

  if (!stakeCredential) {
    return (
      <p className="warn">
        Connect a preprod wallet (with a staking credential) to see your orders.
      </p>
    );
  }

  if (flow.state.step === "submitted") {
    return (
      <div className="panel tx-flow-host">
        <TxStatus
          txHash={flow.state.txHash}
          onSettled={() => {
            refresh();
            // Auto-advance the claim queue: the next claim starts building as
            // soon as this one confirms (each still needs its own signature).
            if (claimQueue.length > 0) claimAll(claimQueue);
            else flow.reset();
          }}
          // Leaving early only ever ABANDONS the rest of the queue (never
          // builds ahead of confirmation) — safe regardless of queue state.
          onDismiss={() => {
            refresh();
            setClaimQueue([]);
            flow.reset();
          }}
          dismissLabel={claimQueue.length > 0 ? "Stop here" : "Done"}
          note={
            claimQueue.length > 0
              ? `${claimQueue.length} more claim${claimQueue.length > 1 ? "s" : ""} ` +
                `won't be sent — they stay claimable, come back any time.`
              : undefined
          }
        />
        {claimQueue.length > 0 && (
          <p className="muted small">
            {claimQueue.length} more claim{claimQueue.length > 1 ? "s" : ""}{" "}
            queued — the next one starts automatically once this confirms.
          </p>
        )}
      </div>
    );
  }
  if (flow.state.step === "preview" || flow.state.step === "signing") {
    return (
      <div className="panel tx-flow-host">
        <TransactionPreview
          tx={flow.state.tx}
          onConfirm={flow.confirmAndSign}
          onReject={() => {
            setClaimQueue([]); // backing out aborts the whole queue
            flow.reject();
          }}
          busy={flow.state.step === "signing"}
        />
        {claimQueue.length > 0 && (
          <p className="muted small">
            {claimQueue.length} more claim{claimQueue.length > 1 ? "s" : ""}{" "}
            queued after this one. Rejecting stops the queue.
          </p>
        )}
      </div>
    );
  }

  const positions = orders ? groupPositions(orders) : [];
  const now = Date.now();
  const expiredTips = positions
    .filter((p) => positionStatus(p, now).expired)
    .map((p) => p.tip.orderId);
  const selectedTips = expiredTips.filter((id) => !deselected.has(id));

  return (
    <>
      {error && <p className="warn">{error}</p>}
      {flow.state.step === "error" && (
        <p className="warn">Failed: {flow.state.message}</p>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          className="btn btn-ghost"
          onClick={() => void hardRefresh()}
          disabled={resyncing}
          title="Pull the latest on-chain state (the site doesn't do this automatically)"
        >
          {resyncing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {expiredTips.length > 0 && (
        <div className="claim-bar">
          <div className="claim-bar-text">
            <span className="pos-status pos-status-expired">
              {expiredTips.length} expired order
              {expiredTips.length > 1 ? "s" : ""}
            </span>{" "}
            <span className="muted">
              — no longer takeable; the locked funds and deposits are yours to
              claim. Tick the ones to claim below.
            </span>
            {expiredTips.length > 1 && (
              <span className="muted small">
                {" "}
                Each claim is its own transaction (one signature each) — the
                contract allows one cancel per tx; they run back to back.
              </span>
            )}
          </div>
          <button
            className="btn btn-primary"
            onClick={() => claimAll(selectedTips)}
            disabled={selectedTips.length === 0 || flow.state.step === "building"}
          >
            Claim selected ({selectedTips.length})
            {selectedTips.length > 1 ? ` · ${selectedTips.length} txs` : ""}
          </button>
        </div>
      )}
      <div className="panel">
        {orders === null ? (
          <p className="muted">loading…</p>
        ) : orders.length === 0 ? (
          <p className="muted">No orders for this staking credential yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th />
                <th>Selling</th>
                <th>Asking</th>
                <th>Status</th>
                <th>Order</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <PositionRow
                  key={p.rootId}
                  position={p}
                  now={now}
                  building={flow.state.step === "building"}
                  onCancel={buildClaim}
                  selected={!deselected.has(p.tip.orderId)}
                  onToggleSelect={(orderId) =>
                    setDeselected((prev) => {
                      const next = new Set(prev);
                      if (next.has(orderId)) next.delete(orderId);
                      else next.add(orderId);
                      return next;
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small">
        Each row is one order (a position). When a taker buys part of a
        partial-fill order (◐), the same row stays put and its remaining amount
        shrinks — expand it to see the individual fills. Your deposit stays
        locked with the remainder and returns on the final fill, cancel, or
        claim. Expired orders leave the public book automatically but their
        funds stay locked until you claim them. To change an order&apos;s price
        or expiry, cancel it and place a new one (updating in place is
        deliberately not supported in the MVP).
      </p>
    </>
  );
}

/**
 * One position — the collapsed lineage of an order that may have been partially
 * filled. Shows remaining/original amounts and, when there are fills, an
 * expandable history. Cancel acts on the live tip.
 */
function PositionRow({
  position,
  now,
  building,
  onCancel,
  selected,
  onToggleSelect,
}: {
  position: Position;
  now: number;
  building: boolean;
  onCancel: (orderId: string) => void;
  /** Expired rows only: ticked for inclusion in "Claim selected". */
  selected: boolean;
  onToggleSelect: (orderId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { original, tip } = position;
  const offered = offeredAssetId(tip);
  const requested = requestedAssetId(tip);
  const st = positionStatus(position, now);
  const fills = fillEvents(position);
  const partiallyFilled = st.filledFraction > 0 && st.filledFraction < 1;
  const pct = Math.round(st.filledFraction * 100);

  return (
    <>
      <tr>
        <td style={{ width: "2.4rem", whiteSpace: "nowrap" }}>
          {st.expired && (
            <input
              type="checkbox"
              className="claim-check"
              checked={selected}
              onChange={() => onToggleSelect(tip.orderId)}
              title="Include in “Claim selected”"
              aria-label="Include in claim"
            />
          )}
          {fills.length > 0 ? (
            <button
              type="button"
              className="pos-toggle"
              aria-expanded={open}
              aria-label={open ? "Hide fills" : "Show fills"}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "▾" : "▸"}
            </button>
          ) : null}
        </td>
        <td>
          <TokenAvatar assetId={offered} size={20} />{" "}
          <TokenAmount assetId={offered} raw={tip.offeredAmount} />
          {partiallyFilled && (
            <span className="muted small">
              {" "}
              / <TokenAmount assetId={offered} raw={original.offeredAmount} />
            </span>
          )}
        </td>
        <td>
          <TokenAvatar assetId={requested} size={20} />{" "}
          <TokenAmount assetId={requested} raw={tip.requestedAmount} />
          {partiallyFilled && (
            <span className="muted small">
              {" "}
              / <TokenAmount assetId={requested} raw={original.requestedAmount} />
            </span>
          )}
        </td>
        <td>
          <span
            className={`pos-status pos-status-${st.tone}`}
            title={
              st.expired && tip.expiration
                ? `Expired ${new Date(tip.expiration).toLocaleString()} — takers can no longer fill it; claim returns the funds + deposit.`
                : undefined
            }
          >
            {st.label}
          </span>
          {partiallyFilled && pct > 0 && (
            <span className="muted small"> · {pct}% filled</span>
          )}
          {st.expired && (
            <span className="muted small"> · claim your funds</span>
          )}
        </td>
        <td className="mono muted" title={tip.orderId}>
          {shortId(tip.orderId, 6)}{" "}
          <ExplorerLink txHash={tip.txHash} className="linklike">
            ↗
          </ExplorerLink>
          {tip.allowPartialFill && st.canCancel && !st.expired && (
            <span
              className="small"
              title="Partial fills enabled: takers may fill any fraction at your price"
            >
              {" "}
              ◐
            </span>
          )}
        </td>
        <td style={{ textAlign: "right" }}>
          {st.canCancel && (
            <button
              className="btn btn-ghost"
              onClick={() => onCancel(tip.orderId)}
              disabled={building}
              title={
                st.expired
                  ? "Reclaim the locked funds and deposit (an on-chain cancel)"
                  : undefined
              }
            >
              {st.expired ? "Claim" : "Cancel"}
            </button>
          )}
          {/* No Update button: UpdateOrder is postponed post-MVP —
              cancel and recreate (mvp-contract-decisions.md §7). */}
        </td>
      </tr>
      {open && fills.length > 0 && (
        <tr className="pos-fills-row">
          <td />
          <td colSpan={5}>
            <div className="pos-fills">
              <div className="muted small pos-fills-head">Fills</div>
              {fills.map((f, i) => (
                <div key={i} className="pos-fill">
                  {f.kind === "cancel" ? (
                    <span className="muted">Cancelled — remainder returned to you.</span>
                  ) : (
                    <>
                      <span>
                        Sold <TokenAmount assetId={offered} raw={f.soldOffered} />
                        {" "}for{" "}
                        <TokenAmount assetId={requested} raw={f.receivedAsk} />
                      </span>
                      {f.kind === "final" && (
                        <span className="muted small"> · final fill</span>
                      )}
                      {f.txHash && (
                        <ExplorerLink txHash={f.txHash} className="linklike">
                          {" "}
                          ↗
                        </ExplorerLink>
                      )}
                    </>
                  )}
                </div>
              ))}
              {st.canCancel && partiallyFilled && (
                <div className="muted small">
                  {st.expired ? (
                    <>
                      Remainder expired — no longer takeable; claim it as{" "}
                      <span className="mono">{shortId(tip.orderId, 6)}</span>.
                    </>
                  ) : (
                    <>
                      Remainder resting on the book as{" "}
                      <span className="mono">{shortId(tip.orderId, 6)}</span>.
                    </>
                  )}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
