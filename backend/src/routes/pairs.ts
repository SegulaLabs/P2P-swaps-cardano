import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { isOrderExpired, type Order, type Orderbook } from "../types.js";

/**
 * GET /pairs                  — pairs with at least one open order
 * GET /pairs/:pair/orderbook  — open orders for one pair, both directions
 *
 * pair id = two API asset ids sorted lexicographically, joined by "_".
 * bids = orders OFFERING the base (first) asset; asks = offering the quote.
 */
export async function pairsRoutes(
  app: FastifyInstance,
  { deps }: { deps: AppDeps }
) {
  app.get("/pairs", async () => ({ pairs: await deps.repo.listPairs() }));

  app.get<{ Params: { pair: string } }>(
    "/pairs/:pair/orderbook",
    async (req, reply) => {
      const { pair } = req.params;
      const parts = pair.split("_");
      if (parts.length !== 2 || parts[0]! >= parts[1]!)
        return reply
          .code(400)
          .send({ error: "pair must be two sorted asset ids joined by '_'" });

      const [base] = parts;
      // Expired orders are unfillable (types.ts isOrderExpired) — hide them
      // from the takeable book; owners still see them via /orders/by-owner.
      const orders = (await deps.repo.listByPair(pair)).filter(
        (o) => !isOrderExpired(o)
      );
      const offeredId = (o: Order) =>
        o.offeredPolicyId === ""
          ? "lovelace"
          : `${o.offeredPolicyId}.${o.offeredAssetName}`;

      const book: Orderbook = {
        pairId: pair,
        bids: orders.filter((o) => offeredId(o) === base),
        asks: orders.filter((o) => offeredId(o) !== base),
        syncedToSlot: await deps.repo.getCursor(),
      };
      return book;
    }
  );
}
