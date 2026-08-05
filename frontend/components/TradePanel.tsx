"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { validateCreateOrder } from "@/lib/validate";
import { decimalsOf, fromRawAmount, tickerOf, toRawAmount } from "@/lib/tokens";
import { flipMarketSides } from "@/lib/marketForm";
import { shortId } from "@/lib/validate";
import type { SmartFillLeg, SmartFillRoute } from "@/lib/types";
import { useAssetInfo } from "@/hooks/useAssetInfo";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { useMarketAssets } from "@/hooks/useMarketAssets";
import { useTxFlow } from "@/hooks/useTxFlow";
import { useWalletModal } from "@/components/WalletModalContext";
import { ExplorerLink } from "./ExplorerLink";
import { TokenAmount } from "./Token";
import { TokenSelect, type TokenOption } from "./TokenSelect";
import { TransactionPreview } from "./TransactionPreview";
import { TxStatus } from "./TxStatus";
import { PercentSlider } from "./PercentSlider";
import { Callout } from "./Callout";

/** Keep ~15 tADA back when maxing ADA, so fees + min-ADA never leave you short. */
const ADA_FEE_RESERVE = 15_000_000n;
/** Spendable balance: full for tokens, minus a fee reserve for ADA. */
function usableMaxRaw(balanceRaw: bigint, assetId: string): bigint {
  const r = assetId === "lovelace" ? balanceRaw - ADA_FEE_RESERVE : balanceRaw;
  return r > 0n ? r : 0n;
}
/** Human amount for `pct`% of the spendable balance. */
function pctToHuman(pct: number, balanceRaw: bigint, assetId: string, decimals: number): string {
  const max = usableMaxRaw(balanceRaw, assetId);
  return fromRawAmount((max * BigInt(Math.round(pct))) / 100n, decimals);
}
/** Reverse: what percent of the spendable balance the typed amount represents. */
function humanToPct(human: string, balanceRaw: bigint | undefined, assetId: string, decimals: number): number {
  if (balanceRaw === undefined) return 0;
  const max = usableMaxRaw(balanceRaw, assetId);
  if (max <= 0n) return 0;
  let raw: bigint;
  try {
    raw = toRawAmount(human || "0", decimals);
  } catch {
    return 0;
  }
  return Math.max(0, Math.min(100, Number((raw * 100n) / max)));
}

/**
 * Jupiter-style Market/Limit widget, used on both the home page and pair
 * pages. Market = quote + immediately fill existing orders (Smart Fill
 * routing). Limit = place a fixed-price P2P order that sits on the book
 * until someone takes it (or you cancel it).
 */

/** Form state shared by BOTH tabs (owned by TradePanel) so switching
 *  Market <-> Limit never resets the chosen tokens or typed amounts.
 *  Market reads sell/buy as spend/receive; Limit reads them as sell/ask. */
interface TradeFormState {
  sellAsset: string | null;
  buyAsset: string | null;
  sellAmount: string;
  buyAmount: string;
  setSellAsset: (v: string | null) => void;
  setBuyAsset: (v: string | null) => void;
  setSellAmount: (v: string) => void;
  setBuyAmount: (v: string) => void;
}

export function TradePanel({
  initialSellAsset,
  initialBuyAsset,
}: {
  initialSellAsset?: string;
  initialBuyAsset?: string;
}) {
  const [tab, setTab] = useState<"market" | "limit">("market");
  const { balances, refresh } = useWalletBalances();
  const marketAssets = useMarketAssets();
  const { show } = useWalletModal();

  // Shared across tabs — see TradeFormState.
  const [sellAsset, setSellAsset] = useState<string | null>(initialSellAsset ?? null);
  const [buyAsset, setBuyAsset] = useState<string | null>(initialBuyAsset ?? null);
  const [sellAmount, setSellAmount] = useState("");
  const [buyAmount, setBuyAmount] = useState("");
  const form: TradeFormState = {
    sellAsset, buyAsset, sellAmount, buyAmount,
    setSellAsset, setBuyAsset, setSellAmount, setBuyAmount,
  };

  const sellOptions: TokenOption[] = balances.map((b) => ({
    assetId: b.assetId,
    balanceRaw: b.raw,
  }));
  const buyOptions: TokenOption[] = useMemo(() => {
    const ids = new Set(marketAssets);
    for (const b of balances) ids.add(b.assetId);
    return [...ids].map((assetId) => ({ assetId }));
  }, [marketAssets, balances]);

  const tabs = (
    <div className="swap-tabs">
      <button
        type="button"
        className={`swap-tab${tab === "market" ? " swap-tab-active" : ""}`}
        onClick={() => setTab("market")}
      >
        Market
      </button>
      <button
        type="button"
        className={`swap-tab${tab === "limit" ? " swap-tab-active" : ""}`}
        onClick={() => setTab("limit")}
      >
        Limit
      </button>
    </div>
  );

  return tab === "market" ? (
    <MarketTab
      tabs={tabs}
      sellOptions={sellOptions}
      buyOptions={buyOptions}
      form={form}
      onShowConnect={show}
      onPlaceLimitInstead={() => setTab("limit")}
    />
  ) : (
    <LimitTab
      tabs={tabs}
      sellOptions={sellOptions}
      buyOptions={buyOptions}
      form={form}
      onShowConnect={show}
      onRefreshBalances={refresh}
    />
  );
}

// ---------------------------------------------------------------------------
// Market tab — Smart Fill: quote against the live order book and execute
// immediately. Legs are grouped into atomic TakeManyOrders batches (up to
// route.maxOrdersPerTx orders each); routes bigger than one batch are signed
// batch-by-batch (docs/take-many-orders.md).
// ---------------------------------------------------------------------------

function MarketTab({
  tabs,
  sellOptions,
  buyOptions,
  form,
  onShowConnect,
  onPlaceLimitInstead,
}: {
  tabs: React.ReactNode;
  sellOptions: TokenOption[];
  buyOptions: TokenOption[];
  form: TradeFormState;
  onShowConnect: () => void;
  onPlaceLimitInstead: () => void;
}) {
  const flow = useTxFlow();

  // Shared form state, read as spend/receive on this tab.
  const {
    sellAsset: spendAsset, setSellAsset: setSpendAsset,
    buyAsset: receiveAsset, setBuyAsset: setReceiveAsset,
    sellAmount: spendHuman, setSellAmount: setSpendHuman,
    buyAmount: receiveHuman, setBuyAmount: setReceiveHuman,
  } = form;

  const [edited, setEdited] = useState<"spend" | "receive">("spend");
  const [route, setRoute] = useState<SmartFillRoute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  const [queue, setQueue] = useState<SmartFillLeg[][]>([]);
  const [runIndex, setRunIndex] = useState(0);

  const spendInfo = useAssetInfo(spendAsset);
  const receiveInfo = useAssetInfo(receiveAsset);
  const spendDecimals = decimalsOf(spendInfo, spendAsset ?? "");
  const receiveDecimals = decimalsOf(receiveInfo, receiveAsset ?? "");

  const spendTicker = tickerOf(spendInfo, spendAsset ?? "");
  const receiveTicker = tickerOf(receiveInfo, receiveAsset ?? "");

  // Wallet balance of the spend token — drives the Max button + slider.
  // Shown for WHICHEVER asset is currently in the spend box, even at a 0
  // balance (e.g. right after flipping to a token you don't hold yet) —
  // hiding the whole control there looked broken rather than "you don't
  // have any of this"; Max/the slider just land on 0 in that case.
  const spendBalance = sellOptions.find((o) => o.assetId === spendAsset)?.balanceRaw ?? 0n;
  const canPickAmount = flow.connected && spendAsset !== null;
  function setSpendPct(pct: number) {
    if (spendAsset === null) return;
    setEdited("spend");
    setSpendHuman(pctToHuman(pct, spendBalance, spendAsset, spendDecimals));
  }

  const rawLimit = useMemo(() => {
    try {
      const human = edited === "spend" ? spendHuman : receiveHuman;
      const dec = edited === "spend" ? spendDecimals : receiveDecimals;
      const raw = toRawAmount(human || "0", dec);
      return raw > 0n ? raw : null;
    } catch {
      return null;
    }
  }, [edited, spendHuman, receiveHuman, spendDecimals, receiveDecimals]);

  const reqSeq = useRef(0);

  const quote = useCallback(
    async (mode: "spend" | "receive", raw: bigint) => {
      if (!spendAsset || !receiveAsset) return;
      const seq = ++reqSeq.current;
      setQuoting(true);
      setError(null);
      try {
        const r = await api.smartFill({
          spendAsset,
          receiveAsset,
          ...(mode === "spend"
            ? { maxSpend: raw.toString() }
            : { minReceive: raw.toString() }),
        });
        if (seq !== reqSeq.current) return;
        setRoute(r);
        if (r.legs.length > 0) {
          if (mode === "spend")
            setReceiveHuman(fromRawAmount(BigInt(r.totalReceive), receiveDecimals));
          else setSpendHuman(fromRawAmount(BigInt(r.totalSpend), spendDecimals));
        } else if (mode === "spend") {
          setReceiveHuman("");
        } else {
          setSpendHuman("");
        }
      } catch (e) {
        if (seq === reqSeq.current) {
          setRoute(null);
          setError(String(e));
        }
      } finally {
        if (seq === reqSeq.current) setQuoting(false);
      }
    },
    [spendAsset, receiveAsset, spendDecimals, receiveDecimals]
  );

  useEffect(() => {
    if (rawLimit === null || !spendAsset || !receiveAsset) {
      setRoute(null);
      reqSeq.current++;
      return;
    }
    const t = setTimeout(() => void quote(edited, rawLimit), 300);
    return () => clearTimeout(t);
  }, [rawLimit, edited, quote, spendAsset, receiveAsset]);

  // A batch can fail because one of its orders was already taken/cancelled
  // by someone else since the quote was planned (order_not_found — the
  // order cache is a snapshot, the chain is the truth). The banner below
  // tells the user "the quote re-plans automatically" — make that literally
  // true: hard-refresh (reindex, not just a passive re-fetch of the same
  // stale cache) and re-quote, so a retry doesn't just hit the same stale
  // order again.
  useEffect(() => {
    if (flow.state.step !== "error" || rawLimit === null) return;
    void api.reindex().finally(() => void quote(edited, rawLimit));
  }, [flow.state.step, edited, rawLimit, quote]);

  function chunk(legs: SmartFillLeg[], size: number): SmartFillLeg[][] {
    const groups: SmartFillLeg[][] = [];
    for (let i = 0; i < legs.length; i += size) groups.push(legs.slice(i, i + size));
    return groups;
  }

  function runBatch(batches: SmartFillLeg[][], index: number) {
    setQueue(batches);
    setRunIndex(index);
    void flow.build((wallet) =>
      api.buildTakeManyOrders({
        wallet,
        // v3: a route's marginal partial leg carries takeAmount through to
        // the builder; full legs omit it.
        orders: batches[index]!.map((l) => ({
          orderId: l.orderId,
          ...(l.takeAmount !== undefined ? { takeAmount: l.takeAmount } : {}),
        })),
      })
    );
  }

  function flipSides() {
    const next = flipMarketSides({ spendAsset, receiveAsset, spendHuman, receiveHuman, edited });
    setSpendAsset(next.spendAsset);
    setReceiveAsset(next.receiveAsset);
    setSpendHuman(next.spendHuman);
    setReceiveHuman(next.receiveHuman);
    setRoute(null);
  }

  if (flow.state.step === "submitted") {
    const remaining = queue.length - runIndex - 1;
    const backToTrade = () => {
      flow.reset();
      setQueue([]);
      setRunIndex(0);
      // Hard refresh before re-quoting: the DB order cache doesn't know
      // this settled tx's orders are gone until the next sync (see
      // OrderBook.tsx's hardRefresh) — quoting off the stale cache would
      // just plan another leg into an order that's already taken.
      if (rawLimit !== null) void api.reindex().finally(() => void quote(edited, rawLimit));
    };
    return (
      <div className="swap-card tx-flow-host">
        <TxStatus
          txHash={flow.state.txHash}
          onSettled={() => {
            flow.reset();
            const next = runIndex + 1;
            if (next < queue.length) {
              runBatch(queue, next);
            } else {
              setQueue([]);
              setRunIndex(0);
              if (rawLimit !== null) void api.reindex().finally(() => void quote(edited, rawLimit));
            }
          }}
          // Leaving early only ever ABANDONS remaining batches (never builds
          // ahead of confirmation) — safe regardless of queue state.
          onDismiss={backToTrade}
          dismissLabel={remaining > 0 ? "Stop here — back to Trade" : "Back to Trade"}
          note={
            remaining > 0
              ? `${remaining} more batch${remaining === 1 ? "" : "es"} in this route ` +
                `won't be executed — their orders stay open on the book.`
              : undefined
          }
        />
      </div>
    );
  }
  if (flow.state.step === "preview" || flow.state.step === "signing") {
    const batchOrders = queue[runIndex]?.length ?? 0;
    return (
      <div className="swap-card tx-flow-host">
        {queue.length > 1 && (
          <p className="muted small">
            Batch {runIndex + 1} of {queue.length} — {batchOrders} order
            {batchOrders === 1 ? "" : "s"} filled atomically in this one
            transaction. Batches are signed one at a time.
          </p>
        )}
        <TransactionPreview
          tx={flow.state.tx}
          onConfirm={flow.confirmAndSign}
          onReject={() => {
            flow.reject();
            setQueue([]);
            setRunIndex(0);
          }}
          busy={flow.state.step === "signing"}
        />
      </div>
    );
  }

  const hasRoute = route !== null && route.legs.length > 0;
  const canExecute = flow.connected && hasRoute;
  // Route came back empty. Two very different reasons, told apart by
  // candidateCount (open orders on this side of the book):
  //   noLiquidity — no market exists yet; placing a limit order opens it.
  //   tooSmall    — a market exists, but this amount can't fill a whole order
  //                 (e.g. below the cheapest price, or sub-1-unit on a 0-decimal
  //                 token). Increase the amount, or post a limit order.
  // Either way the fallback action is "place a limit order" (form carries over).
  const emptyRoute =
    route !== null && route.legs.length === 0 && rawLimit !== null && !quoting;
  const noLiquidity = emptyRoute && route!.candidateCount === 0;
  const tooSmall = emptyRoute && route!.candidateCount > 0;
  const offerLimit = noLiquidity || tooSmall;

  return (
    <div className="swap-card">
      {tabs}

      <div className="swap-box">
        <div className="swap-box-head">
          <span>
            You spend {edited === "spend" ? "(max)" : "(estimated)"}
            {quoting && edited === "receive" && <span className="muted"> · quoting…</span>}
          </span>
          {canPickAmount && (
            <button type="button" className="linklike" onClick={() => setSpendPct(100)}>
              Balance: {fromRawAmount(spendBalance, spendDecimals)} · Max
            </button>
          )}
        </div>
        <div className="swap-box-row">
          <TokenSelect
            value={spendAsset}
            options={sellOptions}
            onChange={(id) => {
              setSpendAsset(id);
              setRoute(null);
            }}
            label="Spend — tokens in your wallet"
          />
          <input
            className="amount-input"
            inputMode="decimal"
            placeholder="0.00"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore=""
            value={spendHuman}
            onChange={(e) => {
              setEdited("spend");
              setSpendHuman(e.target.value);
            }}
          />
        </div>
        {canPickAmount && (
          <PercentSlider
            value={humanToPct(spendHuman, spendBalance, spendAsset ?? "", spendDecimals)}
            onChange={setSpendPct}
          />
        )}
      </div>

      <button
        type="button"
        className="flip-btn"
        onClick={flipSides}
        title="Flip sides"
        aria-label="Flip sides"
      >
        ⇅
      </button>

      <div className="swap-box">
        <div className="swap-box-head">
          <span>
            You receive {edited === "receive" ? "(target)" : "(estimated)"}
            {quoting && edited === "spend" && <span className="muted"> · quoting…</span>}
          </span>
          {hasRoute && (
            <span className="muted">
              1 {receiveTicker} ≈{" "}
              {fromRawAmount(
                (BigInt(route!.totalSpend) * 10n ** BigInt(receiveDecimals)) /
                  BigInt(route!.totalReceive),
                spendDecimals
              )}{" "}
              {spendTicker}
            </span>
          )}
        </div>
        <div className="swap-box-row">
          <TokenSelect
            value={receiveAsset}
            options={buyOptions}
            onChange={(id) => {
              setReceiveAsset(id);
              setRoute(null);
            }}
            label="Receive — tokens on the market"
          />
          <input
            className="amount-input"
            inputMode="decimal"
            placeholder="0.00"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore=""
            value={receiveHuman}
            onChange={(e) => {
              setEdited("receive");
              setReceiveHuman(e.target.value);
            }}
          />
        </div>
      </div>

      {hasRoute && (
        <p className="rate-line">
          Fills{" "}
          <strong>
            <TokenAmount assetId={route!.spendAsset} raw={route!.totalSpend} />
          </strong>{" "}
          →{" "}
          <strong>
            <TokenAmount assetId={route!.receiveAsset} raw={route!.totalReceive} />
          </strong>{" "}
          — {route!.legs.length} order{route!.legs.length === 1 ? "" : "s"} in{" "}
          {route!.atomic
            ? "ONE atomic transaction"
            : `${route!.transactionCount} atomic transactions`}
          .
        </p>
      )}

      {error && <p className="warn">{error}</p>}
      {flow.state.step === "error" && (
        <p className="warn">
          Batch failed: {flow.state.message}. Nothing in that batch settled —
          the quote re-plans automatically.
        </p>
      )}
      {noLiquidity && (
        <Callout label="NO MARKET">
          Nothing fills <strong>{spendTicker} → {receiveTicker}</strong> yet.
          Place a limit order at your price instead — it waits on the book until
          someone takes it, and opens this market.
        </Callout>
      )}
      {tooSmall && (
        <Callout label="TOO SMALL" tone="info">
          Your <strong>{spendTicker}</strong> amount is too small to fill any
          open order at the current price. Increase it, or place a limit order
          at your own price.
        </Callout>
      )}

      {hasRoute && (
        <div style={{ marginTop: "0.75rem" }}>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>You pay</th>
                <th>You receive</th>
                <th>Price</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              {route!.legs.map((leg, i) => (
                <tr key={leg.orderId}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <TokenAmount assetId={route!.spendAsset} raw={leg.spend} />
                  </td>
                  <td>
                    <TokenAmount assetId={route!.receiveAsset} raw={leg.receive} />
                  </td>
                  <td className="muted">{leg.price}</td>
                  <td className="mono muted" title={leg.orderId}>
                    {shortId(leg.orderId, 6)}{" "}
                    <ExplorerLink txHash={leg.orderId.split("#")[0]!} className="linklike">
                      ↗
                    </ExplorerLink>
                    {leg.partial && (
                      <span
                        className="small"
                        title="Partial fill: only part of this order is taken; the remainder stays on the book"
                      >
                        {" "}
                        ◐ partial
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {route!.warnings.length > 0 && (
            <ul className="warnings">
              {route!.warnings.map((w) => (
                <li key={w}>⚠ {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-big"
        onClick={() => {
          if (!flow.connected) {
            onShowConnect();
            return;
          }
          if (hasRoute) {
            runBatch(chunk(route!.legs, route!.maxOrdersPerTx), 0);
          } else if (offerLimit) {
            // Nothing fillable — hand over to the Limit tab with the same
            // tokens/amounts (opens the market if none exists yet).
            onPlaceLimitInstead();
          }
        }}
        disabled={
          flow.connected &&
          ((!hasRoute && !offerLimit) || flow.state.step === "building")
        }
        title={
          !flow.connected
            ? "Connect a wallet"
            : noLiquidity
              ? "No market yet — place a limit order at your price (it opens the market)"
              : tooSmall
                ? "Your amount is too small to fill an order — increase it, or place a limit order"
                : route?.atomic === false
                  ? "Each batch fills atomically; batches are signed one at a time"
                  : "All selected orders fill together in one transaction, or none do"
        }
      >
        {!flow.connected
          ? "Connect"
          : flow.state.step === "building"
            ? "Building order…"
            : noLiquidity
              ? "No market yet — place a limit order"
              : tooSmall
                ? "Amount too small — place a limit order"
                : !hasRoute
                  ? "Enter an amount"
                : route!.legs.length === 1
                  ? "Take this order"
                  : route!.atomic
                    ? `Fill ${route!.legs.length} orders atomically (1 tx)`
                    : `Execute route (${route!.legs.length} orders, ${route!.transactionCount} atomic txs)`}
      </button>
      {flow.connected && hasRoute && route!.legs.length > 1 && (
        <button
          type="button"
          className="btn btn-ghost"
          style={{ marginTop: "0.5rem", width: "100%" }}
          onClick={() => runBatch([[route!.legs[0]!]], 0)}
          disabled={!canExecute}
          title="Take only the single best-priced order"
        >
          Take best order only
        </button>
      )}

      <p className="muted small" style={{ marginTop: "0.75rem" }}>
        Type an amount on <em>either</em> side — fills the cheapest orders
        first, atomically (up to {route?.maxOrdersPerTx ?? 8} per tx).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Limit tab — place a fixed-price P2P order that sits on the book until
// someone takes it (or you cancel it). NOT an AMM swap. v3: the maker may
// opt in to partial fills (docs/partial-fills.md).
// ---------------------------------------------------------------------------

function LimitTab({
  tabs,
  sellOptions,
  buyOptions,
  form,
  onShowConnect,
  onRefreshBalances,
}: {
  tabs: React.ReactNode;
  sellOptions: TokenOption[];
  buyOptions: TokenOption[];
  form: TradeFormState;
  onShowConnect: () => void;
  onRefreshBalances: () => void;
}) {
  const flow = useTxFlow();

  // Shared form state — survives Market <-> Limit tab switches.
  const {
    sellAsset, setSellAsset,
    buyAsset, setBuyAsset,
    sellAmount, setSellAmount,
    buyAmount, setBuyAmount,
  } = form;
  const [allowPartialFill, setAllowPartialFill] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [paymentAddress, setPaymentAddress] = useState("");
  const [expiration, setExpiration] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  const sellInfo = useAssetInfo(sellAsset);
  const buyInfo = useAssetInfo(buyAsset);

  const sellBalance = sellOptions.find((o) => o.assetId === sellAsset)?.balanceRaw;
  const sellDecimals = decimalsOf(sellInfo, sellAsset ?? "");
  const buyDecimals = decimalsOf(buyInfo, buyAsset ?? "");

  const rate = useMemo(() => {
    const s = Number(sellAmount);
    const b = Number(buyAmount);
    if (!sellAsset || !buyAsset || !(s > 0) || !(b > 0)) return null;
    return `1 ${tickerOf(sellInfo, sellAsset)} = ${(b / s).toLocaleString(undefined, { maximumSignificantDigits: 6 })} ${tickerOf(buyInfo, buyAsset)}`;
  }, [sellAmount, buyAmount, sellAsset, buyAsset, sellInfo, buyInfo]);

  function setMax() {
    if (!sellAsset || sellBalance === undefined) return;
    const raw = sellAsset === "lovelace" ? sellBalance - 15_000_000n : sellBalance;
    setSellAmount(raw > 0n ? fromRawAmount(raw, sellDecimals) : "0");
  }

  function flip() {
    setSellAsset(buyAsset);
    setBuyAsset(sellAsset);
    setSellAmount(buyAmount);
    setBuyAmount(sellAmount);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!flow.connected) {
      onShowConnect();
      return;
    }
    const problems: string[] = [];
    if (!sellAsset) problems.push("choose the token you sell");
    if (!buyAsset) problems.push("choose the token you want");
    let offerRaw = 0n;
    let askRaw = 0n;
    try {
      offerRaw = toRawAmount(sellAmount || "0", sellDecimals);
    } catch (err) {
      problems.push(`sell amount: ${err instanceof Error ? err.message : err}`);
    }
    try {
      askRaw = toRawAmount(buyAmount || "0", buyDecimals);
    } catch (err) {
      problems.push(`buy amount: ${err instanceof Error ? err.message : err}`);
    }
    if (sellAsset && sellBalance !== undefined && offerRaw > sellBalance)
      problems.push("sell amount exceeds your wallet balance");
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }

    const result = validateCreateOrder({
      offerAsset: sellAsset!,
      offerAmount: offerRaw.toString(),
      askAsset: buyAsset!,
      askAmount: askRaw.toString(),
      paymentAddress,
      expiration,
    });
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    void flow.build((wallet) =>
      api.buildCreateOrder({ wallet, ...result.value, allowPartialFill })
    );
  }

  if (flow.state.step === "submitted") {
    const backToTrade = () => {
      flow.reset();
      onRefreshBalances();
    };
    return (
      <div className="swap-card tx-flow-host">
        <TxStatus
          txHash={flow.state.txHash}
          onSettled={backToTrade}
          onDismiss={backToTrade}
        />
      </div>
    );
  }
  if (flow.state.step === "preview" || flow.state.step === "signing") {
    return (
      <div className="swap-card tx-flow-host">
        <TransactionPreview
          tx={flow.state.tx}
          onConfirm={flow.confirmAndSign}
          onReject={flow.reject}
          busy={flow.state.step === "signing"}
        />
      </div>
    );
  }

  return (
    <form className="swap-card" onSubmit={onSubmit}>
      {tabs}
      <div className="swap-box">
        <div className="swap-box-head">
          <span>You sell</span>
          {sellAsset && sellBalance !== undefined && (
            <button type="button" className="linklike" onClick={setMax}>
              Balance: {fromRawAmount(sellBalance, sellDecimals)} · Max
            </button>
          )}
        </div>
        <div className="swap-box-row">
          <TokenSelect
            value={sellAsset}
            options={sellOptions}
            onChange={setSellAsset}
            label="Sell — tokens in your wallet"
          />
          <input
            className="amount-input"
            inputMode="decimal"
            placeholder="0.00"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore=""
            value={sellAmount}
            onChange={(e) => setSellAmount(e.target.value)}
          />
        </div>
        {flow.connected && sellAsset && sellBalance !== undefined && sellBalance > 0n && (
          <PercentSlider
            value={humanToPct(sellAmount, sellBalance, sellAsset, sellDecimals)}
            onChange={(pct) => setSellAmount(pctToHuman(pct, sellBalance, sellAsset, sellDecimals))}
          />
        )}
      </div>

      <button type="button" className="flip-btn" onClick={flip} title="Flip sides" aria-label="Flip sides">
        ⇅
      </button>

      <div className="swap-box">
        <div className="swap-box-head">
          <span>You buy (your asking price)</span>
        </div>
        <div className="swap-box-row">
          <TokenSelect
            value={buyAsset}
            options={buyOptions}
            onChange={setBuyAsset}
            label="Buy — tokens on the market"
          />
          <input
            className="amount-input"
            inputMode="decimal"
            placeholder="0.00"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore=""
            value={buyAmount}
            onChange={(e) => setBuyAmount(e.target.value)}
          />
        </div>
      </div>

      {rate && <p className="rate-line">{rate}</p>}

      <div
        className="toggle-field"
        title="Takers may fill any fraction of your order at your price; the remainder stays on the book. Your ~3.5 tADA deposit stays locked with the remainder and returns on the final fill or cancel."
      >
        <div className="toggle-field-text">
          <span className="toggle-field-title">Allow partial fills</span>
          <span className="toggle-field-sub muted">
            Recommended — fills faster; your deposit returns on the final fill
          </span>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={allowPartialFill}
            onChange={(e) => setAllowPartialFill(e.target.checked)}
          />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
        </label>
      </div>

      <button type="button" className="linklike advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
        {showAdvanced ? "▾" : "▸"} Advanced (payment address, expiration)
      </button>
      {showAdvanced && (
        <div className="advanced">
          <label htmlFor="payment-address">Payment address (defaults to your wallet; key address only)</label>
          <input
            id="payment-address"
            value={paymentAddress}
            placeholder="addr_test1…"
            onChange={(e) => setPaymentAddress(e.target.value)}
          />
          <label htmlFor="expiration">Expiration (optional)</label>
          <input
            id="expiration"
            type="datetime-local"
            value={expiration}
            onChange={(e) => setExpiration(e.target.value)}
          />
        </div>
      )}

      {errors.length > 0 && (
        <ul className="warnings">
          {errors.map((e) => (
            <li key={e}>⚠ {e}</li>
          ))}
        </ul>
      )}
      {flow.state.step === "error" && <p className="warn">Failed: {flow.state.message}</p>}

      <button
        type="submit"
        className="btn btn-primary btn-big"
        disabled={flow.connected && flow.state.step === "building"}
      >
        {!flow.connected
          ? "Connect"
          : flow.state.step === "building"
            ? "Building order…"
            : "Place order"}
      </button>

      <Callout label="NOTE" tone="info">
        This is a P2P order book, not an AMM: placing an order locks your tokens
        (plus a ~3.5 tADA deposit, returned on fill/cancel) at <strong>your</strong>{" "}
        price until someone takes it. Cancel anytime from My orders.
      </Callout>
    </form>
  );
}
