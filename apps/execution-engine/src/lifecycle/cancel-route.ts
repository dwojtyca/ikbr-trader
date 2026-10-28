import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExecutionRepository } from "../repository.js";
import type { TwsExecutionClient } from "../tws-execution-client.js";

export function registerCancelProposedRoute(app: FastifyInstance, deps: {
  repository: Pick<ExecutionRepository, "getProposedOrderById">;
  broker: Pick<TwsExecutionClient, "cancelBrokerOrder"> & Partial<Pick<TwsExecutionClient, "captureCancellationOrigin">>;
  requestReconciliation(): unknown;
}): void {
  app.post("/execution/cancel-proposed/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive().safe() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_proposal_id" });
    let brokerOrderId: string | undefined;
    try {
      const origin = deps.broker.captureCancellationOrigin?.();
      const order = await deps.repository.getProposedOrderById(params.data.id);
      origin?.assertCurrent();
      if (!order) return reply.code(404).send({ error: "proposal_not_found" });
      if (order.status !== "SUBMITTED") return reply.code(409).send({ error: "proposal_not_submitted" });
      if (!order.brokerOrderId) return reply.code(400).send({ error: "broker_order_id_missing" });
      brokerOrderId = order.brokerOrderId;
      const cancel = await deps.broker.cancelBrokerOrder(brokerOrderId, origin);
      origin?.assertCurrent();
      const fresh = await deps.repository.getProposedOrderById(params.data.id);
      origin?.assertCurrent();
      return { order: fresh, cancel };
    } catch {
      // Failure to observe cancellation cannot establish a terminal broker state.
      try { void Promise.resolve(deps.requestReconciliation()).catch(() => {}); } catch { /* still uncertain */ }
      return reply.code(409).send({ error: "CANCEL_UNCONFIRMED", ...(brokerOrderId ? { brokerOrderId } : {}) });
    }
  });
}
