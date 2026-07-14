import type { Pool } from "pg";
import type { Order, OrderStatus, PairId } from "../types.js";

/**
 * Order cache repository. The interface exists so tests (and dev without a
 * database) can use the in-memory implementation; PostgreSQL is the real one.
 * Parameterized queries only (docs/security.md §3).
 */

export type SpentStatus = Extract<
  OrderStatus,
  "taken" | "partially_filled" | "cancelled" | "unknown"
>;

export interface OrdersRepo {
  upsertOpenOrder(order: Order): Promise<void>;
  markSpent(
    orderId: string,
    status: SpentStatus,
    spentTxHash: string | null,
    spentAtSlot: number | null
  ): Promise<void>;
  /** v3: record that `child` is the continuation of partially-filled `parent`. */
  setLineage(
    childOrderId: string,
    parentOrderId: string,
    rootOrderId: string
  ): Promise<void>;
  /** v3: this order's lineage, if it is a continuation. */
  getLineage(
    orderId: string
  ): Promise<{ parentOrderId: string; rootOrderId: string } | null>;
  getOrder(orderId: string): Promise<Order | null>;
  listOpenOrderIds(): Promise<string[]>;
  listByPair(pairId: PairId): Promise<Order[]>;
  listByOwner(ownerStakeCredential: string): Promise<Order[]>;
  listPairs(): Promise<PairId[]>;
  getCursor(): Promise<number>;
  setCursor(slot: number): Promise<void>;
}

// ------------------------------------------------------------------ memory

export class MemoryOrdersRepo implements OrdersRepo {
  private orders = new Map<string, Order>();
  private lineage = new Map<
    string,
    { parentOrderId: string; rootOrderId: string }
  >();
  private cursor = 0;

  async upsertOpenOrder(order: Order): Promise<void> {
    const l = this.lineage.get(order.orderId);
    this.orders.set(order.orderId, {
      ...order,
      status: "open",
      ...(l ?? {}),
    });
  }

  async markSpent(
    orderId: string,
    status: SpentStatus,
    spentTxHash: string | null,
    spentAtSlot: number | null
  ): Promise<void> {
    const existing = this.orders.get(orderId);
    if (existing) {
      this.orders.set(orderId, {
        ...existing,
        status,
        ...(spentTxHash !== null ? { spentTxHash } : {}),
        ...(spentAtSlot !== null ? { spentAtSlot } : {}),
      });
    }
  }

  async setLineage(
    childOrderId: string,
    parentOrderId: string,
    rootOrderId: string
  ): Promise<void> {
    this.lineage.set(childOrderId, { parentOrderId, rootOrderId });
    const child = this.orders.get(childOrderId);
    if (child)
      this.orders.set(childOrderId, { ...child, parentOrderId, rootOrderId });
  }

  async getLineage(
    orderId: string
  ): Promise<{ parentOrderId: string; rootOrderId: string } | null> {
    return this.lineage.get(orderId) ?? null;
  }

  async getOrder(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) ?? null;
  }

  async listOpenOrderIds(): Promise<string[]> {
    return [...this.orders.values()]
      .filter((o) => o.status === "open")
      .map((o) => o.orderId);
  }

  async listByPair(pairId: PairId): Promise<Order[]> {
    return [...this.orders.values()].filter(
      (o) => o.pairId === pairId && o.status === "open"
    );
  }

  async listByOwner(owner: string): Promise<Order[]> {
    // Most recent transaction first — mirrors PgOrdersRepo's ordering.
    return [...this.orders.values()]
      .filter((o) => o.ownerStakeCredential === owner)
      .sort(
        (a, b) =>
          (b.spentAtSlot ?? b.createdAtSlot ?? 0) -
          (a.spentAtSlot ?? a.createdAtSlot ?? 0)
      );
  }

  async listPairs(): Promise<PairId[]> {
    return [
      ...new Set(
        [...this.orders.values()]
          .filter((o) => o.status === "open")
          .map((o) => o.pairId)
      ),
    ].sort();
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async setCursor(slot: number): Promise<void> {
    this.cursor = slot;
  }
}

// ---------------------------------------------------------------- postgres

function rowToOrder(r: Record<string, unknown>): Order {
  return {
    orderId: r.order_id as string,
    txHash: r.tx_hash as string,
    outputIndex: r.output_index as number,
    status: r.status as OrderStatus,
    pairId: r.pair_id as string,
    contractAddress: r.contract_address as string,
    ownerStakeCredential: r.owner_stake_credential as string,
    paymentAddress: r.payment_address as string,
    offeredPolicyId: r.offered_policy_id as string,
    offeredAssetName: r.offered_asset_name as string,
    offeredAmount: String(r.offered_amount),
    requestedPolicyId: r.requested_policy_id as string,
    requestedAssetName: r.requested_asset_name as string,
    requestedAmount: String(r.requested_amount),
    depositLovelace: String(r.deposit_lovelace),
    pairBeacon: r.pair_beacon as string,
    offerBeacon: r.offer_beacon as string,
    askBeacon: r.ask_beacon as string,
    ownerBeacon: r.owner_beacon as string,
    ...(r.expiration_posix_ms != null
      ? { expiration: Number(r.expiration_posix_ms) }
      : {}),
    version: r.version as number,
    allowPartialFill: Boolean(r.allow_partial_fill),
    ...(r.parent_order_id != null
      ? { parentOrderId: r.parent_order_id as string }
      : {}),
    ...(r.root_order_id != null
      ? { rootOrderId: r.root_order_id as string }
      : {}),
    ...(r.created_at_slot != null
      ? { createdAtSlot: Number(r.created_at_slot) }
      : {}),
    ...(r.spent_at_slot != null ? { spentAtSlot: Number(r.spent_at_slot) } : {}),
    ...(r.created_tx_hash != null
      ? { createdTxHash: r.created_tx_hash as string }
      : {}),
    ...(r.spent_tx_hash != null
      ? { spentTxHash: r.spent_tx_hash as string }
      : {}),
  };
}

export class PgOrdersRepo implements OrdersRepo {
  constructor(
    private readonly db: Pool,
    private readonly inlineDatums = new Map<string, string>()
  ) {}

  /** Called by the indexer with the raw datum so re-verification is possible. */
  async upsertOpenOrderWithDatum(order: Order, datumCbor: string): Promise<void> {
    this.inlineDatums.set(order.orderId, datumCbor);
    await this.upsertOpenOrder(order);
  }

  async upsertOpenOrder(order: Order): Promise<void> {
    const [assetA, assetB] = order.pairId.split("_");
    // Referenced rows first (idempotent).
    for (const [assetId, policy, name] of [
      [
        order.offeredPolicyId === ""
          ? "lovelace"
          : `${order.offeredPolicyId}.${order.offeredAssetName}`,
        order.offeredPolicyId,
        order.offeredAssetName,
      ],
      [
        order.requestedPolicyId === ""
          ? "lovelace"
          : `${order.requestedPolicyId}.${order.requestedAssetName}`,
        order.requestedPolicyId,
        order.requestedAssetName,
      ],
    ]) {
      await this.db.query(
        `INSERT INTO assets (asset_id, policy_id, asset_name_hex)
         VALUES ($1,$2,$3) ON CONFLICT (asset_id) DO NOTHING`,
        [assetId, policy, name]
      );
    }
    await this.db.query(
      `INSERT INTO pairs (pair_id, asset_a, asset_b, pair_beacon_name, first_seen_slot)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (pair_id) DO NOTHING`,
      [order.pairId, assetA, assetB, order.pairBeacon, order.createdAtSlot ?? null]
    );
    await this.db.query(
      `INSERT INTO orders (
         order_id, tx_hash, output_index, status, version, allow_partial_fill,
         pair_id, contract_address, owner_stake_credential, payment_address,
         offered_policy_id, offered_asset_name, offered_amount,
         requested_policy_id, requested_asset_name, requested_amount,
         deposit_lovelace, pair_beacon, offer_beacon, ask_beacon, owner_beacon,
         expiration_posix_ms, inline_datum_cbor, created_at_slot, created_tx_hash
       ) VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (order_id) DO UPDATE SET status = 'open', updated_at = now()`,
      [
        order.orderId,
        order.txHash,
        order.outputIndex,
        order.version,
        order.allowPartialFill,
        order.pairId,
        order.contractAddress,
        order.ownerStakeCredential,
        order.paymentAddress,
        order.offeredPolicyId,
        order.offeredAssetName,
        order.offeredAmount,
        order.requestedPolicyId,
        order.requestedAssetName,
        order.requestedAmount,
        order.depositLovelace,
        order.pairBeacon,
        order.offerBeacon,
        order.askBeacon,
        order.ownerBeacon,
        order.expiration ?? null,
        this.inlineDatums.get(order.orderId) ?? "",
        order.createdAtSlot ?? null,
        order.createdTxHash ?? order.txHash,
      ]
    );
  }

  async markSpent(
    orderId: string,
    status: SpentStatus,
    spentTxHash: string | null,
    spentAtSlot: number | null
  ): Promise<void> {
    await this.db.query(
      `UPDATE orders SET status = $2, spent_tx_hash = $3, spent_at_slot = $4,
       updated_at = now() WHERE order_id = $1`,
      [orderId, status, spentTxHash, spentAtSlot]
    );
    const action =
      status === "taken"
        ? "take"
        : status === "partially_filled"
          ? "take-partial"
          : status === "cancelled"
            ? "cancel"
            : "unknown-spend";
    await this.db.query(
      `INSERT INTO tx_history (tx_hash, order_id, action, slot)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [spentTxHash ?? "unknown", orderId, action, spentAtSlot]
    );
  }

  async setLineage(
    childOrderId: string,
    parentOrderId: string,
    rootOrderId: string
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO order_lineage (child_order_id, parent_order_id, root_order_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [childOrderId, parentOrderId, rootOrderId]
    );
  }

  async getLineage(
    orderId: string
  ): Promise<{ parentOrderId: string; rootOrderId: string } | null> {
    const res = await this.db.query(
      `SELECT parent_order_id, root_order_id FROM order_lineage WHERE child_order_id = $1`,
      [orderId]
    );
    return res.rows[0]
      ? {
          parentOrderId: res.rows[0].parent_order_id as string,
          rootOrderId: res.rows[0].root_order_id as string,
        }
      : null;
  }

  /** orders LEFT JOINed with lineage, so Order rows carry parent/root ids. */
  private static readonly SELECT = `
    SELECT o.*, l.parent_order_id, l.root_order_id
    FROM orders o LEFT JOIN order_lineage l ON l.child_order_id = o.order_id`;

  async getOrder(orderId: string): Promise<Order | null> {
    const res = await this.db.query(
      `${PgOrdersRepo.SELECT} WHERE o.order_id = $1`,
      [orderId]
    );
    return res.rows[0] ? rowToOrder(res.rows[0]) : null;
  }

  async listOpenOrderIds(): Promise<string[]> {
    const res = await this.db.query(
      `SELECT order_id FROM orders WHERE status = 'open'`
    );
    return res.rows.map((r) => r.order_id as string);
  }

  async listByPair(pairId: PairId): Promise<Order[]> {
    const res = await this.db.query(
      `${PgOrdersRepo.SELECT} WHERE o.pair_id = $1 AND o.status = 'open'
       ORDER BY o.created_at_slot ASC NULLS LAST`,
      [pairId]
    );
    return res.rows.map(rowToOrder);
  }

  async listByOwner(owner: string): Promise<Order[]> {
    // Most recent transaction first — an order's "last transaction" is
    // whichever is newer of its creation or its spend (take/cancel).
    const res = await this.db.query(
      `${PgOrdersRepo.SELECT} WHERE o.owner_stake_credential = $1
       ORDER BY COALESCE(o.spent_at_slot, o.created_at_slot) DESC NULLS LAST`,
      [owner]
    );
    return res.rows.map(rowToOrder);
  }

  async listPairs(): Promise<PairId[]> {
    const res = await this.db.query(
      `SELECT DISTINCT pair_id FROM orders WHERE status = 'open' ORDER BY pair_id`
    );
    return res.rows.map((r) => r.pair_id as string);
  }

  async getCursor(): Promise<number> {
    const res = await this.db.query(
      `SELECT synced_to_slot FROM indexer_cursor WHERE id = true`
    );
    return res.rows[0] ? Number(res.rows[0].synced_to_slot) : 0;
  }

  async setCursor(slot: number): Promise<void> {
    await this.db.query(
      `UPDATE indexer_cursor SET synced_to_slot = $1, updated_at = now() WHERE id = true`,
      [slot]
    );
  }
}
