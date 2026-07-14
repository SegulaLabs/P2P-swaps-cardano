import { BlockfrostProvider } from "@meshsdk/core";
import type { IFetcher, ISubmitter, IEvaluator, UTxO } from "@meshsdk/core";

/**
 * Chain-provider abstraction — the ONLY module that talks to the chain.
 * Blockfrost (via Mesh's provider + a few raw REST calls Mesh doesn't wrap)
 * for MVP; the interface is what a future Kupo/Ogmios implementation must
 * satisfy (docs/deployment.md §7).
 */

export interface ChainTip {
  slot: number;
  height: number;
}

export interface AssetTxRef {
  txHash: string;
  blockHeight: number;
  blockTime: number;
}

export interface TxUtxos {
  hash: string;
  inputs: { address: string; txHash: string; outputIndex: number }[];
  outputs: {
    address: string;
    amount: { unit: string; quantity: string }[];
    /** This output's index in the tx (array order matches). */
    outputIndex: number;
    /** Tx hash that spent this output, or null if still unspent. */
    consumedByTx: string | null;
  }[];
}

/** One spend-purpose redeemer of a tx (v3: per-INPUT, for mixed batches). */
export interface SpendRedeemer {
  /** Index of the spent input in the tx's (canonically sorted) input list. */
  txIndex: number;
  scriptHash: string;
  /** Plutus constructor index: Cancel=0, Take=1, TakeOrderPartial=2. */
  constructor: number;
  /** Constructor fields (json_value); TakeOrderPartial carries [take_amount]. */
  fields: unknown[];
}

export interface ChainProvider {
  readonly name: string;
  /** Mesh-compatible fetcher/submitter/evaluator for MeshTxBuilder. */
  readonly mesh: IFetcher & ISubmitter & IEvaluator;

  getUtxosByAddress(address: string, assetUnit?: string): Promise<UTxO[]>;
  /** Addresses currently holding at least one unit of the asset. */
  getAssetAddresses(assetUnit: string): Promise<{ address: string; quantity: string }[]>;
  getUtxo(txHash: string, outputIndex: number): Promise<UTxO | null>;
  /**
   * A tx's output at a given index REGARDLESS of spent status — unlike
   * getUtxo(), which only returns still-unspent outputs. Used to reconstruct
   * an order's historical UTxO (address + amount + datum) after it has
   * already been spent, e.g. rebuilding partial-fill lineage across an
   * indexer cache reset: the parent is no longer a live UTxO, but its
   * creation output and inline datum are still on-chain forever.
   */
  getTxOutput(txHash: string, outputIndex: number): Promise<UTxO | null>;
  getAssetMetadata(assetUnit: string): Promise<Record<string, unknown> | null>;
  /** Txs that touched an asset (mints/burns/transfers), newest first. */
  getAssetTransactions(assetUnit: string, page?: number): Promise<AssetTxRef[]>;
  getTxUtxos(txHash: string): Promise<TxUtxos | null>;
  /**
   * The Plutus constructor index of the spend-purpose redeemer a tx used
   * against `scriptHash`, or null if none is found. Used to distinguish
   * CancelOrder (0) from TakeOrder (1) unambiguously — see
   * order-indexer.ts classifySpend for why payment-shape heuristics are
   * NOT reliable here (a self-cancel's refund can accidentally look like a
   * take-payment when owner and payment_address coincide).
   */
  getSpendRedeemerConstructor(
    txHash: string,
    scriptHash: string
  ): Promise<number | null>;
  /**
   * ALL spend-purpose redeemers of a tx, with their input indices (v3).
   * A mixed batch spends several order inputs under DIFFERENT redeemers
   * (TakeOrder vs TakeOrderPartial), so per-tx-per-script lookup is not
   * enough — the indexer matches each spent order to its own redeemer via
   * the input's position in the consuming tx.
   */
  getSpendRedeemers(txHash: string): Promise<SpendRedeemer[]>;
  getTip(): Promise<ChainTip>;
  /**
   * Confirmations for a tx hash; null if unknown/not found. Pass a
   * known tip height (e.g. one already fetched this sync pass) to skip
   * an extra /blocks/latest round-trip.
   */
  getTxConfirmations(txHash: string, tipHeight?: number): Promise<number | null>;
  /** Relay an ALREADY-SIGNED tx (not custody). Returns the tx hash. */
  submitTx(signedTxCborHex: string): Promise<string>;
}

const BLOCKFROST_BASE = "https://cardano-preprod.blockfrost.io/api/v0";

export class BlockfrostChainProvider implements ChainProvider {
  readonly name = "blockfrost-preprod";
  readonly mesh: BlockfrostProvider;

  constructor(private readonly projectId: string) {
    if (!projectId.startsWith("preprod")) {
      throw new Error(
        "Blockfrost project id must be a preprod project (MVP is preprod-only)"
      );
    }
    this.mesh = new BlockfrostProvider(projectId);
  }

  /** Raw REST for endpoints Mesh doesn't wrap. Returns null on 404. */
  private async rest<T>(path: string): Promise<T | null> {
    const res = await fetch(`${BLOCKFROST_BASE}${path}`, {
      headers: { project_id: this.projectId },
    });
    if (res.status === 404) return null;
    if (!res.ok)
      throw new Error(`blockfrost ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async getUtxosByAddress(address: string, assetUnit?: string): Promise<UTxO[]> {
    try {
      return await this.mesh.fetchAddressUTxOs(address, assetUnit);
    } catch {
      return []; // Blockfrost 404s addresses that never appeared on-chain
    }
  }

  async getAssetAddresses(
    assetUnit: string
  ): Promise<{ address: string; quantity: string }[]> {
    const rows = await this.rest<{ address: string; quantity: string }[]>(
      `/assets/${assetUnit}/addresses`
    );
    return rows ?? [];
  }

  async getUtxo(txHash: string, outputIndex: number): Promise<UTxO | null> {
    // NOT Mesh's fetchUTxOs(): it reads /txs/{hash}/utxos but drops the
    // `consumed_by_tx` field, so it keeps "finding" an output forever, even
    // long after it's spent (confirmed live against preprod — a take/cancel
    // built against a stale getUtxo() would target an already-spent input
    // and fail at submission instead of cleanly 404ing). Blockfrost's raw
    // response carries consumed_by_tx (null = still unspent); use that.
    return this.fetchOutput(txHash, outputIndex, /* requireUnspent */ true);
  }

  async getTxOutput(txHash: string, outputIndex: number): Promise<UTxO | null> {
    return this.fetchOutput(txHash, outputIndex, /* requireUnspent */ false);
  }

  private async fetchOutput(
    txHash: string,
    outputIndex: number,
    requireUnspent: boolean
  ): Promise<UTxO | null> {
    const raw = await this.rest<{
      hash: string;
      outputs: {
        address: string;
        amount: { unit: string; quantity: string }[];
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        reference_script_hash: string | null;
        consumed_by_tx: string | null;
      }[];
    }>(`/txs/${txHash}/utxos`);
    if (!raw) return null;
    const out = raw.outputs.find((o) => o.output_index === outputIndex);
    if (!out) return null;
    if (requireUnspent && out.consumed_by_tx !== null) return null;
    return {
      input: { txHash, outputIndex },
      output: {
        address: out.address,
        amount: out.amount,
        ...(out.data_hash ? { dataHash: out.data_hash } : {}),
        ...(out.inline_datum ? { plutusData: out.inline_datum } : {}),
        ...(out.reference_script_hash
          ? { scriptRef: out.reference_script_hash }
          : {}),
      },
    };
  }

  async getAssetMetadata(
    assetUnit: string
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.mesh.fetchAssetMetadata(assetUnit);
    } catch {
      return null;
    }
  }

  async getAssetTransactions(
    assetUnit: string,
    page = 1
  ): Promise<AssetTxRef[]> {
    const rows = await this.rest<
      { tx_hash: string; block_height: number; block_time: number }[]
    >(`/assets/${assetUnit}/transactions?order=desc&count=100&page=${page}`);
    return (rows ?? []).map((r) => ({
      txHash: r.tx_hash,
      blockHeight: r.block_height,
      blockTime: r.block_time,
    }));
  }

  async getTxUtxos(txHash: string): Promise<TxUtxos | null> {
    const raw = await this.rest<{
      hash: string;
      inputs: { address: string; tx_hash: string; output_index: number }[];
      outputs: {
        address: string;
        amount: { unit: string; quantity: string }[];
        output_index?: number;
        consumed_by_tx: string | null;
      }[];
    }>(`/txs/${txHash}/utxos`);
    if (!raw) return null;
    return {
      hash: raw.hash,
      inputs: raw.inputs.map((i) => ({
        address: i.address,
        txHash: i.tx_hash,
        outputIndex: i.output_index,
      })),
      outputs: raw.outputs.map((o, i) => ({
        address: o.address,
        amount: o.amount,
        outputIndex: o.output_index ?? i,
        consumedByTx: o.consumed_by_tx ?? null,
      })),
    };
  }

  async getSpendRedeemerConstructor(
    txHash: string,
    scriptHash: string
  ): Promise<number | null> {
    const redeemers = await this.rest<
      { purpose: string; script_hash: string; redeemer_data_hash: string }[]
    >(`/txs/${txHash}/redeemers`);
    const entry = redeemers?.find(
      (r) => r.purpose === "spend" && r.script_hash === scriptHash
    );
    if (!entry) return null;
    const datum = await this.rest<{ json_value: { constructor: number } }>(
      `/scripts/datum/${entry.redeemer_data_hash}`
    );
    return datum?.json_value.constructor ?? null;
  }

  async getSpendRedeemers(txHash: string): Promise<SpendRedeemer[]> {
    const redeemers = await this.rest<
      {
        tx_index: number;
        purpose: string;
        script_hash: string;
        redeemer_data_hash: string;
      }[]
    >(`/txs/${txHash}/redeemers`);
    const spends = (redeemers ?? []).filter((r) => r.purpose === "spend");
    const out: SpendRedeemer[] = [];
    for (const r of spends) {
      const datum = await this.rest<{
        json_value: { constructor: number; fields?: unknown[] };
      }>(`/scripts/datum/${r.redeemer_data_hash}`);
      if (!datum) continue;
      out.push({
        txIndex: r.tx_index,
        scriptHash: r.script_hash,
        constructor: datum.json_value.constructor,
        fields: datum.json_value.fields ?? [],
      });
    }
    return out;
  }

  async getTip(): Promise<ChainTip> {
    const block = await this.rest<{ slot: number; height: number }>(
      `/blocks/latest`
    );
    if (!block) throw new Error("blockfrost: no latest block");
    return { slot: block.slot, height: block.height };
  }

  async getTxConfirmations(
    txHash: string,
    tipHeight?: number
  ): Promise<number | null> {
    const tx = await this.rest<{ block_height: number }>(`/txs/${txHash}`);
    if (!tx) return null;
    const height = tipHeight ?? (await this.getTip()).height;
    return Math.max(0, height - tx.block_height + 1);
  }

  async submitTx(signedTxCborHex: string): Promise<string> {
    return this.mesh.submitTx(signedTxCborHex);
  }
}
