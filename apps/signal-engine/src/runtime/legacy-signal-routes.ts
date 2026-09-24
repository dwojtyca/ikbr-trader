import type { FastifyPluginAsync } from "fastify";

export const unavailableLegacySignalRoutes: FastifyPluginAsync = async app => {
  for (const path of ["/signals/run-once", "/signals/on-candle"]) {
    app.post(path, async (_request, reply) => reply.code(503).send({
      error: "verified_bound_runtime_required",
      message: "Use the bound trading runtime with verified contract session and native closed candles.",
    }));
  }
};
