import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AccountingSourceService } from "./source-service.js";
import { accountingError } from "./types.js";

export function registerAccountingRoutes(app: FastifyInstance, deps: { source?: AccountingSourceService;
  assertAccount(): void; recoveryEnvironment(): { environment: string; tradingEnabled: boolean }; entriesPaused(): Promise<boolean> }): void {
  const source = () => { deps.assertAccount(); if (!deps.source) throw accountingError("SOURCE_UNCONFIGURED"); return deps.source; };
  const safe = async <T>(fn: () => Promise<T>) => {
    try { return await fn(); } catch (error) {
      const code = error instanceof Error && /^ACCOUNTING_[A-Z_]+$/.test(error.message) ? error.message : "ACCOUNTING_REQUEST_FAILED";
      throw Object.assign(new Error(code), { statusCode: 409 });
    }
  };
  app.get("/execution/accounting/source/status", () => safe(async () => source().status()));
  app.post("/execution/accounting/source/inspect", { bodyLimit: 1024 }, () => safe(() => source().inspect()));
  app.post("/execution/accounting/source/recover-clock", { bodyLimit: 1024 }, request => safe(async () => {
    const service = source(), cfg = deps.recoveryEnvironment();
    if (request.body !== undefined && !z.object({}).strict().safeParse(request.body).success) throw accountingError("CLOCK_RECOVERY_REQUEST_INVALID");
    if (cfg.environment !== "paper" || cfg.tradingEnabled || !await deps.entriesPaused()) throw accountingError("CLOCK_RECOVERY_REQUIRES_DISABLED_PAPER");
    return service.recoverClock();
  }));
  app.post("/execution/accounting/source/qualify", { bodyLimit: 32_768 }, request => safe(async () => {
    const service = source();
    if (!await deps.entriesPaused()) throw accountingError("QUALIFICATION_REQUIRES_PAUSE");
    return service.qualify(request.body);
  }));
  app.post("/execution/accounting/source/invalidate", { bodyLimit: 1024 }, request => safe(async () => {
    const service = source(), body = z.object({ reason: z.string().trim().min(1).max(300) }).strict().safeParse(request.body);
    if (!body.success) throw accountingError("INVALIDATION_INVALID");
    await service.invalidate(body.data.reason); return { invalidated: true, brokerReadOnly: true };
  }));
}
