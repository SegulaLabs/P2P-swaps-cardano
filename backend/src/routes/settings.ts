import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";

/**
 * GET  /settings — current chain-provider choice + keys (single-tenant
 *   self-hosted instance, docs/security.md §1: the browser making this
 *   request IS the operator, so echoing the key back for editing is fine).
 * PUT  /settings — switch provider / update a key; hot-swaps the running
 *   provider, no restart needed.
 */
const PatchSchema = z.object({
  provider: z.enum(["blockfrost", "koios"]).optional(),
  blockfrostProjectId: z.string().optional(),
  koiosApiToken: z.string().optional(),
});

export async function settingsRoutes(
  app: FastifyInstance,
  { deps }: { deps: AppDeps }
) {
  app.get("/settings", async (_req, reply) => {
    if (!deps.settings)
      return reply
        .code(503)
        .send({ error: "settings not available (env-only deployment)" });
    return {
      ...deps.settings.get(),
      active: deps.provider?.name ?? null,
    };
  });

  app.put("/settings", async (req, reply) => {
    if (!deps.settings || !deps.applySettings)
      return reply
        .code(503)
        .send({ error: "settings not available (env-only deployment)" });
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "invalid_settings", detail: parsed.error.message });

    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined)
    );
    const result = await deps.applySettings(patch);
    if (!result.ok)
      return reply.code(422).send({ error: "provider_check_failed", detail: result.error });
    return { ...deps.settings.get(), active: deps.provider?.name ?? null };
  });
}
