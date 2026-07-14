/**
 * Shared API/domain types. Mirrors docs/protocol-spec.md §2 and the actual
 * Aiken types in contracts/lib/p2p_dex/types.ak.
 * All on-chain amounts are stringified bigints (JSON-safe raw units).
 */

/** "policyIdHex.assetNameHex", or "lovelace" for ADA. */
export type AssetId = string;

/** Canonical pair key: two AssetIds sorted lexicographically, joined by "_". */
export type PairId = string;

export type OrderStatus =
  | "open"
  | "taken"
  | "partially_filled"
  | "cancelled"
  | "unknown";

export interface AssetInfo {
  assetId: AssetId;
  policyId: string;
  assetNameHex: string;
  ticker?: string;
  name?: string;
  decimals?: number;
}

export interface Order {
  /** UTxO ref of the order: "txHash#index". */
  orderId: string;
  txHash: string;
  outputIndex: number;
  status: OrderStatus;
  pairId: PairId;
  /** Bech32 order address (validator payment cred + owner staking cred). */
  contractAddress: string;
  /** Hex key hash of the owner staking key (== OwnerBeacon token name). */
  ownerStakeCredential: string;
  /** Bech32 address that must receive the ask payment on take. */
  paymentAddress: string;
  offeredPolicyId: string;
  offeredAssetName: string;
  offeredAmount: string;
  requestedPolicyId: string;
  requestedAssetName: string;
  requestedAmount: string;
  depositLovelace: string;
  pairBeacon: string;
  offerBeacon: string;
  askBeacon: string;
  ownerBeacon: string;
  /** POSIX ms, if the order expires. */
  expiration?: number;
  version: number;
  /** v3: seller opted in to partial fills (docs/partial-fills.md). */
  allowPartialFill: boolean;
  /** v3 lineage: set when this order is the continuation of a partial fill. */
  parentOrderId?: string;
  /** v3 lineage: the original order at the head of the fill chain. */
  rootOrderId?: string;
  createdAtSlot?: number;
  spentAtSlot?: number;
  createdTxHash?: string;
  spentTxHash?: string;
}

/**
 * Past its expiration an order is unfillable — the validator demands a tx
 * validity upper bound ≤ expiration, so any take is dead on arrival — and only
 * the owner can reclaim it (cancel has no expiry check). Expiry is a property
 * of the CLOCK, not the UTxO, so the indexer never sees it: callers that show
 * or route takeable orders must filter with this at read time.
 */
export function isOrderExpired(o: Order, nowPosixMs = Date.now()): boolean {
  return o.expiration !== undefined && o.expiration <= nowPosixMs;
}

export interface Orderbook {
  pairId: PairId;
  /** Orders offering the pair's base asset (lexicographically first). */
  bids: Order[];
  /** Orders offering the pair's quote asset. */
  asks: Order[];
  syncedToSlot?: number;
}

/**
 * One leg of a Smart Fill route: a single existing full order the taker would
 * consume with the unchanged MVP TakeOrder path. Amounts are raw integer units
 * (stringified bigint). `price` is spend-per-receive in raw units (decimal
 * string), computed bigint-safely.
 */
export interface SmartFillLeg {
  orderId: string;
  /** requestedAmount of spendAsset the taker pays for this order. */
  spend: string;
  /** offeredAmount of receiveAsset the taker gets from this order. */
  receive: string;
  /** spend / receive, raw units, as a fixed-precision decimal string. */
  price: string;
  expiration?: number;
  /** v3: set when this leg partially fills the order (receive == takeAmount). */
  partial?: boolean;
  /** v3: the offered-asset amount to take (TakeOrderPartial take_amount). */
  takeAmount?: string;
}

/**
 * Off-chain route preview. v2 (take-many-orders.md): legs are grouped into
 * TakeManyOrders batches of up to `maxOrdersPerTx` orders — each batch is ONE
 * atomic transaction. Full orders only — no leg is ever partially filled.
 */
export interface SmartFillRoute {
  pairId: PairId;
  spendAsset: AssetId;
  receiveAsset: AssetId;
  /** Which side the taker constrained: a max spend, or a target receive. */
  mode: "spend" | "receive";
  /** The raw amount the taker asked for on the `mode` side. */
  requested: string;
  legs: SmartFillLeg[];
  /** Sum of leg spends (raw units). In "spend" mode, always <= requested. */
  totalSpend: string;
  /** Sum of leg receives (raw units). In "receive" mode, >= requested if fully routable. */
  totalReceive: string;
  /** totalSpend / totalReceive, raw units, decimal string ("" if no legs). */
  averagePrice: string;
  /** Number of TakeManyOrders txs needed: ceil(legs / maxOrdersPerTx). */
  transactionCount: number;
  /** Batch cap used for grouping (config MAX_ORDERS_PER_TX). */
  maxOrdersPerTx: number;
  /** True iff the whole route settles in ONE transaction. */
  atomic: boolean;
  /** Open orders on this side of the book (spend->receive), regardless of
   *  whether this amount can fill any. 0 = the market itself doesn't exist yet;
   *  >0 with empty legs = a market exists but the amount is too small. */
  candidateCount: number;
  warnings: string[];
}

/**
 * One leg of an arbitrage cycle (docs/arbitrage.md): a single existing order
 * consumed by the atomic TakeManyOrders tx. The taker pays `payAmount` of
 * `payAsset` (the order's ask) and receives `receiveAmount` of `receiveAsset`
 * (the order's offer, or `takeAmount` on a partial leg). Raw integer units.
 */
export interface ArbitrageLeg {
  orderId: string;
  payAsset: AssetId;
  payAmount: string;
  receiveAsset: AssetId;
  receiveAmount: string;
  expiration?: number;
  /** v3: this leg partially fills the order (receiveAmount == takeAmount). */
  partial?: boolean;
  /** v3: offered-asset amount to take (TakeOrderPartial take_amount). */
  takeAmount?: string;
}

/**
 * A riskless profit cycle over the open book, settled as ONE atomic
 * TakeManyOrders tx (docs/arbitrage.md). `net` is the taker's per-asset gross
 * gain — every entry is >= 0 by construction and at least one is > 0; the
 * cycle funds itself, so the wallet only covers the tx fee (+ min-ADA on
 * partial legs).
 */
export interface ArbitrageOpportunity {
  /** Sorted orderIds joined by "+" — stable identity for dedup/refresh. */
  id: string;
  kind: "direct" | "triangular";
  /** The cycle's assets in pay order: legs[i] converts cycle[i] -> cycle[i+1 mod n]. */
  cycle: AssetId[];
  legs: ArbitrageLeg[];
  /** Gross taker gain per asset (only non-zero entries; raw units). */
  net: { assetId: AssetId; amount: string }[];
  /** Quoted cycle margin: rate product − 1, as a percent decimal string. */
  marginPct: string;
  /** Config-driven fee estimate (the preview shows the real fee pre-sign). */
  estimatedFeeLovelace: string;
  /** Extra taker-funded lovelace on partial legs (min-ADA gifts to sellers). */
  partialMinAdaLovelace: string;
  /** Gross lovelace net − fee estimate − partial min-ADA. May be negative
   *  (profit purely in tokens) — signed bigint string. */
  lovelaceNetAfterCosts: string;
  /** Earliest leg expiration (POSIX ms), if any leg expires. */
  expiresAt?: number;
  warnings: string[];
}

/** GET /arbitrage response: a scan of the whole cached open book. */
export interface ArbitrageScan {
  opportunities: ArbitrageOpportunity[];
  scannedOrders: number;
  pairCount: number;
  generatedAtMs: number;
  warnings: string[];
}

export interface ProtocolConfig {
  network: "preprod";
  protocolVersion: number;
  orderValidatorHash: string;
  beaconPolicyId: string;
  orderBeaconNameHex: string;
  depositLovelace: string;
  /** Max orders one TakeManyOrders tx may consume (v2 atomic batches). */
  maxOrdersPerTx: number;
  /** v3: partial fills available (docs/partial-fills.md). */
  partialFillsSupported: boolean;
  derivationScheme: string;
}

export interface ReferenceScriptInfo {
  scriptHash: string;
  purpose: "order-validator" | "beacon-policy";
  utxoRef: string;
}

/** v3: per-leg detail for partial fills inside a take tx. */
export interface PartialFillSummary {
  orderId: string;
  /** Offered-asset amount taken (TakeOrderPartial take_amount). */
  takeAmount: string;
  /** Ask paid for this leg: ceil(take * ask / offer). */
  paidAsk: string;
  /** Continuation order's remaining offer / ask amounts. */
  remainingOffer: string;
  remainingAsk: string;
  /** Address the continuation order is re-locked at. */
  continuationAddress: string;
}

export interface TxSummary {
  action:
    | "create-order"
    | "cancel-order"
    | "take-order"
    | "take-order-partial"
    | "take-many-orders";
  network: "preprod";
  /** Human-readable lines describing exactly what the tx does. */
  description: string;
  offered?: { assetId: AssetId; amount: string };
  requested?: { assetId: AssetId; amount: string };
  depositLovelace?: string;
  beacons?: { minted?: string[]; burned?: string[] };
  orderAddress?: string;
  paymentAddress?: string;
  orderId?: string;
  /** take-many-orders: every order consumed atomically by this one tx. */
  orderIds?: string[];
  /** Take actions: the taker's EXACT per-asset net of the order flows in
   *  this tx (signed raw units) — order UTxO values in, minus seller
   *  payments and partial-fill continuations out; beacons, fee and change
   *  excluded. The only aggregate that stays meaningful for mixed-asset
   *  batches (arbitrage cycles, docs/arbitrage.md). */
  takerNet?: { assetId: AssetId; amount: string }[];
  /** v3: one entry per partially-filled order in this tx. */
  partialFills?: PartialFillSummary[];
  expiration?: number | null;
  warnings: string[];
}

/**
 * Unsigned transaction handed to the browser wallet (CIP-30 signTx).
 * The backend NEVER signs (docs/security.md §1). The summary is advisory —
 * the frontend must warn that full client-side CBOR verification is a
 * remaining trust gap until implemented.
 */
export interface UnsignedTxResponse {
  unsignedTxCborHex: string;
  summary: TxSummary;
}
