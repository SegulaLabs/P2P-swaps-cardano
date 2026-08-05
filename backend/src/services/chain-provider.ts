import { BlockfrostProvider, KoiosProvider } from "@meshsdk/core";
import type { IFetcher, ISubmitter, IEvaluator, UTxO } from "@meshsdk/core";

/**
 * Chain-provider abstraction — the ONLY module that talks to the chain.
 * Blockfrost or Koios (via Mesh's provider + a few raw REST calls Mesh
 * doesn't wrap) — the user picks one (docs/deployment.md §7, README "Chain
 * provider"); the interface is what a future Kupo/Ogmios implementation must
 * satisfy too.
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

const KOIOS_BASE = "https://preprod.koios.rest/api/v1";

/**
 * Koios (preprod) — keyless by default (public rate-limited tier); an
 * optional bearer token raises the rate limit (https://koios.rest).
 *
 * Unlike Blockfrost, Koios doesn't hand back "which tx spent this output"
 * as a field on the output itself (no `consumed_by_tx`) — only a boolean
 * `is_spent`. To resolve the SPENDING tx hash (needed by the indexer's
 * classifySpend, see order-indexer.ts) this walks `address_txs` for the
 * output's own address forward from the creation block and finds the tx
 * whose inputs reference our output — the historical-order-status-display
 * path only, never the live build path (orders/takes/cancels are always
 * built from live getUtxo/getUtxosByAddress state). A parse miss here
 * degrades to "unknown" status, same as an unrecognized redeemer already
 * does for Blockfrost — it never misclassifies a fund-moving action.
 */
export class KoiosChainProvider implements ChainProvider {
  readonly name = "koios-preprod";
  readonly mesh: KoiosProvider;

  constructor(private readonly token?: string) {
    this.mesh = token
      ? new KoiosProvider("preprod", token)
      : new KoiosProvider("preprod");
  }

  private async rest<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${KOIOS_BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok)
      throw new Error(`koios ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async getUtxosByAddress(address: string, assetUnit?: string): Promise<UTxO[]> {
    try {
      return await this.mesh.fetchAddressUTxOs(address, assetUnit);
    } catch {
      return [];
    }
  }

  async getAssetAddresses(
    assetUnit: string
  ): Promise<{ address: string; quantity: string }[]> {
    const { policyId, assetName } = splitAssetUnit(assetUnit);
    const rows = await this.rest<
      { payment_address: string; quantity: string }[]
    >(`/asset_addresses?_asset_policy=${policyId}&_asset_name=${assetName}`);
    return (rows ?? []).map((r) => ({
      address: r.payment_address,
      quantity: r.quantity,
    }));
  }

  async getUtxo(txHash: string, outputIndex: number): Promise<UTxO | null> {
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
    const rows = await this.rest<KoiosUtxoInfo[]>("/utxo_info", {
      _utxo_refs: [`${txHash}#${outputIndex}`],
      _extended: true,
    });
    const out = rows?.[0];
    if (!out) return null;
    if (requireUnspent && out.is_spent) return null;
    return koiosUtxoToMeshUtxo(out);
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
    const { policyId, assetName } = splitAssetUnit(assetUnit);
    const offset = (page - 1) * 100;
    const rows = await this.rest<
      { tx_hash: string; block_height: number; block_time: number }[]
    >(
      `/asset_txs?_asset_policy=${policyId}&_asset_name=${assetName}` +
        `&_history=true&limit=100&offset=${offset}&order=block_height.desc`
    );
    return (rows ?? []).map((r) => ({
      txHash: r.tx_hash,
      blockHeight: r.block_height,
      blockTime: r.block_time,
    }));
  }

  async getTxUtxos(txHash: string): Promise<TxUtxos | null> {
    const rows = await this.rest<KoiosTxUtxos[]>("/tx_utxos", {
      _tx_hashes: [txHash],
    });
    const raw = rows?.[0];
    if (!raw) return null;

    const spentFlags = await this.batchIsSpent(
      raw.outputs.map((o) => ({ txHash: o.tx_hash, outputIndex: o.tx_index }))
    );

    const outputs: TxUtxos["outputs"] = [];
    for (const o of raw.outputs) {
      const spent = spentFlags.get(`${o.tx_hash}#${o.tx_index}`) ?? false;
      const consumedByTx = spent
        ? await this.findSpendingTx(
            o.payment_addr.bech32,
            o.tx_hash,
            o.tx_index
          )
        : null;
      outputs.push({
        address: o.payment_addr.bech32,
        amount: koiosAmount(o),
        outputIndex: o.tx_index,
        consumedByTx,
      });
    }

    return {
      hash: raw.tx_hash,
      inputs: raw.inputs.map((i) => ({
        address: i.payment_addr.bech32,
        txHash: i.tx_hash,
        outputIndex: i.tx_index,
      })),
      outputs,
    };
  }

  private async batchIsSpent(
    refs: { txHash: string; outputIndex: number }[]
  ): Promise<Map<string, boolean>> {
    if (refs.length === 0) return new Map();
    const rows = await this.rest<{ tx_hash: string; tx_index: number; is_spent: boolean }[]>(
      "/utxo_info",
      { _utxo_refs: refs.map((r) => `${r.txHash}#${r.outputIndex}`) }
    );
    const map = new Map<string, boolean>();
    for (const r of rows ?? [])
      map.set(`${r.tx_hash}#${r.tx_index}`, r.is_spent);
    return map;
  }

  /** Best-effort: walk the output's own address forward from its creation
   *  block until a tx is found that spends it. Historical-display only
   *  (docs/deployment.md §7) — never used to build a signable transaction. */
  private async findSpendingTx(
    address: string,
    txHash: string,
    outputIndex: number
  ): Promise<string | null> {
    try {
      const created = await this.rest<{ block_height: number }[]>(
        "/tx_info",
        { _tx_hashes: [txHash] }
      );
      const createdHeight = created?.[0]?.block_height ?? 0;
      const touches = await this.rest<
        { tx_hash: string; block_height: number }[]
      >("/address_txs", { _addresses: [address] });
      const candidates = (touches ?? [])
        .filter((t) => t.tx_hash !== txHash && t.block_height >= createdHeight)
        .sort((a, b) => a.block_height - b.block_height);
      for (const c of candidates) {
        const utxos = await this.rest<KoiosTxUtxos[]>("/tx_utxos", {
          _tx_hashes: [c.tx_hash],
        });
        const spendsIt = utxos?.[0]?.inputs.some(
          (i) => i.tx_hash === txHash && i.tx_index === outputIndex
        );
        if (spendsIt) return c.tx_hash;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort redeemer lookup via /tx_info's `plutus_contracts`. Koios's
   * exact nesting for spend-purpose redeemers hasn't been exhaustively
   * verified live (unlike Blockfrost's /txs/{hash}/redeemers, docs/security.md);
   * any shape this doesn't recognize is skipped rather than thrown, so a
   * parse miss shows an order as "unknown" instead of crashing or, worse,
   * misclassifying it (order-indexer.ts classifySpend already treats
   * "unknown" as a safe terminal state for display).
   */
  async getSpendRedeemerConstructor(
    txHash: string,
    scriptHash: string
  ): Promise<number | null> {
    const redeemers = await this.getSpendRedeemers(txHash);
    return redeemers.find((r) => r.scriptHash === scriptHash)?.constructor ?? null;
  }

  async getSpendRedeemers(txHash: string): Promise<SpendRedeemer[]> {
    try {
      const rows = await this.rest<KoiosTxInfo[]>("/tx_info", {
        _tx_hashes: [txHash],
      });
      const contracts = rows?.[0]?.plutus_contracts ?? [];
      const out: SpendRedeemer[] = [];
      for (const c of contracts) {
        const purpose = c.input?.purpose ?? c.purpose;
        if (purpose !== "spend") continue;
        const scriptHash = c.script_hash;
        const value = c.input?.redeemer?.datum?.value ?? c.redeemer?.datum?.value;
        const txIndex = c.input?.redeemer_index ?? c.input?.tx_index;
        if (
          !scriptHash ||
          typeof value?.constructor !== "number" ||
          typeof txIndex !== "number"
        )
          continue;
        out.push({
          txIndex,
          scriptHash,
          constructor: value.constructor,
          fields: Array.isArray(value.fields) ? value.fields : [],
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async getTip(): Promise<ChainTip> {
    const rows = await this.rest<{ abs_slot: number; block_height: number }[]>(
      "/tip"
    );
    const tip = rows?.[0];
    if (!tip) throw new Error("koios: no tip");
    return { slot: tip.abs_slot, height: tip.block_height };
  }

  async getTxConfirmations(
    txHash: string,
    tipHeight?: number
  ): Promise<number | null> {
    const rows = await this.rest<{ block_height: number }[]>("/tx_info", {
      _tx_hashes: [txHash],
    });
    const block = rows?.[0]?.block_height;
    if (block === undefined || block === null) return null;
    const height = tipHeight ?? (await this.getTip()).height;
    return Math.max(0, height - block + 1);
  }

  async submitTx(signedTxCborHex: string): Promise<string> {
    return this.mesh.submitTx(signedTxCborHex);
  }
}

function splitAssetUnit(assetUnit: string): {
  policyId: string;
  assetName: string;
} {
  return { policyId: assetUnit.slice(0, 56), assetName: assetUnit.slice(56) };
}

interface KoiosAddr {
  cred: string;
  bech32: string;
}

interface KoiosAssetEntry {
  policy_id: string;
  asset_name: string;
  quantity: string;
}

interface KoiosUtxoInfo {
  tx_hash: string;
  tx_index: number;
  address: string;
  value: string;
  datum_hash: string | null;
  inline_datum: { bytes: string | null; value: unknown } | null;
  reference_script: { hash?: string; script_hash?: string } | string | null;
  asset_list: KoiosAssetEntry[];
  is_spent: boolean;
}

interface KoiosTxUtxoEntry {
  tx_hash: string;
  tx_index: number;
  payment_addr: KoiosAddr;
  value: string;
  asset_list: KoiosAssetEntry[];
  datum_hash?: string | null;
  inline_datum?: { bytes: string | null; value: unknown } | null;
  reference_script?: { hash?: string; script_hash?: string } | string | null;
}

interface KoiosTxUtxos {
  tx_hash: string;
  inputs: KoiosTxUtxoEntry[];
  outputs: KoiosTxUtxoEntry[];
}

interface KoiosTxInfo {
  tx_hash: string;
  block_height: number;
  plutus_contracts?: {
    script_hash: string;
    purpose?: string;
    input?: {
      purpose?: string;
      tx_index?: number;
      redeemer_index?: number;
      redeemer?: { datum?: { value?: { constructor: number; fields?: unknown[] } } };
    };
    redeemer?: { datum?: { value?: { constructor: number; fields?: unknown[] } } };
  }[];
}

function koiosAmount(
  o: KoiosUtxoInfo | KoiosTxUtxoEntry
): { unit: string; quantity: string }[] {
  return [
    { unit: "lovelace", quantity: o.value },
    ...o.asset_list.map((a) => ({
      unit: `${a.policy_id}${a.asset_name}`,
      quantity: a.quantity,
    })),
  ];
}

function koiosScriptRefHash(
  ref: KoiosUtxoInfo["reference_script"]
): string | undefined {
  if (!ref) return undefined;
  if (typeof ref === "string") return ref;
  return ref.hash ?? ref.script_hash;
}

function koiosUtxoToMeshUtxo(out: KoiosUtxoInfo): UTxO {
  const scriptRef = koiosScriptRefHash(out.reference_script);
  return {
    input: { txHash: out.tx_hash, outputIndex: out.tx_index },
    output: {
      address: out.address,
      amount: koiosAmount(out),
      ...(out.datum_hash ? { dataHash: out.datum_hash } : {}),
      ...(out.inline_datum?.bytes ? { plutusData: out.inline_datum.bytes } : {}),
      ...(scriptRef ? { scriptRef } : {}),
    },
  };
}

/** Selects and constructs the configured chain provider. */
export function createChainProvider(
  name: "blockfrost" | "koios",
  key: string
): ChainProvider {
  if (name === "koios") return new KoiosChainProvider(key || undefined);
  return new BlockfrostChainProvider(key);
}
