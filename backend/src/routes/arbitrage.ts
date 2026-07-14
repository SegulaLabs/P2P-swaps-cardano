import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { findArbitrage } from "../services/arbitrage.js";

/**
 * GET /arbitrage -> ArbitrageScan (docs/arbitrage.md)
 *
 * Scans the whole cached open book (every pair) for riskless profit cycles
 * that settle as ONE atomic TakeManyOrders tx. Pure read — execution goes
 * through the existing POST /tx/take-many-orders with the returned legs.
 */
export async function arbitrageRoutes(
  app: FastifyInstance,
  { deps }: { deps: AppDeps }
) {
  app.get("/arbitrage", async () => {
    const pairs = await deps.repo.listPairs();
    const orders = (
      await Promise.all(pairs.map((p) => deps.repo.listByPair(p)))
    ).flat();
    return findArbitrage(orders, {
      feeEstimateLovelace: deps.config.ARBITRAGE_FEE_ESTIMATE_LOVELACE,
    });
  });
}
