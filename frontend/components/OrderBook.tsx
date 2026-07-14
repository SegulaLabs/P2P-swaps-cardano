"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  offeredAssetId,
  requestedAssetId,
  type Order,
  type Orderbook,
} from "@/lib/types";
import { shortId } from "@/lib/validate";
import { clampTake, requiredPayment } from "@/lib/pricing";
import { decimalsOf, fromRawAmount, tickerOf, toRawAmount } from "@/lib/tokens";
import { useAssetInfo } from "@/hooks/useAssetInfo";
import { useTxFlow } from "@/hooks/useTxFlow";
import { ExplorerLink } from "./ExplorerLink";
import { TokenAmount, TokenAvatar } from "./Token";
import { TransactionPreview } from "./TransactionPreview";
import { TxStatus } from "./TxStatus";

/** Compact expiry for the narrow "Expires" column: short date + short time,
 *  no seconds/timezone (the full timestamp is in the cell's title tooltip). */
function formatExpiry(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/**
 * Inline editor for a v3 partial take: enter how much of the offered asset
 * to take; the ask owed is ceil(take * ask / offer) — same formula the
 * validator enforces (docs/partial-fills.md §1).
 */
function PartialTakeEditor({
  order,
  busy,
  onTake,
  onClose,
}: {
  order: Order;
  busy: boolean;
  onTake: (takeAmount: bigint) => void;
  onClose: () => void;
}) {
  const offered = offeredAssetId(order);
  const requested = requestedAssetId(order);
  const offeredInfo = useAssetInfo(offered);
  const requestedInfo = useAssetInfo(requested);
  const offeredDecimals = decimalsOf(offeredInfo, offered);
  const [input, setInput] = useState("");

  const parsed = useMemo(() => {
    const offerAmount = BigInt(order.offeredAmount);
    const askAmount = BigInt(order.requestedAmount);
    if (input.trim() === "") return { take: null as bigint | null, error: null };
    try {
      const raw = toRawAmount(input, offeredDecimals);
      const clamped = clampTake(raw, askAmount, offerAmount);
      if (clamped === 0n)
        return { take: null, error: "order too small to fill partially" };
      if (raw >= offerAmount)
        return {
          take: null,
          error: "that's the whole order — use Take (it also returns the seller's deposit)",
        };
      if (clamped !== raw)
        return {
          take: null,
          error: `must be between ${fromRawAmount(1n, offeredDecimals)} and ${fromRawAmount(clamped, offeredDecimals)}`,
        };
      return { take: raw, error: null };
    } catch (e) {
      return { take: null, error: (e as Error).message };
    }
  }, [input, offeredDecimals, order.offeredAmount, order.requestedAmount]);

  const youPay =
    parsed.take !== null
      ? requiredPayment(
          parsed.take,
          BigInt(order.requestedAmount),
          BigInt(order.offeredAmount)
        )
      : null;

  return (
    <div className="partial-editor">
      <div className="partial-editor-fields">
        <label htmlFor={`partial-${order.orderId}`}>
          Take ({tickerOf(offeredInfo, offered)})
        </label>
        <input
          id={`partial-${order.orderId}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`< ${fromRawAmount(BigInt(order.offeredAmount), offeredDecimals)}`}
          inputMode="decimal"
          style={{ width: "10em" }}
        />
      </div>
      {/* Fixed-height slot so the message can appear/change without nudging the
          buttons. Empty until the input yields a payment or an error. */}
      <div className="muted small partial-editor-msg" aria-live="polite">
        {parsed.error
          ? parsed.error
          : youPay !== null
            ? <>you pay <TokenAmount assetId={requested} raw={youPay.toString()} /> {requested !== "lovelace" && "(+ ~1.4 tADA min-ADA to the seller)"}</>
            : null}
      </div>
      <div className="partial-editor-actions">
        <button
          className="btn btn-primary"
          disabled={busy || parsed.take === null}
          onClick={() => parsed.take !== null && onTake(parsed.take)}
        >
          {busy ? "Building…" : "Take partially"}
        </button>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Expandable table row that animates BOTH opening and closing via a CSS
 * grid-rows transition (0fr <-> 1fr). React would unmount the row instantly on
 * close, killing the exit animation, so we keep it mounted: we expand a frame
 * after mounting, and on close we collapse first and only unmount once the
 * transition ends. No animation library needed.
 */
function PartialRow({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Expand on the next frame so the 0fr -> 1fr transition actually runs.
      const id = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(id);
    }
    setExpanded(false); // collapse; unmount happens on transitionend below
  }, [open]);

  if (!mounted) return null;
  return (
    <tr className="partial-row">
      <td colSpan={5}>
        <div
          className={`partial-drawer${expanded ? " open" : ""}`}
          onTransitionEnd={(e) => {
            if (e.propertyName === "grid-template-rows" && !open) setMounted(false);
          }}
        >
          <div className="partial-drawer-inner">{children}</div>
        </div>
      </td>
    </tr>
  );
}

/**
 * Order book for one pair. Rows are individual on-chain UTxOs — two takers
 * can race for the same one; the loser's tx fails harmlessly (no funds move)
 * and the book is refetched (docs/eutxo.md §1). v3: orders whose maker opted
 * in may be PARTIALLY filled; everything else is full-fill only.
 */
export function OrderBook({ pairId }: { pairId: string }) {
  const [book, setBook] = useState<Orderbook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Order | null>(null);
  const [partialFor, setPartialFor] = useState<Order | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const flow = useTxFlow();

  const refresh = useCallback(() => {
    api
      .orderbook(pairId)
      .then(setBook)
      .catch((e) => setError(String(e)));
  }, [pairId]);

  useEffect(refresh, [refresh]);

  // The backend does NOT poll the chain continuously (it sits idle 24/7) —
  // this is what actually pulls fresh on-chain state; the server debounces
  // rapid clicks itself (INDEXER_MIN_REINDEX_INTERVAL_MS).
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

  function take(order: Order, takeAmount?: bigint) {
    setSelected(order);
    void flow.build((wallet) =>
      api.buildTakeOrder({
        wallet,
        orderId: order.orderId,
        ...(takeAmount !== undefined ? { takeAmount: takeAmount.toString() } : {}),
      })
    );
  }

  if (flow.state.step === "submitted") {
    return (
      <div className="panel tx-flow-host">
        <TxStatus
          txHash={flow.state.txHash}
          onSettled={() => {
            flow.reset();
            setSelected(null);
            refresh();
          }}
        />
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
            flow.reject();
            setSelected(null);
          }}
          busy={flow.state.step === "signing"}
        />
      </div>
    );
  }

  if (error) return <p className="warn">order book unavailable: {error}</p>;
  if (!book) return <p className="muted">loading…</p>;

  // The backend already excludes expired orders from the book; re-filter here
  // so a row can't linger takeable between refreshes once its expiry passes
  // (the validator would reject the take anyway — this avoids a doomed build).
  const notExpired = (o: Order) =>
    o.expiration === undefined || o.expiration > Date.now();
  const rows = [...book.bids, ...book.asks].filter(notExpired);

  return (
    <>
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
      <div className="panel">
        {rows.length === 0 ? (
          <p className="muted">No open orders on this pair.</p>
        ) : (
          <table className="ob-table">
            {/* Fixed layout so the full-width partial-fill editor row can never
                reflow the columns — widths stay put whether it's open or not. */}
            <colgroup>
              <col className="ob-col-pay" />
              <col className="ob-col-recv" />
              <col className="ob-col-exp" />
              <col className="ob-col-order" />
              <col className="ob-col-act" />
            </colgroup>
            <thead>
              <tr>
                <th>You pay</th>
                <th>You receive</th>
                <th>Expires</th>
                <th>Order</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const offered = offeredAssetId(o);
                const requested = requestedAssetId(o);
                const partialOpen = partialFor?.orderId === o.orderId;
                return (
                  <Fragment key={o.orderId}>
                  <tr className={partialOpen ? "has-editor" : undefined}>
                    {/* From the TAKER's perspective: pay the ask, receive the offer. */}
                    <td>
                      <TokenAvatar assetId={requested} size={20} />{" "}
                      <TokenAmount assetId={requested} raw={o.requestedAmount} />
                    </td>
                    <td>
                      <TokenAvatar assetId={offered} size={20} />{" "}
                      <TokenAmount assetId={offered} raw={o.offeredAmount} />
                    </td>
                    <td className="muted small">
                      {o.expiration ? (
                        <time
                          dateTime={new Date(o.expiration).toISOString()}
                          title={new Date(o.expiration).toLocaleString()}
                        >
                          {formatExpiry(o.expiration)}
                        </time>
                      ) : (
                        "never"
                      )}
                    </td>
                    <td className="mono muted" title={o.orderId}>
                      {shortId(o.orderId, 6)}{" "}
                      <ExplorerLink txHash={o.txHash} className="linklike">
                        ↗
                      </ExplorerLink>
                      {o.allowPartialFill && (
                        <>
                          {" "}
                          <span
                            className="small"
                            title="The maker allows partial fills: take any fraction at the same price"
                          >
                            ◐ partial
                          </span>
                        </>
                      )}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {o.allowPartialFill && (
                        <button
                          className={`btn btn-ghost${partialOpen ? " is-active" : ""}`}
                          onClick={() =>
                            setPartialFor(partialOpen ? null : o)
                          }
                          aria-expanded={partialOpen}
                          disabled={
                            !flow.connected || flow.state.step === "building"
                          }
                          title="Take only part of this order"
                        >
                          Partial
                        </button>
                      )}{" "}
                      <button
                        className="btn btn-primary"
                        onClick={() => take(o)}
                        disabled={!flow.connected || flow.state.step === "building"}
                        title={
                          flow.connected
                            ? "Build the take transaction (full fill)"
                            : "Connect a wallet first"
                        }
                      >
                        {/* When the partial editor is open, its own button
                            shows the building state — don't duplicate it here. */}
                        {flow.state.step === "building" &&
                        selected?.orderId === o.orderId &&
                        !partialOpen
                          ? "Building…"
                          : "Take"}
                      </button>
                    </td>
                  </tr>
                  <PartialRow open={partialOpen}>
                    <PartialTakeEditor
                      order={o}
                      busy={
                        flow.state.step === "building" &&
                        selected?.orderId === o.orderId
                      }
                      onTake={(takeAmount) => take(o, takeAmount)}
                      onClose={() => setPartialFor(null)}
                    />
                  </PartialRow>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small">
        {book.syncedToSlot !== undefined &&
          `Indexer synced to slot ${book.syncedToSlot}. `}
        Taking an order in full pays the maker exactly their asking amount
        (plus returning their deposit). Orders marked ◐ also accept partial
        fills at the same price — the remainder stays on the book.
      </p>
    </>
  );
}
