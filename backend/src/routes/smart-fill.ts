import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { pairIdOf, planSmartFill } from "../services/smart-fill.js";

/**
 * GET /smart-fill?spendAsset=&receiveAsset=&(maxSpend=|minReceive=)
 *   -> SmartFillRoute (route PREVIEW only — see docs/smart-fill.md)
 *
 * Bidirectional: pass EXACTLY ONE of `maxSpend` (fill within a spend budget) or
 * `minReceive` (fill until a target receive amount is met). Off-chain routing
 * over EXISTING full orders — reuses the same order cache as the order book
 * (OrdersRepo.listByPair) and the pure planner in services/smart-fill.ts.
 * Returns a non-atomic route the client executes as a sequence of unchanged
 * MVP TakeOrder transactions.
 */

const assetId = z
  .string()
  .regex(/^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/, "asset id expected");

const bigintStr = z
  .string()
  .regex(/^[0-9]+$/, "stringified positive integer expected");

const query = z
  .object({
    spendAsset: assetId,
    receiveAsset: assetId,
    maxSpend: bigintStr.optional(),
    minReceive: bigintStr.optional(),
  })
  .refine((q) => q.spendAsset !== q.receiveAsset, {
    message: "spendAsset and receiveAsset must differ",
  })
  .refine((q) => (q.maxSpend === undefined) !== (q.minReceive === undefined), {
    message: "provide exactly one of maxSpend or minReceive",
  })
  .refine(
    (q) => {
      const v = q.maxSpend ?? q.minReceive;
      return v === undefined || BigInt(v) > 0n; // "exactly one" refine reports absence
    },
    { message: "amount must be positive" }
  );

export async function smartFillRoutes(
  app: FastifyInstance,
  { deps }: { deps: AppDeps }
) {
  app.get("/smart-fill", async (req, reply) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "invalid_request", detail: parsed.error.flatten() });

    const { spendAsset, receiveAsset, maxSpend, minReceive } = parsed.data;
    const pairId = pairIdOf(spendAsset, receiveAsset);
    const orders = await deps.repo.listByPair(pairId);
    return planSmartFill(orders, {
      spendAsset,
      receiveAsset,
      maxOrdersPerTx: deps.config.MAX_ORDERS_PER_TX,
      minPartialSpend: deps.config.SMART_FILL_MIN_PARTIAL_SPEND,
      ...(maxSpend !== undefined
        ? { mode: "spend" as const, limit: BigInt(maxSpend) }
        : { mode: "receive" as const, limit: BigInt(minReceive!) }),
    });
  });
}
