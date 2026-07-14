import {
  deserializeAddress,
  pubKeyAddress,
  serializeAddressObj,
  type UTxO,
} from "@meshsdk/core";
import type { ChainProvider } from "./chain-provider.js";
import type { OrdersRepo } from "../db/orders-repo.js";
import { decodeOrderDatum } from "../protocol/datum.js";
import {
  ORDER_BEACON_NAME_HEX,
  deriveBeaconNames,
  isAda,
  toApiAssetId,
  toPairId,
} from "../protocol/beacons.js";
import type { Order } from "../types.js";

/**
 * Order indexer — keeps the PostgreSQL cache in sync with on-chain orders.
 * The cache is a UX convenience; THE CHAIN IS THE SOURCE OF TRUTH — the
 * tx-builder re-fetches and re-validates every order UTxO at build time.
 *
 * Strategy (docs/beacons.md §4):
 *  1. All OrderBeacon holders -> candidate order UTxOs.
 *  2. VERIFY each candidate before caching (address = validator + owner
 *     stake, exact 5-beacon set with re-derived names, well-formed datum,
 *     offered asset present). Drop anything that fails — garbage or attack.
 *  3. Upsert open orders (after INDEXER_CONFIRMATIONS confirmations).
 *  4. Cached-open orders that vanished from the UTxO set are classified
 *     taken/cancelled by inspecting the consuming tx (found via the order's
 *     OwnerBeacon asset-transaction history); 'unknown' when unclassifiable.
 */

export interface IndexerOptions {
  beaconPolicyId: string;
  orderValidatorHash: string;
  confirmations: number;
  pollMs: number;
  /** Floor between chain-hitting syncs triggered on demand (e.g. a frontend
   *  "Refresh" button) — stops rapid clicks from re-burning provider quota. */
  minReindexIntervalMs?: number;
  log?: (msg: string) => void;
}

export class OrderIndexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSyncCompletedAt = 0;

  constructor(
    private readonly provider: ChainProvider,
    private readonly repo: OrdersRepo,
    private readonly opts: IndexerOptions
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      this.syncOnce().catch((e) =>
        this.opts.log?.(`indexer sync failed: ${String(e)}`)
      );
    };
    tick();
    this.timer = setInterval(tick, this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async syncOnce(): Promise<{ open: number; spent: number }> {
    if (this.running) return { open: 0, spent: 0 }; // no overlapping syncs
    this.running = true;
    try {
      const result = await this.doSync();
      this.lastSyncCompletedAt = Date.now();
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * On-demand sync for a user-triggered "Refresh" (docs: the frontend no
   * longer polls — this plus a slow background `pollMs` timer are the only
   * two things that hit the chain). Cooldown-gated so repeated clicks (or a
   * scripted loop) can't turn a manual refresh into the same continuous
   * request volume the background timer used to produce.
   */
  async triggerSync(): Promise<{
    open: number;
    spent: number;
    skipped: boolean;
  }> {
    const minInterval = this.opts.minReindexIntervalMs ?? 20_000;
    if (Date.now() - this.lastSyncCompletedAt < minInterval) {
      return { open: 0, spent: 0, skipped: true };
    }
    const result = await this.syncOnce();
    return { ...result, skipped: false };
  }

  /**
   * One-time REPAIR pass, separate from the regular sync loop: for every
   * currently-open order that has no recorded lineage, retry
   * backfillAncestry(). The regular sync only ever attempts this once, at
   * first discovery (`!cached` in doSync) — cheap and correct for every order
   * discovered AFTER this capability existed, but it can't retroactively fix
   * rows that were already cached (without lineage) by an older process.
   * Scoped to `allowPartialFill` orders only, since a continuation's flag is
   * always true (the reduced datum is byte-identical to its parent's except
   * the two amounts — docs/partial-fills.md §2) — a plain non-partial order
   * can never be one, so this skips them for free. NOT wired into the
   * periodic timer or the "Refresh" button: call it once after deploying
   * this capability (or after restoring a cache from backup); every order it
   * fixes is then correct forever via the regular sync path.
   */
  async repairLineage(): Promise<{ checked: number; repaired: number }> {
    const tip = await this.provider.getTip();
    let checked = 0;
    let repaired = 0;
    for (const orderId of await this.repo.listOpenOrderIds()) {
      const order = await this.repo.getOrder(orderId);
      if (!order || !order.allowPartialFill) continue;
      if (await this.repo.getLineage(orderId)) continue;
      checked += 1;
      await this.backfillAncestry(order, tip.slot);
      if (await this.repo.getLineage(orderId)) repaired += 1;
    }
    this.opts.log?.(
      `lineage repair: checked ${checked} partial-enabled open order(s), recovered lineage for ${repaired}`
    );
    return { checked, repaired };
  }

  private async doSync(): Promise<{ open: number; spent: number }> {
    const tip = await this.provider.getTip();
    const orderBeaconUnit = this.opts.beaconPolicyId + ORDER_BEACON_NAME_HEX;

    // 1. discover candidates
    const holders = await this.provider.getAssetAddresses(orderBeaconUnit);
    const seenOpen = new Set<string>();
    let openCount = 0;

    for (const holder of holders) {
      const utxos = await this.provider.getUtxosByAddress(
        holder.address,
        orderBeaconUnit
      );
      for (const utxo of utxos) {
        const order = this.validateAndMap(utxo);
        if (!order) continue;
        seenOpen.add(order.orderId);

        // An order UTxO is immutable until spent, so once it's cached as
        // open with enough confirmations nothing about it can change —
        // re-verifying it against the chain on every pass is pure waste.
        const cached = await this.repo.getOrder(order.orderId);
        if (cached?.status === "open") {
          openCount += 1;
          continue;
        }

        const confirmations = await this.provider.getTxConfirmations(
          order.txHash,
          tip.height
        );
        if (confirmations === null || confirmations < this.opts.confirmations)
          continue; // too fresh — pick it up next pass
        order.createdAtSlot = tip.slot; // best-effort; refined post-MVP
        await this.repo.upsertOpenOrder(order);
        openCount += 1;

        // First time this order has ever been cached: if it's actually a
        // partial-fill CONTINUATION whose parent got spent before this
        // process/DB ever observed it as open (e.g. after a cache reset —
        // docs/partial-fills.md §4), its lineage is otherwise lost forever,
        // since normal classification only runs on orders that were
        // previously cached as open. Recover it from on-chain history.
        if (!cached) {
          await this.backfillAncestry(order, tip.slot);
        }
      }
    }

    // 2. cached-open orders that vanished were spent — classify them
    let spentCount = 0;
    for (const orderId of await this.repo.listOpenOrderIds()) {
      if (seenOpen.has(orderId)) continue;
      const cached = await this.repo.getOrder(orderId);
      if (!cached) continue;
      const { status, txHash, childOrderId } = await this.classifySpend(cached);
      await this.repo.markSpent(orderId, status, txHash, null);
      // v3: a partial fill spends the parent AND creates a continuation in ONE
      // tx. Link the continuation's lineage, then surface it IMMEDIATELY —
      // without waiting for the normal discovery pass to clear
      // INDEXER_CONFIRMATIONS. Otherwise the parent leaves the open book the
      // moment its spend is seen while the continuation (same tx) needs extra
      // confirmations to appear, so the seller's remaining liquidity blinks
      // out of the book for a confirmation window. We already trusted this tx
      // enough to mark the parent spent; the continuation rides the same
      // trust, and a reorg self-heals on the next pass (the parent reappears,
      // the child vanishes).
      if (status === "partially_filled" && childOrderId) {
        const parent = await this.repo.getLineage(orderId);
        await this.repo.setLineage(
          childOrderId,
          orderId,
          parent?.rootOrderId ?? orderId
        );
        if (!seenOpen.has(childOrderId)) {
          const [childTxHash, childIndex] = childOrderId.split("#");
          const childUtxo = await this.provider.getUtxo(
            childTxHash!,
            Number(childIndex)
          );
          const childOrder = childUtxo ? this.validateAndMap(childUtxo) : null;
          if (childOrder) {
            childOrder.createdAtSlot = tip.slot;
            await this.repo.upsertOpenOrder(childOrder);
            seenOpen.add(childOrderId);
            openCount += 1;
          }
        }
      }
      spentCount += 1;
    }

    await this.repo.setCursor(tip.slot);
    this.opts.log?.(
      `indexer: ${openCount} open upserted, ${spentCount} spends classified, tip slot ${tip.slot}`
    );
    return { open: openCount, spent: spentCount };
  }

  /**
   * Reconstruct partial-fill lineage retroactively for an order this process
   * has NEVER cached before (called only when `!cached` in doSync step 1).
   * Runs the SAME rank-pairing the validator enforces (docs/partial-fills.md
   * §3), but backward: instead of a parent looking up its designated
   * continuation, `order` looks up whether the tx that CREATED it consumed
   * an order-validator input under TakeOrderPartial, and if so, which one is
   * its own parent. That parent is very possibly already spent and was never
   * itself cached — but its creation output (address, value, inline datum)
   * is permanent on-chain history, so it's fully recoverable via
   * getTxOutput() (which, unlike getUtxo(), doesn't filter out spent
   * outputs). Walks up to a genuine root (a CreateOrder, not a
   * TakeOrderPartial continuation) or an already-linked ancestor, then
   * writes the whole recovered chain root-to-tip so every link's `root_order_id`
   * is correct. Best-effort: any inability to resolve a step just stops the
   * walk there — the order still shows as a normal (unlinked) open order,
   * exactly as it did before this method existed.
   */
  private async backfillAncestry(order: Order, tipSlot: number): Promise<void> {
    const orderBeaconUnit = this.opts.beaconPolicyId + ORDER_BEACON_NAME_HEX;
    const chain: { child: Order; parent: Order; spendTx: string }[] = [];
    let node = order;
    let rootId: string | null = null;

    try {
      for (let depth = 0; depth < 64; depth++) {
        const existing = await this.repo.getLineage(node.orderId);
        if (existing) {
          rootId = existing.rootOrderId;
          break;
        }

        const creatingTx = await this.provider.getTxUtxos(node.txHash);
        if (!creatingTx) {
          rootId = node.orderId;
          break;
        }
        const redeemers = await this.provider.getSpendRedeemers(node.txHash);
        const partialInputIdxs = redeemers
          .filter(
            (r) =>
              r.scriptHash === this.opts.orderValidatorHash &&
              r.constructor === 2
          )
          .map((r) => r.txIndex)
          .sort((a, b) => a - b);
        if (partialInputIdxs.length === 0) {
          rootId = node.orderId; // a genuine CreateOrder — no parent
          break;
        }

        const continuations = creatingTx.outputs
          .filter((o) =>
            o.amount.some(
              (a) => a.unit === orderBeaconUnit && BigInt(a.quantity) > 0n
            )
          )
          .sort((a, b) => a.outputIndex - b.outputIndex);
        const rank = continuations.findIndex(
          (o) => o.outputIndex === node.outputIndex
        );
        const parentInput =
          rank >= 0 && rank < partialInputIdxs.length
            ? creatingTx.inputs[partialInputIdxs[rank]!]
            : undefined;
        if (!parentInput) {
          rootId = node.orderId; // can't establish rank — stop, treat as root
          break;
        }

        const parentUtxo = await this.provider.getTxOutput(
          parentInput.txHash,
          parentInput.outputIndex
        );
        const parentOrder = parentUtxo ? this.validateAndMap(parentUtxo) : null;
        if (!parentOrder) {
          rootId = node.orderId; // not a valid protocol order — stop here
          break;
        }

        chain.push({ child: node, parent: parentOrder, spendTx: node.txHash });
        node = parentOrder;
      }
    } catch (e) {
      this.opts.log?.(
        `lineage backfill failed for ${order.orderId}: ${String(e)}`
      );
      return;
    }
    if (chain.length === 0 || rootId === null) return;

    // Write root -> tip so each parent exists before its child references it
    // (order_lineage has no FK, but tx_history.order_id does — see markSpent).
    for (let i = chain.length - 1; i >= 0; i--) {
      const { child, parent, spendTx } = chain[i]!;
      parent.createdAtSlot = tipSlot;
      await this.repo.upsertOpenOrder(parent);
      await this.repo.markSpent(parent.orderId, "partially_filled", spendTx, null);
      await this.repo.setLineage(child.orderId, parent.orderId, rootId);
    }
    this.opts.log?.(
      `lineage backfill: recovered ${chain.length} ancestor(s) for ${order.orderId} (root ${rootId})`
    );
  }

  /** Steps 2 of the strategy: full off-chain re-verification. */
  validateAndMap(utxo: UTxO): Order | null {
    try {
      const addr = deserializeAddress(utxo.output.address);
      if (addr.scriptHash !== this.opts.orderValidatorHash) return null;
      if (!utxo.output.plutusData) return null;

      const datum = decodeOrderDatum(utxo.output.plutusData);
      if (datum.beaconPolicyId !== this.opts.beaconPolicyId) return null;
      // CIP-89 address: staking credential must be the datum owner.
      if (addr.stakeCredentialHash !== datum.ownerKeyHash) return null;

      const names = deriveBeaconNames(
        datum.offer,
        datum.ask,
        datum.ownerKeyHash
      );
      const amount = utxo.output.amount;
      const qty = (unit: string) =>
        BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");
      for (const name of Object.values(names)) {
        if (qty(this.opts.beaconPolicyId + name) !== 1n) return null;
      }

      const lovelace = qty("lovelace");
      let deposit: bigint;
      if (isAda(datum.offer)) {
        if (lovelace < datum.offerAmount) return null;
        deposit = lovelace - datum.offerAmount;
      } else {
        const offerUnit = datum.offer.policyId + datum.offer.assetNameHex;
        if (qty(offerUnit) < datum.offerAmount) return null;
        deposit = lovelace;
      }

      const paymentAddress = this.paymentAddressBech32(datum);
      return {
        orderId: `${utxo.input.txHash}#${utxo.input.outputIndex}`,
        txHash: utxo.input.txHash,
        outputIndex: utxo.input.outputIndex,
        status: "open",
        pairId: toPairId(datum.offer, datum.ask),
        contractAddress: utxo.output.address,
        ownerStakeCredential: datum.ownerKeyHash,
        paymentAddress,
        offeredPolicyId: datum.offer.policyId,
        offeredAssetName: datum.offer.assetNameHex,
        offeredAmount: datum.offerAmount.toString(),
        requestedPolicyId: datum.ask.policyId,
        requestedAssetName: datum.ask.assetNameHex,
        requestedAmount: datum.askAmount.toString(),
        depositLovelace: deposit.toString(),
        pairBeacon: names.pair,
        offerBeacon: names.offer,
        askBeacon: names.ask,
        ownerBeacon: names.owner,
        ...(datum.expiration !== null ? { expiration: datum.expiration } : {}),
        version: datum.version,
        allowPartialFill: datum.allowPartialFill,
        createdTxHash: utxo.input.txHash,
      };
    } catch {
      return null; // malformed datum/address => not a protocol order
    }
  }

  private paymentAddressBech32(datum: {
    paymentPubKeyHash: string;
    paymentStakeKeyHash: string | null;
  }): string {
    return serializeAddressObj(
      pubKeyAddress(
        datum.paymentPubKeyHash,
        datum.paymentStakeKeyHash ?? undefined,
        false
      ),
      0
    );
  }

  /**
   * Find the consuming tx via consumed_by_tx on the order's own creation
   * output, then classify by reading the ACTUAL redeemer used against THIS
   * order's input: CancelOrder=0, TakeOrder=1, TakeOrderPartial=2
   * (contracts/lib/p2p_dex/types.ak — first constructor is 0).
   *
   * v3: redeemers are matched PER INPUT (tx_index = the input's position in
   * the consuming tx's canonically-sorted input list), because one mixed
   * batch spends several order inputs under DIFFERENT redeemers. For a
   * partial fill the continuation is located by the SAME rank pairing the
   * validator enforces (docs/partial-fills.md §3): this input's rank among
   * TakeOrderPartial order-inputs picks the rank-th OrderBeacon-bearing
   * output of the consuming tx.
   *
   * LIVE FINDINGS from two superseded approaches, kept as history:
   *  1. Searching the OwnerBeacon's asset-transaction history
   *     (`GET /assets/{unit}/transactions`) NEVER finds take/cancel txs —
   *     confirmed live that Blockfrost's asset-transactions index only
   *     lists transactions where the asset appears in an OUTPUT
   *     (mints/transfers); a tx that purely BURNS it (no beacon output) is
   *     absent entirely, not just delayed.
   *  2. Guessing taken-vs-cancelled from payment shape ("did an output pay
   *     >= ask_amount of the ask asset to payment_address") produces false
   *     positives: confirmed live that a self-cancel (owner's own address
   *     used as payment_address, the common default) can have its returned
   *     deposit alone exceed a modest ask_amount in the same asset,
   *     misclassifying a real Cancel as Taken. The redeemer constructor is
   *     unambiguous and needs no such guessing.
   */
  private async classifySpend(order: Order): Promise<{
    status: "taken" | "partially_filled" | "cancelled" | "unknown";
    txHash: string | null;
    /** The continuation order's id, when the spend was a partial fill. */
    childOrderId?: string;
  }> {
    try {
      const created = await this.provider.getTxUtxos(order.txHash);
      const out = created?.outputs[order.outputIndex];
      if (!out || out.consumedByTx === null)
        return { status: "unknown", txHash: null };
      const spendTx = out.consumedByTx;

      const consuming = await this.provider.getTxUtxos(spendTx);
      const inputIdx =
        consuming?.inputs.findIndex(
          (i) => i.txHash === order.txHash && i.outputIndex === order.outputIndex
        ) ?? -1;
      const redeemers = await this.provider.getSpendRedeemers(spendTx);
      const entry = redeemers.find((r) => r.txIndex === inputIdx);
      if (!consuming || inputIdx < 0 || !entry)
        return { status: "unknown", txHash: spendTx };

      if (entry.constructor === 0)
        return { status: "cancelled", txHash: spendTx };
      if (entry.constructor === 1) return { status: "taken", txHash: spendTx };
      if (entry.constructor !== 2)
        return { status: "unknown", txHash: spendTx };

      // Partial fill: rank pairing, exactly as the validator computes it.
      const partialInputIdxs = redeemers
        .filter(
          (r) =>
            r.scriptHash === this.opts.orderValidatorHash &&
            r.constructor === 2
        )
        .map((r) => r.txIndex)
        .sort((a, b) => a - b);
      const rank = partialInputIdxs.indexOf(inputIdx);
      const orderBeaconUnit =
        this.opts.beaconPolicyId + ORDER_BEACON_NAME_HEX;
      const continuations = consuming.outputs.filter((o) =>
        o.amount.some((a) => a.unit === orderBeaconUnit && BigInt(a.quantity) > 0n)
      );
      const child = rank >= 0 ? continuations[rank] : undefined;
      return {
        status: "partially_filled",
        txHash: spendTx,
        ...(child ? { childOrderId: `${spendTx}#${child.outputIndex}` } : {}),
      };
    } catch {
      return { status: "unknown", txHash: null };
    }
  }
}
