/**
 * Market Data Runtime — Fastify route plugin.
 *
 * Registers three endpoints under `/runtime/*` on the existing
 * signal-engine Fastify server:
 *
 *   - GET  /runtime/health    — liveness (always 200 while the
 *                                process runs)
 *   - GET  /runtime/ready     — readiness (Redis + Postgres reads)
 *   - POST /runtime/dry-run   — compose snapshot + pipeline,
 *                                return raw TradingPipelineResult
 *
 * PR12 constraints — enforced here:
 *   - The dry-run endpoint NEVER submits an order.
 *   - It NEVER calls `execution-engine`.
 *   - It NEVER writes to `proposed_orders` or any other table.
 *   - It NEVER acquires an idempotency key.
 *
 * Auth: signal-engine has no bearer middleware today; PR12
 * intentionally does NOT introduce one (per the "no new security
 * model" constraint). PR13 or a follow-up may add auth uniformly.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { MarketDataRuntime } from "./runtime.js";
import {
  checkRuntimeReadiness,
  type RuntimeReadinessDeps,
} from "./readiness.js";

const priceRoundingMode = z.enum(["nearest", "up", "down"]);
// Mirror the shared `SupportedOrderType` and `TimeInForce` exactly.
// `MKT` is deliberately absent — the shared execution-ticket layer
// does not accept market orders.
const orderType = z.enum(["LMT", "STP", "STP_LMT"]);
const timeInForce = z.enum(["DAY", "GTC"]);

/**
 * Zod schema mirroring the shared `ExecutionTicketPolicy` type. The
 * runtime NEVER supplies defaults for missing risk-relevant fields
 * (quantity, tick size); those must be explicit per request.
 */
const policySchema = z.object({
  quantity: z.number().finite().positive(),
  orderType,
  timeInForce,
  outsideRth: z.boolean(),
  transmit: z.boolean(),
  entryOffset: z.number().finite().optional(),
  stopLossDistance: z.number().finite().nonnegative().optional(),
  takeProfitDistance: z.number().finite().nonnegative().optional(),
  trailingStopDistance: z.number().finite().nonnegative().optional(),
  priceTickSize: z.number().finite().positive(),
  priceRoundingMode,
});

const dryRunBodySchema = z.object({
  instrumentId: z.string().min(1),
  policy: policySchema,
});

export interface RuntimeRoutesOptions {
  readonly runtime: MarketDataRuntime;
  readonly readinessDeps: RuntimeReadinessDeps;
}

export const runtimeRoutesPlugin: FastifyPluginAsync<RuntimeRoutesOptions> =
  async (app: FastifyInstance, options: RuntimeRoutesOptions) => {
    if (!options?.runtime) {
      throw new Error("runtimeRoutesPlugin: runtime is required");
    }
    if (!options.readinessDeps) {
      throw new Error("runtimeRoutesPlugin: readinessDeps is required");
    }
    const { runtime, readinessDeps } = options;

    app.get("/runtime/health", async () => ({ ok: true }));

    app.get("/runtime/ready", async (_request, reply) => {
      const result = await checkRuntimeReadiness(readinessDeps);
      reply.status(result.ready ? 200 : 503);
      return result;
    });

    app.post("/runtime/dry-run", async (request, reply) => {
      const parsed = dryRunBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.status(400);
        return { error: "invalid_body", issues: parsed.error.issues };
      }

      const { instrumentId, policy } = parsed.data;
      try {
        const result = await runtime.dryRun(instrumentId, policy);
        return result;
      } catch (error) {
        // Unknown instrument (registry throws) is the only expected
        // error path; treat anything else as a 500 with a structured
        // message so operators can distinguish it from bad input.
        const message =
          error instanceof Error ? error.message : String(error);
        if (/instrument/i.test(message) && /not|unknown/i.test(message)) {
          reply.status(404);
          return { error: "instrument_not_found", message };
        }
        reply.status(500);
        return { error: "runtime_error", message };
      }
    });
  };
