import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getExecutionAuthContext } from "../auth.js";
import { CloseConflict } from "./close-repository.js";
import type { FullCloseService } from "./close-service.js";

const paramsSchema = z.object({ id: z.coerce.number().int().positive().safe() });
const bodySchema = z.object({ requestId: z.string().uuid().transform(value => value.toLowerCase()), limitPrice: z.number().finite().positive() }).strict();
export function registerFullCloseRoutes(app: FastifyInstance, service: Pick<FullCloseService, "get" | "request" | "reconcile">): void {
  app.get("/execution/lifecycle/:id/close", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_proposal_id" });
    const operation = await service.get(params.data.id);
    return operation ?? reply.code(404).send({ error: "close_operation_missing" });
  });
  app.post("/execution/lifecycle/:id/close", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params), body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_close_request" });
    try {
      const operation = await service.request(params.data.id, body.data.requestId, body.data.limitPrice,
        `operator:${getExecutionAuthContext(request)?.tokenFingerprint ?? "unknown"}`);
      return reply.code(operation.state === "COMPLETED" ? 200 : operation.state === "SUBMITTED" ? 202 : 409).send(operation);
    } catch (error) {
      if (error instanceof CloseConflict) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.post("/execution/lifecycle/:id/close/reconcile", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_proposal_id" });
    try { return await service.reconcile(params.data.id); }
    catch (error) {
      if (error instanceof CloseConflict) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
