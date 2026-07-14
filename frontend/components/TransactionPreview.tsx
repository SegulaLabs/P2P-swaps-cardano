"use client";

import { useMemo, useState } from "react";
import { Transaction } from "@meshsdk/core-cst";
import type { TxSummary, UnsignedTxResponse } from "@/lib/types";
import { shortId } from "@/lib/validate";
import { TokenAmount, TokenAvatar } from "./Token";

/** The exact network fee, decoded straight from the unsigned tx CBOR (Cardano
 *  fees are fixed at build time). Returns null if the CBOR can't be parsed. */
function decodeFeeLovelace(cborHex: string): string | null {
  try {
    return Transaction.fromCbor(cborHex as never).body().fee().toString();
  } catch {
    return null;
  }
}

/**
 * Wallet-style review of what the user is about to sign, BEFORE the wallet
 * prompt. Leads with the NET effect (what you pay / what you receive, signed
 * like a wallet) and tucks the per-order breakdown, deposit, beacons and
 * addresses into a collapsible "Details" dropdown. Warnings are never hidden.
 *
 * REMAINING TRUST GAP (shown to the user): this renders the backend-provided
 * summary; independent client-side decoding of the tx CBOR is not implemented
 * yet, so the wallet's own display is the second check — users must read it.
 */

const ACTION_LABEL: Record<TxSummary["action"], string> = {
  "create-order": "Create order",
  "cancel-order": "Cancel order",
  "take-order": "Take order",
  "take-order-partial": "Partial fill",
  "take-many-orders": "Take orders",
};

/** A signed money row: token avatar + label + coloured signed amount. */
function NetRow({
  sign,
  label,
  assetId,
  amount,
}: {
  sign: "+" | "−";
  label: string;
  assetId: string;
  amount: string;
}) {
  return (
    <div className="tx-net-row">
      <TokenAvatar assetId={assetId} size={26} />
      <span className="tx-net-label">{label}</span>
      <span className={`tx-net-amt ${sign === "+" ? "pos" : "neg"}`}>
        {sign}
        <TokenAmount assetId={assetId} raw={amount} />
      </span>
    </div>
  );
}

export function TransactionPreview({
  tx,
  onConfirm,
  onReject,
  busy = false,
}: {
  tx: UnsignedTxResponse;
  onConfirm: () => void;
  onReject: () => void;
  busy?: boolean;
}) {
  const s = tx.summary;
  const isTake = s.action.startsWith("take");
  const isPartial =
    s.action === "take-order-partial" ||
    (s.partialFills?.length ?? 0) > 0;

  const feeLovelace = useMemo(
    () => decodeFeeLovelace(tx.unsignedTxCborHex),
    [tx.unsignedTxCborHex]
  );
  const [copied, setCopied] = useState(false);
  async function copyCbor() {
    try {
      await navigator.clipboard.writeText(tx.unsignedTxCborHex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  // NET EFFECT from the taker/maker's perspective.
  //   take*      → `takerNet`: exact signed per-asset net of the order flows
  //                (works for mixed-asset batches like arbitrage cycles);
  //                falls back to the uniform `offered`/`requested` aggregates
  //                for summaries from older backends.
  //   create     → lock `offered` (+ deposit)
  //   cancel     → receive `offered` (+ deposit back)
  const takerNet =
    isTake && s.takerNet && s.takerNet.length > 0
      ? [...s.takerNet].sort(
          (a, b) =>
            Number(a.amount.startsWith("-")) - Number(b.amount.startsWith("-"))
        )
      : null;
  const receive =
    !takerNet && (isTake || s.action === "cancel-order") ? s.offered : null;
  const pay = takerNet
    ? null
    : isTake
      ? s.requested
      : s.action === "create-order"
        ? s.offered
        : null;
  const payVerb = s.action === "create-order" ? "You lock" : "You pay";

  const orderCount =
    s.orderIds?.length ?? (s.orderId ? 1 : 0);

  return (
    <div className="card preview tx-review">
      <h3>{ACTION_LABEL[s.action]}</h3>
      <div className="tx-review-head">
        <span className="tx-badge tx-badge-action">
          {ACTION_LABEL[s.action]}
        </span>
        {isPartial && <span className="tx-badge">Partial</span>}
        {orderCount > 1 && (
          <span className="tx-badge">{orderCount} orders · atomic</span>
        )}
        <span className="tx-badge">Contract</span>
        {s.beacons?.burned && s.beacons.burned.length > 0 && (
          <span className="tx-badge tx-badge-burn">Burn</span>
        )}
        {s.beacons?.minted && s.beacons.minted.length > 0 && (
          <span className="tx-badge tx-badge-mint">Mint</span>
        )}
      </div>

      <div className="tx-net">
        {takerNet?.map((n) => {
          const negative = n.amount.startsWith("-");
          return (
            <NetRow
              key={n.assetId}
              sign={negative ? "−" : "+"}
              label={negative ? "You pay" : "You receive"}
              assetId={n.assetId}
              amount={negative ? n.amount.slice(1) : n.amount}
            />
          );
        })}
        {receive && (
          <NetRow
            sign="+"
            label="You receive"
            assetId={receive.assetId}
            amount={receive.amount}
          />
        )}
        {pay && (
          <NetRow
            sign="−"
            label={payVerb}
            assetId={pay.assetId}
            amount={pay.amount}
          />
        )}
        {s.action === "cancel-order" && s.depositLovelace && (
          <NetRow
            sign="+"
            label="Deposit returned"
            assetId="lovelace"
            amount={s.depositLovelace}
          />
        )}
        {s.action === "create-order" && s.depositLovelace && (
          <NetRow
            sign="−"
            label="Deposit (refundable)"
            assetId="lovelace"
            amount={s.depositLovelace}
          />
        )}
        {feeLovelace !== null ? (
          <NetRow
            sign="−"
            label="Network fee"
            assetId="lovelace"
            amount={feeLovelace}
          />
        ) : null}
        <p className="tx-net-fee muted small">
          {feeLovelace !== null
            ? "This is the exact network (minimum) fee for this transaction; your wallet will confirm it."
            : "+ a small network fee, shown exactly in your wallet."}
          {isPartial &&
            " Partial fills also add ~1.4 tADA min-ADA to the seller's payment when you pay a token."}
        </p>
      </div>

      <details className="tx-details">
        <summary>Details</summary>

        <dl className="tx-kv">
          <dt>Network</dt>
          <dd>{s.network}</dd>

          {s.action === "take-order" && s.depositLovelace && (
            <>
              <dt>Seller deposit</dt>
              <dd>
                <TokenAmount assetId="lovelace" raw={s.depositLovelace} />{" "}
                <span className="muted small">returned to the seller</span>
              </dd>
            </>
          )}

          {s.beacons?.minted && s.beacons.minted.length > 0 && (
            <>
              <dt>Beacons</dt>
              <dd>mints {s.beacons.minted.length} discovery tokens</dd>
            </>
          )}
          {s.beacons?.burned && s.beacons.burned.length > 0 && (
            <>
              <dt>Beacons</dt>
              <dd>burns {s.beacons.burned.length} order tokens</dd>
            </>
          )}

          {s.orderAddress && (
            <>
              <dt>Order address</dt>
              <dd className="mono" title={s.orderAddress}>
                {shortId(s.orderAddress, 10)}
              </dd>
            </>
          )}
          {s.paymentAddress && (
            <>
              <dt>Payment to</dt>
              <dd className="mono" title={s.paymentAddress}>
                {shortId(s.paymentAddress, 10)}
              </dd>
            </>
          )}
          {s.expiration != null && (
            <>
              <dt>Expires</dt>
              <dd>{new Date(s.expiration).toLocaleString()}</dd>
            </>
          )}
        </dl>

        {s.partialFills && s.partialFills.length > 0 && (
          <div>
            {s.partialFills.map((pf) => (
              <div key={pf.orderId} className="tx-leg">
                <div className="tx-leg-head">
                  <span className="tx-badge">Partial</span>
                  <span className="mono muted" title={pf.orderId}>
                    {shortId(pf.orderId, 8)}
                  </span>
                </div>
                <div className="muted">
                  You take {pf.takeAmount} · you pay {pf.paidAsk} · the
                  remainder ({pf.remainingOffer} offered / {pf.remainingAsk}{" "}
                  asked) stays on the book as a new order.
                </div>
              </div>
            ))}
          </div>
        )}

        {s.orderIds && s.orderIds.length > 0 && (
          <div className="tx-leg">
            <div className="muted small">
              Orders consumed atomically by this transaction:
            </div>
            <div className="mono muted small">
              {s.orderIds.map((id) => (
                <div key={id}>{id}</div>
              ))}
            </div>
          </div>
        )}

        <p className="muted small" style={{ marginTop: ".6rem" }}>
          {s.description}
        </p>
      </details>

      {s.warnings.length > 0 && (
        <ul className="warnings">
          {s.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      <details className="tx-details">
        <summary>Raw unsigned transaction (CBOR hex)</summary>
        <div className="cbor-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={copyCbor}>
            {copied ? "Copied ✓" : "Copy CBOR"}
          </button>
        </div>
        <code className="cbor">{tx.unsignedTxCborHex}</code>
      </details>

      <p style={{ display: "flex", gap: "0.5rem" }}>
        <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
          {busy ? "Waiting for wallet…" : "Continue to wallet"}
        </button>
        <button className="btn btn-ghost" onClick={onReject} disabled={busy}>
          Reject
        </button>
      </p>
    </div>
  );
}
