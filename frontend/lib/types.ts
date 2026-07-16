/**
 * API types — mirror of backend/src/types.ts (kept in sync manually until a
 * shared package is extracted).
 */

export type AssetId = string; // "policyHex.nameHex" | "lovelace"
export type PairId = string; // sorted "assetId_assetId"
export type OrderStatus =
  | "open"
  | "taken"
  | "partially_filled"
  | "cancelled"
  | "unknown";

export interface Order {
  orderId: string; // "txHash#index"
  txHash: string;
  outputIndex: number;
  status: OrderStatus;
  pairId: PairId;
  contractAddress: string;
  ownerStakeCredential: string;
  paymentAddress: string;
  offeredPolicyId: string;
  offeredAssetName: string;
  offeredAmount: string;
  requestedPolicyId: string;
  requestedAssetName: string;
  requestedAmount: string;
  depositLovelace: string;
  expiration?: number;
  version: number;
  /** v3: seller opted in to partial fills. */
  allowPartialFill?: boolean;
  /** v3 lineage: set when this order continues a partially-filled parent. */
  parentOrderId?: string;
  rootOrderId?: string;
}

export interface Orderbook {
  pairId: PairId;
  bids: Order[];
  asks: Order[];
  syncedToSlot?: number;
}

/** v3: per-leg detail for partial fills inside a take tx. */
export interface PartialFillSummary {
  orderId: string;
  takeAmount: string;
  paidAsk: string;
  remainingOffer: string;
  remainingAsk: string;
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
   *  this tx (signed raw units; beacons, fee and change excluded). The only
   *  aggregate that stays meaningful for mixed-asset batches (arbitrage). */
  takerNet?: { assetId: AssetId; amount: string }[];
  /** v3: one entry per partially-filled order in this tx. */
  partialFills?: PartialFillSummary[];
  expiration?: number | null;
  warnings: string[];
}

export interface UnsignedTxResponse {
  unsignedTxCborHex: string;
  summary: TxSummary;
}

/** One leg of a Smart Fill route (raw units). v3: may be a partial fill. */
export interface SmartFillLeg {
  orderId: string;
  spend: string;
  receive: string;
  price: string;
  expiration?: number;
  /** v3: this leg partially fills the order (receive == takeAmount). */
  partial?: boolean;
  /** v3: offered-asset amount to take (passed to buildTakeManyOrders). */
  takeAmount?: string;
}

/**
 * Off-chain Smart Fill route preview. v2: legs are grouped into
 * TakeManyOrders batches of up to `maxOrdersPerTx` orders — each batch is
 * ONE atomic transaction. `atomic` is true iff the whole route is one tx.
 */
export interface SmartFillRoute {
  pairId: PairId;
  spendAsset: AssetId;
  receiveAsset: AssetId;
  mode: "spend" | "receive";
  requested: string;
  legs: SmartFillLeg[];
  totalSpend: string;
  totalReceive: string;
  averagePrice: string;
  transactionCount: number;
  maxOrdersPerTx: number;
  atomic: boolean;
  /** Open orders on this side of the book. 0 = no market yet; >0 with empty
   *  legs = a market exists but this amount is too small to fill any order. */
  candidateCount: number;
  warnings: string[];
}

/** One leg of an arbitrage cycle (docs/arbitrage.md): pay the order's ask,
 *  receive its offer (or takeAmount on a partial leg). Raw units. */
export interface ArbitrageLeg {
  orderId: string;
  payAsset: AssetId;
  payAmount: string;
  receiveAsset: AssetId;
  receiveAmount: string;
  expiration?: number;
  partial?: boolean;
  takeAmount?: string;
}

/** A riskless profit cycle settled as ONE atomic TakeManyOrders tx. Every
 *  `net` entry is >= 0 by construction and at least one is > 0; the cycle
 *  funds itself — the wallet only covers the fee (+ min-ADA on partials). */
export interface ArbitrageOpportunity {
  id: string;
  kind: "direct" | "triangular";
  cycle: AssetId[];
  legs: ArbitrageLeg[];
  net: { assetId: AssetId; amount: string }[];
  marginPct: string;
  estimatedFeeLovelace: string;
  partialMinAdaLovelace: string;
  /** Signed: may be negative when the profit is purely in tokens. */
  lovelaceNetAfterCosts: string;
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

export interface ProtocolConfigResponse {
  network: "preprod";
  /** Release version of the self-hosted backend. */
  appVersion?: string;
  protocolVersion: number;
  orderValidatorHash: string;
  beaconPolicyId: string;
  orderBeaconNameHex: string;
  depositLovelace: string;
  /** v3: partial fills available (docs/partial-fills.md). */
  partialFillsSupported?: boolean;
  derivationScheme: string;
}

/** Minimal Mesh UTxO shape shipped to the backend for coin selection. */
export interface WalletUtxo {
  input: { txHash: string; outputIndex: number };
  output: {
    address: string;
    amount: { unit: string; quantity: string }[];
    plutusData?: string;
    dataHash?: string;
    scriptRef?: string;
    scriptHash?: string;
  };
}

export interface WalletContextPayload {
  changeAddress: string;
  utxos: WalletUtxo[];
  collateral?: WalletUtxo;
}

export function offeredAssetId(o: Order): AssetId {
  return o.offeredPolicyId === ""
    ? "lovelace"
    : `${o.offeredPolicyId}.${o.offeredAssetName}`;
}

export function requestedAssetId(o: Order): AssetId {
  return o.requestedPolicyId === ""
    ? "lovelace"
    : `${o.requestedPolicyId}.${o.requestedAssetName}`;
}
