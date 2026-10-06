import type { FastifyInstance, FastifyReply } from "fastify";
import type { SignalTicket } from "@ikbr/shared";
import type { SubmissionApplicationService, SubmissionOutcome } from "./reconciliation/submission-service.js";
import { executeTicketBodySchema } from "./execute-ticket-schema.js";

export function sendSubmissionOutcome(
  reply: FastifyReply,
  outcome: SubmissionOutcome,
  instrument: string,
): FastifyReply | Record<string, unknown> {
  switch (outcome.kind) {
    case "awaiting_ai":
      return reply.code(200).send({ outcome: "AWAITING_AI", order: outcome.order });
    case "ai_review_required":
      return reply.code(409).send({ outcome: "AI_REVIEW_REQUIRED", reason: outcome.reason });
    case "risk_rejected":
      return reply.code(409).send({ outcome: "RISK_REJECTED", reason: outcome.reason });
    case "submitted":
      return reply.code(200).send({
        outcome: "SUBMITTED",
        order: outcome.order,
        execution: outcome.execution,
      });
    case "resumed":
      return reply.code(200).send({
        outcome: "RESUMED",
        order: outcome.order,
        execution: outcome.execution,
        resumed: true,
      });
    case "duplicate_submitted":
      return reply.code(200).send({
        outcome: "DUPLICATE_SUBMITTED",
        duplicate: true,
        order: outcome.order,
      });
    case "duplicate_terminal":
      return reply.code(200).send({
        outcome: "DUPLICATE_TERMINAL",
        duplicate: true,
        order: outcome.order,
      });
    case "duplicate_pending_ambiguous":
      return reply.code(200).send({
        outcome: "DUPLICATE_PENDING_AMBIGUOUS",
        duplicate: true,
        order: outcome.order,
      });
    case "pending_claimed":
      return reply.code(200).send({
        outcome: "PENDING_CLAIMED",
        duplicate: true,
        order: outcome.order,
      });
    case "conflict":
      return reply.code(409).send({
        outcome: "CONFLICT",
        error: "idempotency_conflict",
        message:
          outcome.order === null
            ? "clientOrderId conflict"
            : "clientOrderId already exists with a different clientOrderHash",
        ...(outcome.order ? { order: outcome.order } : {}),
      });
    case "active_intent_exists":
      return reply.code(409).send({
        outcome: "ACTIVE_INTENT_EXISTS",
        error: "active_intent_exists",
        message: `instrument ${instrument} already has a non-terminal proposed order (id=${outcome.existingOrderId}, status=${outcome.existingStatus})`,
        existingOrderId: outcome.existingOrderId,
        existingStatus: outcome.existingStatus,
        existingClientOrderId: outcome.existingClientOrderId,
      });
    case "open_position_exists":
      return reply.code(409).send({
        outcome: "OPEN_POSITION_EXISTS",
        error: "open_position_exists",
        message: `instrument ${instrument} has an open broker position (accountId=${outcome.accountId}, quantity=${outcome.quantity})`,
        accountId: outcome.accountId,
        quantity: outcome.quantity,
        observedAt: outcome.observedAt.toISOString(),
      });
    case "position_state_unavailable":
      return reply.code(503).send({
        outcome: "POSITION_STATE_UNAVAILABLE",
        error: "position_state_unavailable",
        message: `broker position snapshot ${outcome.reason} for ${outcome.accountId}`,
        accountId: outcome.accountId,
        reason: outcome.reason,
      });
    case "reconciliation_unavailable":
      return reply.code(503).send({
        outcome: "RECONCILIATION_UNAVAILABLE",
        error: "reconciliation_unavailable",
        reason: outcome.reason,
      });
    case "reconciliation_stale":
      return reply.code(503).send({
        outcome: "RECONCILIATION_STALE",
        error: "reconciliation_stale",
        ageSeconds: outcome.ageSeconds,
      });
    case "reconciliation_hold":
      return reply.code(503).send({
        outcome: "RECONCILIATION_HOLD",
        error: "reconciliation_hold",
        hold: {
          id: outcome.holdId,
          reason: outcome.reason,
          severity: outcome.severity,
        },
      });
    case "submission_identity_mismatch":
      return reply.code(409).send({
        outcome: "SUBMISSION_IDENTITY_MISMATCH",
        error: "submission_identity_mismatch",
        reason: outcome.reason,
      });
    case "invalid_plan":
      return reply.code(500).send({
        outcome: "INVALID_PLAN",
        error: "invalid_plan",
        reason: outcome.reason,
      });
    case "plan_collision":
      return reply.code(500).send({
        outcome: "PLAN_COLLISION",
        error: "plan_collision",
        collidedRefs: outcome.collidedRefs,
      });
    case "client_order_hash_mismatch":
      return reply.code(409).send({
        outcome: "CLIENT_ORDER_HASH_MISMATCH",
        error: "CLIENT_ORDER_HASH_MISMATCH",
      });
    case "market_order_not_allowed":
      return reply.code(400).send({
        outcome: "MARKET_ORDER_NOT_ALLOWED",
        error: "market_order_not_allowed",
      });
    case "idempotency_identity_missing":
      return reply.code(400).send({
        outcome: "IDEMPOTENCY_IDENTITY_MISSING",
        error: "idempotency_identity_missing",
      });
    case "legacy_idempotency_identity_missing":
      return reply.code(409).send({
        outcome: "LEGACY_IDEMPOTENCY_IDENTITY_MISSING",
        error: "LEGACY_IDEMPOTENCY_IDENTITY_MISSING",
        proposedOrderId: outcome.proposedOrderId,
      });
    case "instrument_binding_unavailable":
      // PR15.2 — payload missing `instrumentId`, or referencing an
      // id that is not configured in the server-side
      // `INSTRUMENT_BINDINGS_JSON`. 400 (client fault) because
      // retrying with the same payload will keep failing.
      return reply.code(400).send({
        outcome: "INSTRUMENT_BINDING_UNAVAILABLE",
        error: "INSTRUMENT_BINDING_UNAVAILABLE",
        reason: outcome.reason,
      });
    case "instrument_execution_disabled":
      // PR15.2 — server-side registry has
      // `trading.executionEnabled=false` for the resolved binding.
      // 423 mirrors the environment-guard semantics: state issue,
      // not a client shape issue.
      return reply.code(423).send({
        outcome: "INSTRUMENT_EXECUTION_DISABLED",
        error: "INSTRUMENT_EXECUTION_DISABLED",
        instrumentId: outcome.instrumentId,
      });
    case "binding_identity_mismatch":
      // PR15.2 — payload symbol/conId does not match the server-
      // resolved binding, OR the resume path finds a stored
      // `instrument_id` that does not match the payload claim.
      return reply.code(409).send({
        outcome: "BINDING_IDENTITY_MISMATCH",
        error: "BINDING_IDENTITY_MISMATCH",
        reason: outcome.reason,
      });
    case "instrument_policy_unavailable":
      // PR15.2 hostile-review fix — trusted registry has no
      // `executionPolicy` for the bound instrument. 423 (locked,
      // state-shaped) mirrors env-guard / kill-switch semantics:
      // the operator must fix the registry, not retry the
      // request.
      return reply.code(423).send({
        outcome: "INSTRUMENT_POLICY_UNAVAILABLE",
        error: "INSTRUMENT_POLICY_UNAVAILABLE",
        instrumentId: outcome.instrumentId,
      });
    case "order_type_not_allowed_by_instrument_policy":
      // PR15.2 hostile-review fix — payload orderType not in
      // the trusted policy's allow-list. 400 (client fault) —
      // retrying with the same payload will keep failing until
      // the caller aligns with the registry.
      return reply.code(400).send({
        outcome: "ORDER_TYPE_NOT_ALLOWED_BY_INSTRUMENT_POLICY",
        error: "ORDER_TYPE_NOT_ALLOWED_BY_INSTRUMENT_POLICY",
        instrumentId: outcome.instrumentId,
        orderType: outcome.orderType,
        allowedOrderTypes: outcome.allowedOrderTypes,
      });
    case "instrument_tick_mismatch":
      // PR15.2 hostile-review fix — trusted policy tick does
      // not agree with the operator-verified `bound.minTick`.
      // 423 (locked, state-shaped) — the operator has to fix
      // either the seed policy or the binding.
      return reply.code(423).send({
        outcome: "INSTRUMENT_TICK_MISMATCH",
        error: "INSTRUMENT_TICK_MISMATCH",
        instrumentId: outcome.instrumentId,
        policyTick: outcome.policyTick,
        boundTick: outcome.boundTick,
      });
    case "rejected_order_immutable":
      return reply.code(409).send({
        outcome: "REJECTED_ORDER_IMMUTABLE",
        error: "REJECTED_ORDER_IMMUTABLE",
        proposedOrderId: outcome.proposedOrderId,
      });
    case "kill_switch_triggered":
      return reply.code(423).send({ error: outcome.message });
    case "not_found":
      return reply.code(404).send({ error: "not_found" });
    case "execution_error":
      return reply.code(400).send({
        outcome: "EXECUTION_ERROR",
        error: outcome.message,
        order: outcome.order,
        ...(outcome.resumed ? { resumed: true } : {}),
      });
  }
}

export function registerExecuteTicketRoute(app: FastifyInstance, deps: { service: Pick<SubmissionApplicationService, "submitTicket">; directTicketRefused(ticket: SignalTicket): void }): void {
app.post("/execution/execute-ticket", async (request, reply) => {
  const body = executeTicketBodySchema.parse(request.body ?? {});
  const ticket = body.ticket as SignalTicket;
  // PR15 r7 §1 — all routing decisions are made INSIDE the
  // single production `submissionService`. This handler only:
  //   (a) parses HTTP,
  //   (b) refuses persist=false with a distinct 400 (direct-
  //       ticket path is out of scope for PR15),
  //   (c) delegates to `submissionService.submitTicket(...)`,
  //   (d) maps the discriminated outcome to HTTP.
  if (!body.persist) {
    deps.directTicketRefused(ticket);
    return reply.code(400).send({
      error: "direct_ticket_disallowed_in_pr15",
      detail:
        "POST /execution/execute-ticket requires persist=true so PR15 " +
        "reconciliation can identify the resulting broker order.",
    });
  }
  // PR15.2 — the HTTP endpoint REQUIRES `instrumentId`. The
  // deeper `submissionService` also validates when the field is
  // present, but here at the wire we deterministically refuse
  // any request that omits it so no code path can bypass the
  // authoritative binding gate through this endpoint.
  if (
    typeof ticket.instrumentId !== "string" ||
    ticket.instrumentId.length === 0
  ) {
    return reply.code(400).send({
      outcome: "INSTRUMENT_BINDING_UNAVAILABLE",
      error: "INSTRUMENT_BINDING_UNAVAILABLE",
      reason: "instrument_id_missing",
      detail:
        "POST /execution/execute-ticket requires ticket.instrumentId (PR15.2). " +
        "Legacy proposal-based submissions must use /execution/execute-proposed/:id.",
    });
  }
  const outcome = await deps.service.submitTicket({
    ticket,
    strategy: body.strategy,
    clientOrderId: body.clientOrderId,
    clientOrderHash: body.clientOrderHash,
  });
  return sendSubmissionOutcome(reply, outcome, ticket.instrument);
});

}
