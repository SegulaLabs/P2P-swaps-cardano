import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { UTxO } from "@meshsdk/core";
import type { AppDeps } from "../app.js";
import { BuildError, type WalletContext } from "../services/tx-builder.js";

/**
 * POST /tx/create-order | /tx/cancel-order | /tx/take-order
 *      | /tx/take-many-orders (v2: one ATOMIC tx for up to N orders)
 *   -> { unsignedTxCborHex, summary }   (UNSIGNED, always — the wallet signs)
 * POST /tx/update-order -> 501 (postponed per mvp-contract-decisions.md §7)
 * GET  /tx/:txHash/status -> confirmations
 */

const bigintStr = z
  .string()
  .regex(/^[0-9]+$/, "stringified positive integer expected");

const assetId = z
  .string()
  .regex(/^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/, "asset id expected");

const meshUtxo = z.object({
  input: z.object({ txHash: z.string(), outputIndex: z.number().int() }),
  output: z.object({
    address: z.string(),
    amount: z.array(z.object({ unit: z.string(), quantity: z.string() })),
  }),
});

const walletSchema = z.object({
  changeAddress: z.string().min(1),
  utxos: z.array(meshUtxo).min(1),
  collateral: meshUtxo.optional(),
});

const createOrderBody = z.object({
  wallet: walletSchema,
  paymentAddress: z.string().min(1).optional(),
  offerAsset: assetId,
  offerAmount: bigintStr,
  askAsset: assetId,
  askAmount: bigintStr,
  expiration: z.number().int().positive().optional(),
  /** v3: opt the order into partial fills (docs/partial-fills.md). */
  allowPartialFill: z.boolean().optional(),
});

const orderIdSchema = z.string().regex(/^[0-9a-f]{64}#[0-9]+$/);

const orderActionBody = z.object({
  wallet: walletSchema,
  orderId: orderIdSchema,
});

/** take-order: optional v3 partial amount (absent = full fill). */
const takeOrderBody = orderActionBody.extend({
  takeAmount: bigintStr.optional(),
});

const takeLegSchema = z.object({
  orderId: orderIdSchema,
  takeAmount: bigintStr.optional(),
});

// Loose upper bound only — the real batch cap (MAX_ORDERS_PER_TX) is
// enforced by the tx builder with a descriptive error. Accepts the v3
// `orders` shape (per-leg optional takeAmount) and the legacy v2 `orderIds`
// shape (all full fills) during rollout.
const takeManyBody = z.union([
  z.object({
    wallet: walletSchema,
    orders: z.array(takeLegSchema).min(1).max(50),
  }),
  z.object({
    wallet: walletSchema,
    orderIds: z.array(orderIdSchema).min(1).max(50),
  }),
]);

function toWallet(w: z.infer<typeof walletSchema>): WalletContext {
  return {
    changeAddress: w.changeAddress,
    utxos: w.utxos as unknown as UTxO[],
    ...(w.collateral ? { collateral: w.collateral as unknown as UTxO } : {}),
  };
}

const BUILD_ERROR_STATUS: Record<BuildError["code"], number> = {
  invalid_request: 400,
  order_not_found: 404,
  order_expired: 409,
  not_an_order: 422,
  provider_unavailable: 503,
  insufficient_funds: 422,
};

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof BuildError)
    return reply
      .code(BUILD_ERROR_STATUS[err.code])
      .send({ error: err.code, detail: err.message });
  if (err instanceof z.ZodError)
    return reply
      .code(400)
      .send({ error: "invalid_request", detail: err.flatten() });
  throw err;
}

export async function txRoutes(
  app: FastifyInstance,
  { deps }: { deps: AppDeps }
) {
  const requireBuilder = (reply: FastifyReply) => {
    if (!deps.txBuilder) {
      reply.code(503).send({
        error: "provider_unavailable",
        detail:
          "tx building requires BLOCKFROST_PROJECT_ID_PREPROD to be configured",
      });
      return null;
    }
    return deps.txBuilder;
  };

  app.post("/tx/create-order", async (req, reply) => {
    try {
      const body = createOrderBody.parse(req.body);
      const builder = requireBuilder(reply);
      if (!builder) return;
      return await builder.buildCreateOrder({
        wallet: toWallet(body.wallet),
        ...(body.paymentAddress ? { paymentAddress: body.paymentAddress } : {}),
        offerAsset: body.offerAsset,
        offerAmount: BigInt(body.offerAmount),
        askAsset: body.askAsset,
        askAmount: BigInt(body.askAmount),
        ...(body.expiration !== undefined
          ? { expiration: body.expiration }
          : {}),
        ...(body.allowPartialFill !== undefined
          ? { allowPartialFill: body.allowPartialFill }
          : {}),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/tx/cancel-order", async (req, reply) => {
    try {
      const body = orderActionBody.parse(req.body);
      const builder = requireBuilder(reply);
      if (!builder) return;
      return await builder.buildCancelOrder({
        wallet: toWallet(body.wallet),
        orderId: body.orderId,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/tx/take-order", async (req, reply) => {
    try {
      const body = takeOrderBody.parse(req.body);
      const builder = requireBuilder(reply);
      if (!builder) return;
      return await builder.buildTakeOrder({
        wallet: toWallet(body.wallet),
        orderId: body.orderId,
        ...(body.takeAmount !== undefined
          ? { takeAmount: BigInt(body.takeAmount) }
          : {}),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // v2 (docs/take-many-orders.md): take up to MAX_ORDERS_PER_TX orders in
  // ONE atomic transaction — all fill together or none do. v3: legs may be
  // partial fills (docs/partial-fills.md).
  app.post("/tx/take-many-orders", async (req, reply) => {
    try {
      const body = takeManyBody.parse(req.body);
      const builder = requireBuilder(reply);
      if (!builder) return;
      const orders =
        "orders" in body
          ? body.orders.map((o) => ({
              orderId: o.orderId,
              ...(o.takeAmount !== undefined
                ? { takeAmount: BigInt(o.takeAmount) }
                : {}),
            }))
          : body.orderIds.map((orderId) => ({ orderId }));
      return await builder.buildTakeManyOrders({
        wallet: toWallet(body.wallet),
        orders,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/tx/update-order", async (_req, reply) => {
    return reply.code(501).send({
      error: "UpdateOrder is postponed for MVP. Cancel and recreate instead.",
      detail: "docs/mvp-contract-decisions.md §7",
    });
  });

  app.get<{ Params: { txHash: string } }>(
    "/tx/:txHash/status",
    async (req, reply) => {
      if (!deps.provider)
        return reply
          .code(503)
          .send({ error: "provider_unavailable" });
      if (!/^[0-9a-f]{64}$/.test(req.params.txHash))
        return reply.code(400).send({ error: "invalid tx hash" });
      const confirmations = await deps.provider.getTxConfirmations(
        req.params.txHash
      );
      return {
        txHash: req.params.txHash,
        found: confirmations !== null,
        confirmations: confirmations ?? 0,
      };
    }
  );
}
