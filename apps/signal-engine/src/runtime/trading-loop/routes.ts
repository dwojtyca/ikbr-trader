/**
 * Trading Loop — Fastify plugin.
 *
 * Registers:
 *
 *   GET  /runtime/trading-loop/status   — public, no bearer
 *   POST /runtime/trading-loop/run-once — bearer-protected, paper-only
 *   GET  /runtime/trading-loop/ready    — readiness composite
 *
 * `run-once` and the scheduler share the SAME `TradingLoopService`
 * instance.
 *
 * Readiness composite:
 *   - paper guard passes
 *   - exposure reader (execution-engine read endpoint) reachable
 *   - Redis + Postgres (market-data runtime dependencies) reachable
 * Disabled loop → returns 200 unconditionally (loop is off; guard
 * irrelevant) so a disabled loop can NEVER drag down overall app
 * readiness.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import { createRuntimeBearerAuth } from "../execution/bearer-auth.js";
import type { PaperGuard } from "../execution/paper-guard.js";

import type { TradingLoopService } from "./trading-loop-service.js";
import type { TradingExposureReader } from "./types.js";

export interface TradingLoopRoutesReadinessDeps {
  readonly redis: { ping: () => Promise<unknown> };
  readonly postgres: { query: (text: string) => Promise<unknown> };
  readonly exposureReader: TradingExposureReader;
}

export interface TradingLoopRoutesOptions {
  readonly service: TradingLoopService;
  readonly bearerToken: string;
  readonly paperGuard: PaperGuard;
  readonly readinessDeps: TradingLoopRoutesReadinessDeps;
}

export const tradingLoopRoutesPlugin: FastifyPluginAsync<
  TradingLoopRoutesOptions
> = async (app: FastifyInstance, options: TradingLoopRoutesOptions) => {
  if (!options?.service) {
    throw new Error("tradingLoopRoutesPlugin: service is required");
  }
  if (!options.paperGuard) {
    throw new Error("tradingLoopRoutesPlugin: paperGuard is required");
  }
  if (!options.readinessDeps) {
    throw new Error("tradingLoopRoutesPlugin: readinessDeps is required");
  }
  const auth = createRuntimeBearerAuth({ token: options.bearerToken });

  app.get("/runtime/trading-loop/status", async () => {
    const status = options.service.status();
    return {
      enabled: status.enabled,
      running: status.running,
      startedAt: status.startedAt?.toISOString() ?? null,
      lastCycleAt: status.lastCycleAt?.toISOString() ?? null,
      nextCycleAt: status.nextCycleAt?.toISOString() ?? null,
      activeInstruments: status.activeInstruments,
      cycleCount: status.cycleCount,
      lastOutcomes: Object.fromEntries(
        Object.entries(status.lastOutcomes).map(([id, report]) => [
          id,
          {
            cycleId: report.cycleId,
            instrumentId: report.instrumentId,
            startedAt: report.startedAt.toISOString(),
            finishedAt: report.finishedAt.toISOString(),
            durationMs: report.durationMs,
            outcome: {
              kind: report.outcome.kind,
              ...(("idempotencyKey" in report.outcome)
                ? { idempotencyKey: report.outcome.idempotencyKey }
                : {}),
              ...(("reason" in report.outcome)
                ? { reason: report.outcome.reason }
                : {}),
              ...(("message" in report.outcome)
                ? { message: report.outcome.message }
                : {}),
            },
          },
        ]),
      ),
    };
  });

  app.get("/runtime/trading-loop/ready", async (_request, reply) => {
    const status = options.service.status();
    // A disabled loop is not a readiness failure — the endpoint
    // still returns 200 with `ready: true` so it doesn't drag the
    // rest of the app's health down when the scheduler is off.
    if (!status.enabled) {
      reply.status(200);
      return { ready: true, enabled: false, checks: {} };
    }
    const [paper, exposure, redis, postgres] = await Promise.all([
      options.paperGuard
        .check()
        .then((result) => ({
          ok: result.ok,
          ...(result.reason !== undefined ? { error: result.reason } : {}),
        }))
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
      options.readinessDeps.exposureReader.probeReady().then((r) =>
        r.ok ? { ok: true as const } : { ok: false as const, error: r.message },
      ),
      probe(() => options.readinessDeps.redis.ping()),
      probe(() => options.readinessDeps.postgres.query("SELECT 1")),
    ]);
    const ready = paper.ok && exposure.ok && redis.ok && postgres.ok;
    reply.status(ready ? 200 : 503);
    return {
      ready,
      enabled: true,
      checks: { paperGuard: paper, exposureReader: exposure, redis, postgres },
    };
  });

  app.post(
    "/runtime/trading-loop/run-once",
    { preHandler: auth },
    async (_request, reply) => {
      // Belt-and-braces: the scheduler paper-guard fires per-run
      // inside ExecutionRuntime, but we ALSO refuse to schedule a
      // manual cycle if the guard is failing at the endpoint layer.
      const guard = await options.paperGuard.check();
      if (!guard.ok) {
        reply.status(503);
        return {
          outcome: "PAPER_GUARD_FAILED",
          message: guard.reason ?? "paper guard rejected",
        };
      }
      const cycle = await options.service.runOnce();
      return {
        cycleId: cycle.cycleId,
        startedAt: cycle.startedAt.toISOString(),
        finishedAt: cycle.finishedAt.toISOString(),
        durationMs: cycle.durationMs,
        reports: cycle.reports.map((report) => ({
          instrumentId: report.instrumentId,
          startedAt: report.startedAt.toISOString(),
          finishedAt: report.finishedAt.toISOString(),
          durationMs: report.durationMs,
          outcome: {
            kind: report.outcome.kind,
            ...(("idempotencyKey" in report.outcome)
              ? { idempotencyKey: report.outcome.idempotencyKey }
              : {}),
            ...(("reason" in report.outcome)
              ? { reason: report.outcome.reason }
              : {}),
            ...(("message" in report.outcome)
              ? { message: report.outcome.message }
              : {}),
          },
        })),
      };
    },
  );
};

async function probe(
  fn: () => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
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

