"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ArbitrageOpportunity, ArbitrageScan } from "@/lib/types";
import { shortId } from "@/lib/validate";
import { useTxFlow } from "@/hooks/useTxFlow";
import { Callout } from "./Callout";
import { TokenAmount, TokenAvatar, TokenTicker } from "./Token";
import { TransactionPreview } from "./TransactionPreview";
import { TxStatus } from "./TxStatus";

/**
 * Arbitrage scanner (docs/arbitrage.md): riskless profit cycles over the open
 * book, each settled as ONE atomic TakeManyOrders tx. Execution reuses the
 * standard build -> preview -> sign flow — the cycle funds itself, so the
 * wallet only covers the fee (+ min-ADA on partial legs). If someone takes a
 * leg first, the whole tx fails and no funds move.
 */

/** Signed raw lovelace rendered with the token formatter (handles the "−"). */
function SignedAda({ raw }: { raw: string }) {
  const v = BigInt(raw);
  const neg = v < 0n;
  return (
    <span className={`tx-net-amt ${neg ? "neg" : "pos"}`}>
      {neg ? "−" : "+"}
      <TokenAmount assetId="lovelace" raw={(neg ? -v : v).toString()} />
    </span>
  );
}

function CyclePath({ cycle }: { cycle: string[] }) {
  return (
    <span className="arb-cycle">
      {[...cycle, cycle[0]!].map((asset, i) => (
        <span key={i} className="arb-cycle-hop">
          {i > 0 && <span className="muted"> → </span>}
          <TokenAvatar assetId={asset} size={20} />
          <TokenTicker assetId={asset} />
        </span>
      ))}
    </span>
  );
}

function OpportunityCard({
  opp,
  onExecute,
  busy,
  connected,
}: {
  opp: ArbitrageOpportunity;
  onExecute: (opp: ArbitrageOpportunity) => void;
  busy: boolean;
  connected: boolean;
}) {
  return (
    <div className="card arb-card">
      <div className="arb-head">
        <CyclePath cycle={opp.cycle} />
        <span className="badge">
          {opp.kind === "direct" ? "crossed pair" : "triangle"}
        </span>
        <span className="arb-margin pos-status pos-status-open">
          +{opp.marginPct}%
        </span>
      </div>

      <div className="arb-profit">
        <span className="muted small">You pocket (gross)</span>
        {opp.net.map((n) => (
          <span key={n.assetId} className="tx-net-amt pos">
            +<TokenAmount assetId={n.assetId} raw={n.amount} />
          </span>
        ))}
      </div>

      <div className="arb-costs muted small">
        Costs: ~<TokenAmount assetId="lovelace" raw={opp.estimatedFeeLovelace} />{" "}
        fee (estimate — the preview shows the real fee)
        {BigInt(opp.partialMinAdaLovelace) > 0n && (
          <>
            {" "}
            + <TokenAmount assetId="lovelace" raw={opp.partialMinAdaLovelace} />{" "}
            min-ADA on partial legs
          </>
        )}
        {" · "}ADA line after costs: <SignedAda raw={opp.lovelaceNetAfterCosts} />
      </div>

      <details className="arb-legs">
        <summary className="muted small">
          {opp.legs.length} orders taken atomically in one transaction
        </summary>
        <ul className="small">
          {opp.legs.map((l) => (
            <li key={l.orderId}>
              <code>{shortId(l.orderId)}</code>: pay{" "}
              <TokenAmount assetId={l.payAsset} raw={l.payAmount} /> → receive{" "}
              <TokenAmount assetId={l.receiveAsset} raw={l.receiveAmount} />
              {l.partial && (
                <span className="pos-status pos-status-partial"> (partial fill)</span>
              )}
            </li>
          ))}
        </ul>
      </details>

      {opp.expiresAt !== undefined && (
        <p className="muted small">
          A leg expires {new Date(opp.expiresAt).toLocaleString()} — execute
          before then.
        </p>
      )}

      <button
        className="btn btn-primary"
        disabled={busy || !connected}
        onClick={() => onExecute(opp)}
        title={connected ? undefined : "Connect a wallet to execute"}
      >
        {connected ? "Execute atomically" : "Connect a wallet to execute"}
      </button>
    </div>
  );
}

export function ArbitragePanel() {
  const [scan, setScan] = useState<ArbitrageScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const flow = useTxFlow();

  const refresh = useCallback(() => {
    api
      .arbitrage()
      .then((s) => {
        setScan(s);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  // Like OrderBook's hardRefresh: the backend doesn't poll the chain on its
  // own — this pulls fresh on-chain state (server-side cooldown), then rescans.
  const hardRefresh = useCallback(async () => {
    setResyncing(true);
    try {
      await api.reindex();
    } catch {
      /* cooldown/no-provider — the rescan below still uses the cache */
    } finally {
      setResyncing(false);
      refresh();
    }
  }, [refresh]);

  const execute = useCallback(
    (opp: ArbitrageOpportunity) =>
      void flow.build((wallet) =>
        api.buildTakeManyOrders({
          wallet,
          orders: opp.legs.map((l) => ({
            orderId: l.orderId,
            ...(l.takeAmount !== undefined ? { takeAmount: l.takeAmount } : {}),
          })),
        })
      ),
    [flow]
  );

  if (flow.state.step === "submitted") {
    return (
      <div className="panel tx-flow-host">
        <TxStatus
          txHash={flow.state.txHash}
          onSettled={() => {
            refresh();
            flow.reset();
          }}
          onDismiss={() => {
            refresh();
            flow.reset();
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
          onReject={flow.reject}
          busy={flow.state.step === "signing"}
        />
      </div>
    );
  }

  const busy = flow.state.step === "building";

  return (
    <>
      <Callout label="HOW IT WORKS" tone="info">
        When open orders' prices cross — directly or around a triangle of
        pairs — taking them all in <strong>one atomic transaction</strong>{" "}
        yields a riskless profit: the assets released by one order pay the
        next order's ask inside the same transaction, so your wallet fronts
        nothing but the network fee. Either every leg fills, or nothing moves.
      </Callout>

      {error && <p className="warn">{error}</p>}
      {flow.state.step === "error" && (
        <p className="warn">Failed: {flow.state.message}</p>
      )}

      <div className="arb-toolbar">
        <span className="muted small">
          {scan
            ? `Scanned ${scan.scannedOrders} open orders across ${scan.pairCount} pair${scan.pairCount === 1 ? "" : "s"}.`
            : "Scanning the open book…"}
        </span>
        <button
          className="btn btn-ghost"
          onClick={() => void hardRefresh()}
          disabled={resyncing}
          title="Pull the latest on-chain state, then rescan"
        >
          {resyncing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {scan && scan.opportunities.length === 0 && (
        <p className="muted">
          No riskless cycles right now — the book's prices don't cross, or the
          crossing orders' amounts can't chain (sellers didn't allow partial
          fills). Check back after the book moves.
        </p>
      )}

      <div className="market-grid">
        {scan?.opportunities.map((opp) => (
          <OpportunityCard
            key={opp.id}
            opp={opp}
            onExecute={execute}
            busy={busy}
            connected={flow.connected}
          />
        ))}
      </div>

      <p className="muted small" style={{ marginTop: "1rem" }}>
        The order book is a cache — if someone takes a leg first, your
        transaction fails <em>whole</em> and no funds move. Profits shown are
        gross raw-unit nets; the transaction preview lists every seller
        payment before you sign.
      </p>
    </>
  );
}
