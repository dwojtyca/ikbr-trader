import type { FastifyInstance } from "fastify";
import type { ResearchRepairIdentity, ResearchStore } from "@ikbr/shared/instrument-research";
import { getExecutionAuthContext } from "./auth.js";

export interface ResearchPrepareRequest { instrumentId: string; conid: string; effectiveConfigHash: string }
export function registerResearchPrepareRoute(app: FastifyInstance, deps: {
  store: Pick<ResearchStore, "prepareRepair">;
  /** Derives the current allowed account and manifest; rejects paused/drifted or foreign instruments. */
  authorize(input: ResearchPrepareRequest): Promise<ResearchRepairIdentity>;
}): void {
  app.post("/execution/research/prepare", async (request, reply) => {
    if (!getExecutionAuthContext(request)?.tokenFingerprint) return reply.code(401).send({ error: "unauthorized" });
    const raw = request.body;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "conid,effectiveConfigHash,instrumentId")
      return reply.code(400).send({ error: "research_prepare_invalid" });
    const input = raw as ResearchPrepareRequest;
    if (typeof input.instrumentId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.instrumentId) ||
        typeof input.conid !== "string" || !/^[1-9]\d*$/.test(input.conid) ||
        typeof input.effectiveConfigHash !== "string" || !/^[a-f0-9]{64}$/.test(input.effectiveConfigHash))
      return reply.code(400).send({ error: "research_prepare_invalid" });
    try {
      const identity = await deps.authorize(input);
      if (identity.instrumentId !== input.instrumentId || identity.configHash !== input.effectiveConfigHash) throw new Error("RESEARCH_IDENTITY_MISMATCH");
      return await deps.store.prepareRepair(identity);
    } catch {
      return reply.code(423).send({ state: "HOLD", reasons: ["RESEARCH_PREPARATION_UNAVAILABLE"], sources: [], snapshotId: null, nextCheckAt: null });
    }
  });
}
