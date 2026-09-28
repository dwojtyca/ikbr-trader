import { formatRoundTripReport } from "./round-trip-format.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BoundInstrument, ProposedOrder } from "@ikbr/shared";
import type { ExecutionRepository } from "../repository.js";
import { evaluateRoundTrip } from "./round-trip-evidence.js";
import { evaluateLifecycleOwnership } from "./ownership.js";

export function registerLifecycleRoutes(app: FastifyInstance, deps: {
  repository: Pick<ExecutionRepository, "getLifecycleEvidence" | "getRoundTripEvidence">;
  currentAccountId(): string | null;
  currentSessionId(): string;
  boundInstrument(id: string, originalOrder?: ProposedOrder): BoundInstrument | null | Promise<BoundInstrument | null>;
  now?: () => number;
}): void {
  app.get("/execution/lifecycle/:id/round-trip", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive().safe() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_proposal_id" });
    const accountId = deps.currentAccountId(), sessionId = deps.currentSessionId();
    const evidence = await deps.repository.getRoundTripEvidence(params.data.id, accountId);
    if (!evidence) return reply.code(404).send({ error: "proposal_not_found" });
    const bound = evidence.lifecycle.order.instrumentId ? await deps.boundInstrument(evidence.lifecycle.order.instrumentId, evidence.lifecycle.order) : null;
    const report = evaluateRoundTrip(evidence, {
      accountId: accountId === deps.currentAccountId() && sessionId === deps.currentSessionId() ? accountId : null,
      sessionId, nowMs: deps.now?.() ?? Date.now(),
      bound,
    });
    const format = z.object({ format: z.enum(["json", "markdown"]).optional() }).safeParse(request.query);
    if (!format.success) return reply.code(400).send({ error: "invalid_report_format" });
    return format.data.format === "markdown" ? reply.type("text/markdown; charset=utf-8").send(formatRoundTripReport(report)) : report;
  });
  app.get("/execution/lifecycle/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive().safe() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_proposal_id" });
    const accountId = deps.currentAccountId();
    const sessionId = deps.currentSessionId();
    const evidence = await deps.repository.getLifecycleEvidence(params.data.id, accountId);
    if (!evidence) return reply.code(404).send({ error: "proposal_not_found" });
    const bound = evidence.order.instrumentId ? await deps.boundInstrument(evidence.order.instrumentId, evidence.order) : null;
    const currentContextUnchanged = accountId === deps.currentAccountId() && sessionId === deps.currentSessionId();
    return evaluateLifecycleOwnership(evidence, {
      accountId: currentContextUnchanged ? accountId : null, sessionId,
      nowMs: deps.now?.() ?? Date.now(),
      bound,
    });
  });
}
