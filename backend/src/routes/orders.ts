import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";

/**
 * GET /orders/:orderId                    — one order ("txHash#index"; '#'=%23)
 * GET /orders/by-owner/:stakeCredential   — a user's orders (open first)
 */
export async function ordersRoutes(
  app: FastifyInstance,
  { deps }: { deps: AppDeps }
) {
  app.get<{ Params: { orderId: string } }>(
    "/orders/:orderId",
    async (req, reply) => {
      const order = await deps.repo.getOrder(req.params.orderId);
      if (!order)
        return reply
          .code(404)
          .send({ error: "not_found", orderId: req.params.orderId });
      return order;
    }
  );

  app.get<{ Params: { stakeCredential: string } }>(
    "/orders/by-owner/:stakeCredential",
    async (req, reply) => {
      const cred = req.params.stakeCredential.toLowerCase();
      if (!/^[0-9a-f]{56}$/.test(cred))
        return reply
          .code(400)
          .send({ error: "stakeCredential must be a 28-byte hex key hash" });
      return { owner: cred, orders: await deps.repo.listByOwner(cred) };
    }
  );
}
