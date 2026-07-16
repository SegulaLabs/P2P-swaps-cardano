import type {
  ArbitrageScan,
  Order,
  Orderbook,
  PairId,
  ProtocolConfigResponse,
  SmartFillRoute,
  UnsignedTxResponse,
  WalletContextPayload,
} from "./types";

/**
 * Typed client for the backend API. The backend returns UNSIGNED transactions
 * only — signing always happens in the user's wallet (docs/security.md §1).
 */

// Default (unset/empty): same-origin "/backend" — the Next server proxies it
// to the backend (rewrite in next.config.mjs, target BACKEND_INTERNAL_URL).
// The site then works under ANY hostname or IP with no CORS and no rebuild.
// Set NEXT_PUBLIC_API_URL only to hit a backend at a *different* address
// than the site itself (baked into the bundle at build time).
const API = process.env.NEXT_PUBLIC_API_URL || "/backend";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string
  ) {
    super(detail);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof body.error === "string" ? body.error : "request_failed",
      typeof body.detail === "string"
        ? body.detail
        : typeof body.error === "string"
          ? body.error
          : `${path} -> ${res.status}`
    );
  }
  return body as T;
}

export const api = {
  health: () => request<{ status: string; network: string }>("/health"),
  assetInfo: (assetId: string) =>
    request<{
      assetId: string;
      policyId: string;
      assetNameHex: string;
      ticker?: string;
      name?: string;
      decimals?: number;
    }>(`/assets/${encodeURIComponent(assetId)}`),
  protocolConfig: () => request<ProtocolConfigResponse>("/protocol/config"),
  pairs: () => request<{ pairs: PairId[] }>("/pairs"),
  orderbook: (pair: PairId) =>
    request<Orderbook>(`/pairs/${encodeURIComponent(pair)}/orderbook`),
  order: (orderId: string) =>
    request<Order>(`/orders/${encodeURIComponent(orderId)}`),
  smartFill: (q: {
    spendAsset: string;
    receiveAsset: string;
    maxSpend?: string;
    minReceive?: string;
  }) =>
    request<SmartFillRoute>(
      `/smart-fill?spendAsset=${encodeURIComponent(q.spendAsset)}` +
        `&receiveAsset=${encodeURIComponent(q.receiveAsset)}` +
        (q.maxSpend !== undefined
          ? `&maxSpend=${encodeURIComponent(q.maxSpend)}`
          : `&minReceive=${encodeURIComponent(q.minReceive!)}`)
    ),
  /** Riskless profit cycles over the whole open book (docs/arbitrage.md).
   *  Execute one via buildTakeManyOrders with the opportunity's legs. */
  arbitrage: () => request<ArbitrageScan>("/arbitrage"),
  ordersByOwner: (stakeCredential: string) =>
    request<{ owner: string; orders: Order[] }>(
      `/orders/by-owner/${encodeURIComponent(stakeCredential)}`
    ),
  txStatus: (txHash: string) =>
    request<{ txHash: string; found: boolean; confirmations: number }>(
      `/tx/${txHash}/status`
    ),
  /** Manual "Refresh" — triggers an on-demand chain resync (server-side
   *  cooldown-gated; the background sync otherwise runs rarely by design,
   *  see INDEXER_POLL_MS). */
  reindex: () =>
    request<{ ok: true; open: number; spent: number; skipped: boolean }>(
      "/indexer/reindex",
      { method: "POST", body: "{}" }
    ),

  buildCreateOrder: (body: {
    wallet: WalletContextPayload;
    paymentAddress?: string;
    offerAsset: string;
    offerAmount: string;
    askAsset: string;
    askAmount: string;
    expiration?: number;
    /** v3: opt the order into partial fills. */
    allowPartialFill?: boolean;
  }) =>
    request<UnsignedTxResponse>("/tx/create-order", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  buildCancelOrder: (body: { wallet: WalletContextPayload; orderId: string }) =>
    request<UnsignedTxResponse>("/tx/cancel-order", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** v3: pass takeAmount (raw offered units) for a partial fill. */
  buildTakeOrder: (body: {
    wallet: WalletContextPayload;
    orderId: string;
    takeAmount?: string;
  }) =>
    request<UnsignedTxResponse>("/tx/take-order", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** v2: take up to maxOrdersPerTx orders in ONE atomic transaction.
   *  v3: legs may carry takeAmount for partial fills. */
  buildTakeManyOrders: (body: {
    wallet: WalletContextPayload;
    orders: { orderId: string; takeAmount?: string }[];
  }) =>
    request<UnsignedTxResponse>("/tx/take-many-orders", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
