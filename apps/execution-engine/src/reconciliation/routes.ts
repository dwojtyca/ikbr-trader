/**
 * PR15 — HTTP routes.
 *
 *   GET  /execution/reconciliation/latest
 *   GET  /execution/reconciliation/holds        ?active=true|false
 *   POST /execution/reconciliation/run
 *   POST /execution/reconciliation/holds/:id/acknowledge
 *   POST /execution/reconciliation/holds/:id/resolve
 *
 * Bearer + audit are enforced by the existing global auth plugin;
 * `resolve` additionally requires the secondary
 * `EXECUTION_RECONCILIATION_RESOLVE_TOKEN` (see PR15_PLAN §6
 * Lifecycle "operator_resolve").
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { ReconciliationRepository } from "./repository.js";
import type { ReconciliationScheduler } from "./scheduler.js";

const RESOLVE_HEADER = "x-reconciliation-resolve-token";

const dispositionSchema = z.discriminatedUnion("disposition", [
  z.object({
    disposition: z.literal("LINK_TO_BROKER_ORDER"),
    note: z.string().min(1),
    brokerOrderId: z.string().min(1),
    permId: z.string().optional(),
    orderRef: z.string().optional(),
  }),
  z.object({
    disposition: z.literal("CONFIRMED_NOT_SUBMITTED"),
    note: z.string().min(1),
    confirmation: z.literal("CONFIRMED_NOT_SUBMITTED"),
  }),
  z.object({
    disposition: z.literal("KEEP_BLOCKED"),
    note: z.string().min(1),
  }),
]);

const acknowledgeSchema = z.object({
  note: z.string().optional(),
});

export interface RoutesDeps {
  readonly reconRepo: ReconciliationRepository;
  readonly scheduler: ReconciliationScheduler;
  readonly resolveTokenProvider: () => string | null;
  readonly currentSessionId: () => string;
  readonly currentAccountId: () => string | null;
  readonly maxAgeSeconds: number;
  /**
   * PR15 §4 — snapshot staleness threshold used by
   * `LINK_TO_BROKER_ORDER` verification. Distinct from the write-
   * path staleness knob because operator-link tolerance can
   * differ from write-path fail-closed staleness. Injected so
   * the deployment can tune independently.
   */
  readonly snapshotMaxAgeSeconds: () => number;
}

export function registerReconciliationRoutes(
  app: FastifyInstance,
  deps: RoutesDeps,
): void {
  app.get(
    "/execution/reconciliation/latest",
    async (_request: FastifyRequest, _reply: FastifyReply) => {
      const accountId = deps.currentAccountId();
      const sessionId = deps.currentSessionId();
      if (!accountId) {
        return { accountId: null, sessionId, run: null, stale: null };
      }
      const inSession = await deps.reconRepo.getLatestRunForSession(
        accountId,
        sessionId,
      );
      const overall = await deps.reconRepo.getLatestRunOverall(accountId);
      const nowMs = Date.now();
      const ref = inSession ?? overall;
      const stale =
        ref && ref.completedAt
          ? Math.floor((nowMs - ref.completedAt.getTime()) / 1000) >
            deps.maxAgeSeconds
          : true;
      return {
        accountId,
        sessionId,
        run: ref,
        latestInSession: inSession,
        latestOverall: overall,
        stale,
        maxAgeSeconds: deps.maxAgeSeconds,
      };
    },
  );

  app.get(
    "/execution/reconciliation/holds",
    async (request: FastifyRequest) => {
      const q = (request.query ?? {}) as { active?: string };
      const activeOnly = q.active !== "false";
      const accountId = deps.currentAccountId();
      if (!accountId) return { accountId: null, holds: [] };
      const holds = activeOnly
        ? await deps.reconRepo.listActiveHolds(accountId)
        : await deps.reconRepo.listAllHolds(accountId);
      return { accountId, holds };
    },
  );

  app.post(
    "/execution/reconciliation/run",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const accountId = deps.currentAccountId();
      if (!accountId) {
        return reply
          .code(503)
          .send({ error: "no_active_account", accountId: null });
      }
      const report = await deps.scheduler.triggerNow();
      return { accountId, report };
    },
  );

  app.post(
    "/execution/reconciliation/holds/:id/acknowledge",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id?: string };
      const holdId = Number(params.id);
      if (!Number.isFinite(holdId) || holdId <= 0) {
        return reply.code(400).send({ error: "invalid_hold_id" });
      }
      const body = acknowledgeSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_body", details: body.error.issues });
      }
      const actor = fingerprintFromRequest(request);
      const ok = await deps.reconRepo.acknowledgeHold({
        holdId,
        acknowledgedBy: actor,
        note: body.data.note ?? null,
      });
      if (!ok) return reply.code(404).send({ error: "hold_not_found" });
      return { ok: true };
    },
  );

  app.post(
    "/execution/reconciliation/holds/:id/resolve",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const resolveToken = deps.resolveTokenProvider();
      if (!resolveToken) {
        return reply.code(403).send({ error: "resolve_disabled" });
      }
      const provided = String(request.headers[RESOLVE_HEADER] ?? "");
      if (!timingSafeEqual(provided, resolveToken)) {
        return reply.code(403).send({ error: "resolve_token_mismatch" });
      }
      const params = request.params as { id?: string };
      const holdId = Number(params.id);
      if (!Number.isFinite(holdId) || holdId <= 0) {
        return reply.code(400).send({ error: "invalid_hold_id" });
      }
      if (request.body == null || typeof request.body !== "object") {
        return reply.code(400).send({ error: "disposition_required" });
      }
      const parsed = dispositionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "disposition_required",
          details: parsed.error.issues,
        });
      }
      const actor = fingerprintFromRequest(request);
      const hold = await deps.reconRepo.getHoldById(holdId);
      if (!hold) return reply.code(404).send({ error: "hold_not_found" });
      if (!hold.active) {
        return reply.code(409).send({ error: "hold_already_resolved" });
      }
      const body = parsed.data;
      switch (body.disposition) {
        case "LINK_TO_BROKER_ORDER": {
          const accountId = deps.currentAccountId();
          if (!accountId) {
            return reply.code(503).send({ error: "no_active_account" });
          }
          const payload = (hold.payload ?? {}) as { proposedOrderId?: number };
          const proposedOrderId = Number(payload.proposedOrderId);
          if (!Number.isFinite(proposedOrderId) || proposedOrderId <= 0) {
            return reply.code(400).send({ error: "hold_missing_proposed_order" });
          }
          const result = await deps.reconRepo.atomicOperatorLinkAndResolve({
            holdId,
            proposedOrderId,
            accountId,
            brokerOrderId: body.brokerOrderId,
            permId: body.permId ?? null,
            orderRef: body.orderRef ?? null,
            resolvedBy: actor,
            resolutionNote: body.note,
            currentSessionId: deps.currentSessionId(),
            snapshotMaxAgeSeconds: deps.snapshotMaxAgeSeconds(),
          });
          if (!result.ok) {
            const status =
              result.reason === "hold_not_found"
                ? 404
                : result.reason === "hold_already_resolved"
                  ? 409
                  : result.reason === "broker_order_not_observed" ||
                      result.reason === "snapshot_stale" ||
                      result.reason === "no_complete_snapshot_for_session"
                    ? 503
                    : 400;
            return reply.code(status).send({
              error: "link_failed",
              reason: result.reason,
            });
          }
          return { ok: true, disposition: body.disposition };
        }
        case "CONFIRMED_NOT_SUBMITTED": {
          const accountId = deps.currentAccountId();
          if (!accountId) {
            return reply.code(503).send({ error: "no_active_account" });
          }
          const payload = (hold.payload ?? {}) as { proposedOrderId?: number };
          const proposedOrderId = Number(payload.proposedOrderId);
          if (!Number.isFinite(proposedOrderId) || proposedOrderId <= 0) {
            return reply.code(400).send({ error: "hold_missing_proposed_order" });
          }
          const result = await deps.reconRepo.atomicOperatorConfirmNotSubmitted({
            holdId,
            proposedOrderId,
            accountId,
            resolvedBy: actor,
            resolutionNote: body.note,
          });
          if (!result.ok) {
            const status =
              result.reason === "hold_not_found"
                ? 404
                : result.reason === "hold_already_resolved"
                  ? 409
                  : 400;
            return reply.code(status).send({
              error: "confirm_not_submitted_failed",
              reason: result.reason,
            });
          }
          return { ok: true, disposition: body.disposition };
        }
        case "KEEP_BLOCKED": {
          const ok = await deps.reconRepo.markHoldKeepBlocked({
            holdId,
            acknowledgedBy: actor,
            note: body.note,
          });
          return { ok, disposition: body.disposition, active: true };
        }
      }
    },
  );
}

function fingerprintFromRequest(request: FastifyRequest): string {
  const auth = String(request.headers["authorization"] ?? "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return "unknown";
  return "sha256:" + createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
