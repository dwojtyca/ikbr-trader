import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ConfiguredStrategyRuntime } from "./configured-strategy-runtime.js";
const body = z.object({ instrumentId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict();
export const configuredStrategyRoutes: FastifyPluginAsync<{ runtime: Pick<ConfiguredStrategyRuntime,"evaluate"> }> = async (app, options) => {
  app.post("/runtime/strategy-evaluation", async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error:"INVALID_EVALUATION_REQUEST" });
    return options.runtime.evaluate(parsed.data.instrumentId);
  });
};
