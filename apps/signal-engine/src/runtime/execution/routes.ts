/**
 * Execution Runtime — Fastify plugin.
 *
 * Registers:
 *
 *   - POST /runtime/execute         — write endpoint (Bearer-protected)
 *   - GET  /runtime/execute/ready   — write-runtime readiness probe
 *
 * The write endpoint is registered ONLY when `EXECUTION_RUNTIME_ENABLED=true`;
 * with the default `"false"` the routes are absent and no bearer
 * middleware is installed. The dry-run endpoints from PR12 keep their
 * own routes and their own readiness behaviour.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { createRuntimeBearerAuth } from "./bearer-auth.js";
import type { ExecutionRuntime } from "./execution-runtime.js";
import type { PaperGuard } from "./paper-guard.js";

const priceRoundingMode = z.enum(["nearest", "up", "down"]);
// PR13 write path: STP_LMT is INTENTIONALLY absent.
//   - The shared `ExecutionTicketBuilder` supports STP_LMT.
//   - The dry-run endpoint (PR12) accepts STP_LMT and returns a
//     valid pipeline result.
//   - The legacy `SignalTicket` wire type on `execution-engine`
//     only accepts LMT | STP | MKT, and its broker adapter has
//     no STP_LMT branch. Silently coercing STP_LMT → STP would
//     lose the limit price and place a different order type at
//     the broker. Until end-to-end STP_LMT support lands
//     (execution-engine schema + IBKR adapter), the runtime
//     rejects it with 400 rather than misroute.
const orderType = z.enum(["LMT", "STP"]);
const timeInForce = z.enum(["DAY", "GTC"]);

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

const executeBodySchema = z.object({
  instrumentId: z.string().min(1),
  policy: policySchema,
  idempotencyKey: z.string().min(1),
});

export interface ExecutionRuntimeReadinessDeps {
  readonly redis: { ping: () => Promise<unknown> };
  readonly postgres: { query: (text: string) => Promise<unknown> };
  readonly paperGuard: PaperGuard;
}

export interface ExecutionRuntimeRoutesOptions {
  readonly runtime: ExecutionRuntime;
  readonly bearerToken: string;
  readonly readinessDeps: ExecutionRuntimeReadinessDeps;
}

export const executionRuntimeRoutesPlugin: FastifyPluginAsync<
  ExecutionRuntimeRoutesOptions
> = async (
  app: FastifyInstance,
  options: ExecutionRuntimeRoutesOptions,
) => {
  if (!options?.runtime) {
    throw new Error("executionRuntimeRoutesPlugin: runtime is required");
  }
  if (!options.readinessDeps) {
    throw new Error(
      "executionRuntimeRoutesPlugin: readinessDeps is required",
    );
  }
  const auth = createRuntimeBearerAuth({ token: options.bearerToken });

  app.get("/runtime/execute/ready", async (_request, reply) => {
    const [redis, postgres, paper] = await Promise.all([
      probe(() => options.readinessDeps.redis.ping()),
      probe(() => options.readinessDeps.postgres.query("SELECT 1")),
      options.readinessDeps.paperGuard
        .check()
        .then((result) => ({
          ok: result.ok,
          ...(result.reason !== undefined ? { error: result.reason } : {}),
        }))
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
    ]);
    const ready = redis.ok && postgres.ok && paper.ok;
    reply.status(ready ? 200 : 503);
    return {
      ready,
      checks: { redis, postgres, paperGuard: paper },
    };
  });

  app.post(
    "/runtime/execute",
    { preHandler: auth },
    async (request, reply) => {
      const parsed = executeBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.status(400);
        return { error: "invalid_body", issues: parsed.error.issues };
      }
      const { instrumentId, policy, idempotencyKey } = parsed.data;

      let result;
      try {
        result = await options.runtime.execute({
          instrumentId,
          policy,
          idempotencyKey,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        if (
          /instrument/i.test(message) &&
          /not|unknown/i.test(message)
        ) {
          reply.status(404);
          return { error: "instrument_not_found", message };
        }
        // Any other throw at this layer is genuinely unexpected.
        // Surface as UNKNOWN so the client cannot mistake it for a
        // deterministic success/failure.
        reply.status(500);
        return {
          outcome: "UNKNOWN",
          idempotencyKey,
          reason: "internal_error",
        };
      }

      if (result.outcome === "CONFLICT") {
        reply.status(409);
      }
      return result;
    },
  );
};

async function probe(
  fn: () => Promise<unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
