import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BoundInstrument } from "@ikbr/shared";
import type { ExecutionRepository } from "../repository.js";
import { evaluateLifecycleOwnership } from "./ownership.js";

export function registerLifecycleRoutes(app: FastifyInstance, deps: {
  repository: Pick<ExecutionRepository, "getLifecycleEvidence">;
  currentAccountId(): string | null;
  currentSessionId(): string;
  boundInstrument(id: string): BoundInstrument | null;
  now?: () => number;
}): void {
  app.get("/execution/lifecycle/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive().safe() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_proposal_id" });
    const accountId = deps.currentAccountId();
    const sessionId = deps.currentSessionId();
    const evidence = await deps.repository.getLifecycleEvidence(params.data.id, accountId);
    if (!evidence) return reply.code(404).send({ error: "proposal_not_found" });
    const currentContextUnchanged = accountId === deps.currentAccountId() && sessionId === deps.currentSessionId();
    return evaluateLifecycleOwnership(evidence, {
      accountId: currentContextUnchanged ? accountId : null, sessionId,
      nowMs: deps.now?.() ?? Date.now(),
      bound: evidence.order.instrumentId ? deps.boundInstrument(evidence.order.instrumentId) : null,
    });
  });
}
