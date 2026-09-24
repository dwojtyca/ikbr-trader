import { isAaplIdentity } from "../aapl-window.js";
import { isPkoIdentity } from "../gpw-window.js";
import { isWseBound } from "../wse-market-rules.js";
/**
 * PR15 r7 §1 — production submission application service.
 *
 * Single source of truth for the broker-submission pipeline.
 * Both `POST /execution/execute-ticket` and
 * `POST /execution/execute-proposed/:id` — and the PR15 test
 * suite — construct THE SAME instance of this service. There
 * is NO parallel test-only flow; tests inject a
 * `BrokerOrderDispatcher` fake instead.
 *
 * Invariant enforced end-to-end:
 *
 *   validate request/status
 *   → validate identity (clientOrderId + clientOrderHash)
 *   → recompute canonical clientOrderHash
 *   → validate kill switch / policy (MKT etc.)
 *   → prepare exact broker plan
 *   → authoritative position + reconciliation guard
 *   → atomically verify DB identity + persist complete plan + set marker
 *   → dispatch exactly the prepared + persisted plan
 *   → persist outcome
 *   → reconciliation on ambiguous failure
 */

import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import type {
  BoundInstrument,
  InstrumentBindingAuthority,
  ProposedOrder,
  SignalTicket,
} from "@ikbr/shared";
import { tickSizesEqual } from "@ikbr/shared";
import { aiApprovalFailure } from "../ai-proposal-review.js";
import type { AiEntryRiskEvidence } from "../ai-entry-risk.js";

import type {
  ExecutionRepository,
  OrderDecisionMetadata,
  PositionGuardContext,
  ReconciliationSubmissionGate,
} from "../repository.js";
import { validatePersistedOrderIdentity } from "../repository.js";
import type { PreparedBrokerOrder } from "../tws-execution-client.js";
import type { AlertInput } from "../alerts.js";

/**
 * Payload delivered to the injected `BrokerOrderDispatcher`.
 * The dispatcher MUST use these exact IDs / refs; it MUST NOT
 * allocate new broker order IDs, rebuild the bracket, or ignore
 * `prepared` in favour of some other plan.
 */
export interface BrokerDispatchPayload {
  readonly proposedOrderId: number;
  readonly accountId: string;
  readonly prepared: PreparedBrokerOrder;
  readonly windowDeadlineMs?: number;
}

export interface BrokerDispatchResult {
  readonly brokerOrderId: string;
  readonly status: "SUBMITTED" | "FILLED";
}

/**
 * Port between the submission service and the broker layer.
 * The production wiring implements this with
 * `TwsExecutionClient.dispatchPreparedOrder(...)`; tests inject
 * a fake that never touches IBKR.
 */
export interface BrokerOrderDispatcher {
  dispatch(payload: BrokerDispatchPayload): Promise<BrokerDispatchResult>;
}

/** Async factory for the current write-path `PositionGuardContext`. */
export type PositionGuardProvider = () => Promise<PositionGuardContext> | PositionGuardContext;

/** Alert writer. Production: `alerts.record`; tests: a spy. */
export type AlertWriter = (input: AlertInput) => Promise<void> | void;

/** Reconciliation trigger. Production: `reconScheduler.triggerNow`. */
export type ReconciliationTrigger = () => Promise<unknown> | void;

/** Prepared-plan factory. Production: `tws.prepareBrokerOrderPlan`. */
export type BrokerPlanPreparer = (input: {
  readonly order: ProposedOrder;
  readonly accountId: string;
  readonly clientOrderId: string;
}) => Promise<PreparedBrokerOrder>;

export interface SubmissionServiceDeps {
  readonly assessAiRisk?: (order: ProposedOrder, bound: BoundInstrument, accountId: string, sessionId: string) => Promise<{ok:true; evidence: AiEntryRiskEvidence} | {ok:false; reason:string}>;
  readonly repo: ExecutionRepository;
  readonly ensureBrokerSession: () => Promise<{ accountId: string }>;
  readonly buildPositionGuard: PositionGuardProvider;
  readonly reconciliationGate: () => ReconciliationSubmissionGate;
  readonly prepareBrokerPlan: BrokerPlanPreparer;
  readonly dispatcher: BrokerOrderDispatcher;
  readonly assertKillSwitchOk: (order: {
    instrument: string;
    positionEffect?: string | null;
  }) => Promise<void> | void;
  readonly recordAlert: AlertWriter;
  readonly triggerReconciliation: ReconciliationTrigger;
  readonly ownerId: string;
  readonly allowMarketOrder: boolean;
  /**
   * PR15.2 — legacy default for the position guard's cross-
   * contract exposure policy. Used ONLY when a submission has NO
   * bound instrument (llm-agent `/execution/execute-proposed/:id`
   * on a legacy `instrument_id IS NULL` row). Bound Phase 2
   * tickets resolve the value from
   * `Instrument.executionPolicy?.allowCrossContractExposure ??
   * false` via `bindingAuthority` — a caller can never widen it.
   */
  readonly allowCrossContractExposure: boolean;
  /**
   * PR15.2 — server-side authority for logical `instrumentId` →
   * exact broker contract binding. Injected here so the
   * submission service can rejects unbound / disabled / mismatched
   * tickets BEFORE repository mutation and broker dispatch. The
   * server MUST NOT trust the caller's claim of a binding.
   */
  readonly bindingAuthority: InstrumentBindingAuthority;
  readonly defaultTif: string;
  readonly onSnapshotInvalidated?: (
    accountId: string,
    generation: number,
  ) => void;
  readonly refreshBrokerSnapshot?: (accountId: string) => Promise<unknown>;
}

/**
 * Discriminated outcome union. HTTP mapping happens in the
 * route handler; this module is transport-agnostic.
 */
export type SubmissionOutcome =
  | { readonly kind: "awaiting_ai"; readonly order: ProposedOrder }
  | { readonly kind: "ai_review_required"; readonly reason: string }
  | { readonly kind: "risk_rejected"; readonly reason: string }
  | { readonly kind: "submitted"; readonly order: ProposedOrder; readonly execution: {
      readonly orderId: number;
      readonly accountId: string;
      readonly brokerOrderId: string;
      readonly status: string;
    } }
  | { readonly kind: "resumed"; readonly order: ProposedOrder; readonly execution: {
      readonly orderId: number;
      readonly accountId: string;
      readonly brokerOrderId: string;
      readonly status: string;
    } }
  | { readonly kind: "duplicate_submitted"; readonly order: ProposedOrder }
  | { readonly kind: "duplicate_terminal"; readonly order: ProposedOrder }
  | { readonly kind: "duplicate_pending_ambiguous"; readonly order: ProposedOrder }
  | { readonly kind: "pending_claimed"; readonly order: ProposedOrder }
  | { readonly kind: "active_intent_exists"; readonly existingOrderId: number; readonly existingStatus: string; readonly existingClientOrderId: string | null }
  | { readonly kind: "open_position_exists"; readonly accountId: string; readonly quantity: number; readonly observedAt: Date }
  | { readonly kind: "position_state_unavailable"; readonly accountId: string | null; readonly reason: string }
  | { readonly kind: "reconciliation_unavailable"; readonly reason: string }
  | { readonly kind: "reconciliation_stale"; readonly ageSeconds: number }
  | { readonly kind: "reconciliation_hold"; readonly holdId: number; readonly reason: string; readonly severity: string }
  | { readonly kind: "submission_identity_mismatch"; readonly reason: string }
  | { readonly kind: "invalid_plan"; readonly reason: string }
  | { readonly kind: "plan_collision"; readonly collidedRefs: readonly string[] }
  | { readonly kind: "conflict"; readonly order: ProposedOrder | null }
  | { readonly kind: "client_order_hash_mismatch" }
  | { readonly kind: "market_order_not_allowed" }
  | { readonly kind: "idempotency_identity_missing" }
  /**
   * PR15.2 — the `POST /execution/execute-ticket` payload lacked
   * `instrumentId`, or referenced an id that is not configured
   * in the server-side `INSTRUMENT_BINDINGS_JSON`, or was
   * disabled (`trading.executionEnabled=false` on the logical
   * registry entry).
   */
  | { readonly kind: "instrument_binding_unavailable"; readonly reason: string }
  | { readonly kind: "instrument_execution_disabled"; readonly instrumentId: string }
  /**
   * PR15.2 — payload symbol / conId did not match the server-
   * resolved binding for the claimed `instrumentId`. Rejected
   * before repository mutation.
   */
  | { readonly kind: "binding_identity_mismatch"; readonly reason: string }
  /**
   * PR15.2 hostile-review fix — the bound registry instrument
   * has no `executionPolicy`. Every order-critical parameter
   * (quantity cap, allowed order types, tick size,
   * cross-contract policy) MUST come from the trusted server-
   * side registry — fail-closed rather than fall back to any
   * caller-supplied value.
   */
  | { readonly kind: "instrument_policy_unavailable"; readonly instrumentId: string }
  /**
   * PR15.2 hostile-review fix — the payload's `orderType`
   * is not in the bound instrument's
   * `executionPolicy.allowedOrderTypes`. Rejected before repo
   * mutation and broker dispatch.
   */
  | {
      readonly kind: "order_type_not_allowed_by_instrument_policy";
      readonly instrumentId: string;
      readonly orderType: string;
      readonly allowedOrderTypes: readonly string[];
    }
  /**
   * PR15.2 hostile-review fix — the trusted registry policy
   * `priceTickSize` does not match the operator-configured
   * `bound.minTick`. Refuses the submission before persistence.
   */
  | {
      readonly kind: "instrument_tick_mismatch";
      readonly instrumentId: string;
      readonly policyTick: number;
      readonly boundTick: number;
    }
  | { readonly kind: "legacy_idempotency_identity_missing"; readonly proposedOrderId: number }
  | { readonly kind: "rejected_order_immutable"; readonly proposedOrderId: number }
  | { readonly kind: "kill_switch_triggered"; readonly message: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "execution_error"; readonly order: ProposedOrder | null; readonly message: string; readonly resumed: boolean };

export interface SubmissionApplicationService {
  submitTicket(input: {
    readonly ticket: SignalTicket;
    readonly strategy: string;
    readonly clientOrderId: string | undefined;
    readonly clientOrderHash: string | undefined;
    readonly decisionMetadata?: OrderDecisionMetadata;
  }): Promise<SubmissionOutcome>;
  executeProposed(input: {
    readonly proposedOrderId: number;
    readonly overrideRejected: boolean;
    readonly decisionMetadata?: OrderDecisionMetadata;
  }): Promise<SubmissionOutcome>;
}

export function buildSubmissionApplicationService(
  deps: SubmissionServiceDeps,
): SubmissionApplicationService {
  async function runDispatch(input: {
    readonly order: ProposedOrder;
    readonly prepared: PreparedBrokerOrder;
    readonly accountId: string;
    readonly metadata: OrderDecisionMetadata;
    readonly resumed: boolean;
  }): Promise<SubmissionOutcome> {
    const { order, prepared, accountId, metadata, resumed } = input;
    try {
      let windowDeadlineMs: number | undefined;
      if (isPkoIdentity(order)) {
        const window = await deps.repo.checkGpwEntry(order, accountId, true);
        if (!window.ok) return { kind: "risk_rejected", reason: window.reason };
        windowDeadlineMs = window.endsAtMs;
      }
      if (isAaplIdentity(order)) {
        const window = await deps.repo.checkAaplEntry(order, accountId, true);
        if (!window.ok) return { kind: "risk_rejected", reason: window.reason };
        windowDeadlineMs = window.endsAtMs;
      }
      const result = await deps.dispatcher.dispatch({
        proposedOrderId: order.id!,
        accountId,
        prepared,
        windowDeadlineMs,
      });
      if (result.status === "FILLED") {
        // PR14 round-8 — invalidate snapshot BEFORE local FILLED
        // transition so the write-path guard cannot observe a
        // stale flat snapshot between the two writes.
        const { generation } =
          await deps.repo.invalidatePositionSnapshot({
            accountId,
            sessionId: deps.ownerId,
            observedAt: new Date(),
          });
        deps.onSnapshotInvalidated?.(accountId, generation);
        await deps.repo.markFilled(
          order.id!,
          accountId,
          result.brokerOrderId,
          `Broker accepted order, status=${result.status}`,
          metadata,
        );
        if (deps.refreshBrokerSnapshot) {
          void deps.refreshBrokerSnapshot(accountId).catch(() => undefined);
        }
      } else {
        await deps.repo.markSubmitted(
          order.id!,
          accountId,
          result.brokerOrderId,
          `Broker accepted order, status=${result.status}`,
          metadata,
        );
      }
      const fresh = await deps.repo.getProposedOrderById(order.id!);
      return {
        kind: resumed ? "resumed" : "submitted",
        order: fresh ?? order,
        execution: {
          orderId: order.id!,
          accountId,
          brokerOrderId: result.brokerOrderId,
          status: result.status,
        },
      };
    } catch (err) {
      // PR15 §3 — DO NOT mark CANCELLED. The broker may have
      // accepted the order despite this local exception; only
      // reconciliation / operator recovery may resolve. Record
      // `source_error`, emit CRITICAL alert, trigger reconciler.
      const message = (err as Error).message;
      await deps.repo
        .setDecisionMetadata(order.id!, { ...metadata, sourceError: message })
        .catch(() => undefined);
      await deps.recordAlert({
        severity: "CRITICAL",
        kind: "dispatch_unknown",
        message:
          `dispatch outcome unknown for proposed_order_id=${order.id} — ` +
          `reconciliation required. cause=${message}`,
        payload: {
          proposedOrderId: order.id,
          accountId,
          instrument: order.instrument,
          brokerOrderIds: prepared.legs.map((l) => l.brokerOrderId),
          orderRefs: prepared.legs.map((l) => l.orderRef),
          cause: message,
        },
      });
      try {
        await deps.triggerReconciliation();
      } catch {
        /* best-effort */
      }
      const fresh = await deps.repo.getProposedOrderById(order.id!);
      return {
        kind: "execution_error",
        order: fresh ?? order,
        message,
        resumed,
      };
    }
  }

  async function runThreePhase(input: {
    readonly order: ProposedOrder;
    readonly clientOrderId: string;
    readonly clientOrderHash: string;
    readonly metadata: OrderDecisionMetadata;
    readonly resumed: boolean;
    readonly allowAiDispatch?: boolean;
    /**
     * PR15.2 — server-resolved cross-contract exposure policy
     * for this specific submission. For bound tickets it comes
     * from `Instrument.executionPolicy?.allowCrossContractExposure
     * ?? false`; for legacy (unbound) rows it defaults to
     * `deps.allowCrossContractExposure` (hardcoded `false`).
     * A caller cannot influence it — this value is set inside
     * `submitTicket` / `executeProposed`, never by the HTTP layer.
     */
    readonly allowCrossContractExposure: boolean;
  }): Promise<SubmissionOutcome> {
    const {
      order,
      clientOrderId,
      clientOrderHash,
      resumed,
      allowCrossContractExposure,
    } = input;
    let metadata = input.metadata;
    let aiRiskEvidence: AiEntryRiskEvidence | undefined;
    // PR15 r8 §2 — every prepare/claim/dispatch MUST be preceded
    // by a recompute of computeClientOrderHash from the persisted
    // row and a comparison to the stored hash. We re-fetch inside
    // this function so all callers (fresh-INSERT-then-SELECT,
    // clean-PROPOSED resume, unique-violation race, execute-
    // proposed) go through one choke point.
    const identity = await deps.repo.getExecutableProposedById(order.id!);
    if (!identity) {
      return {
        kind: "execution_error",
        order,
        message: "persisted_order_missing",
        resumed,
      };
    }
    if (identity.clientOrderId !== clientOrderId) {
      return { kind: "submission_identity_mismatch", reason: "client_order_id_mismatch" };
    }
    const verified = validatePersistedOrderIdentity(
      identity.order,
      identity.clientOrderHash,
    );
    if (!verified.ok) {
      if (verified.reason === "hash_mismatch") {
        return { kind: "client_order_hash_mismatch" };
      }
      return {
        kind: "execution_error",
        order: identity.order,
        message: `persisted_identity_${verified.reason}`,
        resumed,
      };
    }
    if (verified.ticket && identity.clientOrderHash !== clientOrderHash) {
      // Caller-supplied hash disagrees with stored hash.
      return { kind: "client_order_hash_mismatch" };
    }
    // Use the persisted, recomputed row/ticket for prepare +
    // dispatch. This guarantees every downstream field matches
    // what the hash covered.
    const validatedOrder: ProposedOrder = {
      ...identity.order,
    };
    if (validatedOrder.riskCheckStatus !== "PASS") return { kind: "risk_rejected", reason: "risk_check_not_pass" };
    if (validatedOrder.instrumentId !== undefined) {
      if (validatedOrder.positionEffect === "CLOSE_OR_REDUCE")
        return { kind: "ai_review_required", reason: "bound_close_requires_lifecycle_flow" };
      const review = await deps.repo.getAiProposalReview(validatedOrder.id!);
      if (!review) return { kind: "ai_review_required", reason: "ai_review_missing" };
      if (!input.allowAiDispatch) {
        if (review.expires_at.getTime() <= review.database_now.getTime() || review.status === "EXPIRED" || review.status === "REJECTED")
          return { kind: "ai_review_required", reason: "ai_review_not_pending" };
        return { kind: "awaiting_ai", order: validatedOrder };
      }
      const failure = aiApprovalFailure(review, validatedOrder, identity.clientOrderHash!);
      if (failure) return { kind: "ai_review_required", reason: failure };
      const decision = review.decision_json!;
      metadata = { decisionActor: "llm-agent", decisionSource: "llm", aiDecision: "EXECUTE",
        aiReason: decision.reason, aiModel: decision.model, aiDecisionConfidence: decision.confidence };
    }
    // Kill-switch gate before any broker contact.
    try {
      await deps.assertKillSwitchOk({
        instrument: validatedOrder.instrument,
        positionEffect: validatedOrder.positionEffect ?? null,
      });
    } catch (err) {
      return { kind: "kill_switch_triggered", message: (err as Error).message };
    }
    const { accountId } = await deps.ensureBrokerSession();
    if (validatedOrder.instrumentId !== undefined) {
      const guard = await deps.buildPositionGuard();
      if (guard.kind !== "available" || guard.accountId !== accountId)
        return { kind: "risk_rejected", reason: "account_context_unavailable" };
      const review = await deps.repo.getAiProposalReview(validatedOrder.id!);
      const failure = aiApprovalFailure(review, validatedOrder, identity.clientOrderHash!, accountId, guard.sessionId);
      if (failure) return { kind: "ai_review_required", reason: failure };
      const binding = resolveBoundIdentity(deps.bindingAuthority, { instrumentId: validatedOrder.instrumentId,
        instrument: validatedOrder.instrument, conid: validatedOrder.conid ?? null, orderType: validatedOrder.orderType });
      if (binding.kind !== "ok") return binding.outcome;
      if (!deps.assessAiRisk) return { kind: "risk_rejected", reason: "fresh_ai_risk_unavailable" };
      let assessed: Awaited<ReturnType<NonNullable<SubmissionServiceDeps["assessAiRisk"]>>>;
      try { assessed = await deps.assessAiRisk(validatedOrder, binding.bound, accountId, guard.sessionId); }
      catch { assessed = { ok: false, reason: "fresh_ai_risk_unavailable" }; }
      if (!assessed.ok) {
        await deps.repo.recordAiRisk(validatedOrder.id!, assessed);
        return { kind: "risk_rejected", reason: assessed.reason };
      }
      aiRiskEvidence = assessed.evidence;
    }
    if (isPkoIdentity(validatedOrder)) {
      const window = await deps.repo.checkGpwEntry(validatedOrder, accountId);
      if (!window.ok) return { kind: "risk_rejected", reason: window.reason };
    }
    if (isAaplIdentity(validatedOrder)) {
      const window = await deps.repo.checkAaplEntry(validatedOrder, accountId);
      if (!window.ok) return { kind: "risk_rejected", reason: window.reason };
    }
    // Phase A — pure prepare. Any exception surfaces to caller
    // as execution_error (contract resolution / RTH / tick).
    let prepared: PreparedBrokerOrder;
    try {
      prepared = await deps.prepareBrokerPlan({
        order: validatedOrder,
        accountId,
        clientOrderId,
      });
    } catch (err) {
      return {
        kind: "execution_error",
        order: validatedOrder,
        message: (err as Error).message,
        resumed,
      };
    }
    if (validatedOrder.instrumentId !== undefined &&
        (prepared.normalizedTicket.instrumentId !== validatedOrder.instrumentId ||
         computeClientOrderHash(prepared.normalizedTicket) !== identity.clientOrderHash)) {
      return { kind: "risk_rejected", reason: "prepared_ticket_differs_from_ai_approval" };
    }
    // Phase B — atomic claim + full plan persistence + identity
    // binding under the same tx.
    const positionGuard = await deps.buildPositionGuard();
    const claim = await deps.repo.tryStartSubmissionWithPlan({
      id: validatedOrder.id!,
      owner: deps.ownerId,
      instrument: validatedOrder.instrument,
      conid: typeof validatedOrder.conid === "string" ? validatedOrder.conid : null,
      allowCrossContractExposure,
      positionGuard,
      reconciliationGate: deps.reconciliationGate(),
      prepared: {
        clientOrderId,
        clientOrderHash,
        instrument: validatedOrder.instrument,
        conid: typeof validatedOrder.conid === "string" ? validatedOrder.conid : null,
        instrumentId: validatedOrder.instrumentId ?? null,
        legs: prepared.legs,
      },
      accountId,
      metadata,
      aiRiskEvidence,
    });
    switch (claim.kind) {
      case "claimed_with_persisted_plan":
        return runDispatch({
          order: validatedOrder,
          prepared,
          accountId,
          metadata,
          resumed,
        });
      case "not_claimed": {
        // Re-read for freshest state and classify.
        const fresh = await deps.repo.getProposedOrderById(validatedOrder.id!);
        return classifyPostClaimFailure(fresh ?? validatedOrder);
      }
      case "invalid_plan":
        await deps.recordAlert({
          severity: "CRITICAL",
          kind: "system",
          message: `invalid_plan — proposed_order_id=${order.id} reason=${claim.reason}`,
          payload: { proposedOrderId: order.id, reason: claim.reason },
        });
        return { kind: "invalid_plan", reason: claim.reason };
      case "plan_collision":
        await deps.recordAlert({
          severity: "CRITICAL",
          kind: "system",
          message: `plan_collision — refs ${claim.collidedRefs.join(",")}`,
          payload: { proposedOrderId: order.id, collidedRefs: claim.collidedRefs },
        });
        return { kind: "plan_collision", collidedRefs: claim.collidedRefs };
      case "submission_identity_mismatch":
        return { kind: "submission_identity_mismatch", reason: claim.reason };
      case "open_position_exists":
        return {
          kind: "open_position_exists",
          accountId: claim.accountId,
          quantity: claim.quantity,
          observedAt: claim.observedAt,
        };
      case "position_state_unavailable":
        return {
          kind: "position_state_unavailable",
          accountId: claim.accountId,
          reason: claim.reason,
        };
      case "reconciliation_unavailable":
        return { kind: "reconciliation_unavailable", reason: claim.reason };
      case "reconciliation_stale":
        return { kind: "reconciliation_stale", ageSeconds: claim.ageSeconds };
      case "reconciliation_hold":
        return {
          kind: "reconciliation_hold",
          holdId: claim.holdId,
          reason: claim.reason,
          severity: claim.severity,
        };
    }
  }

  function classifyPostClaimFailure(order: ProposedOrder): SubmissionOutcome {
    switch (order.status) {
      case "SUBMITTED":
      case "FILLED":
        return { kind: "duplicate_submitted", order };
      case "REJECTED":
      case "CANCELLED":
      case "SUPERSEDED":
      case "EXPIRED":
        return { kind: "duplicate_terminal", order };
      case "PROPOSED":
        if (order.executionAttemptedAt || order.brokerOrderId) {
          return { kind: "duplicate_pending_ambiguous", order };
        }
        return { kind: "pending_claimed", order };
      default:
        return { kind: "pending_claimed", order };
    }
  }

  function classifyReplay(order: ProposedOrder): SubmissionOutcome {
    if (order.status === "SUBMITTED" || order.status === "FILLED") {
      return { kind: "duplicate_submitted", order };
    }
    return { kind: "duplicate_pending_ambiguous", order };
  }

  return {
    async submitTicket(input) {
      if (input.ticket.riskCheckStatus !== "PASS") return { kind: "risk_rejected", reason: "risk_check_not_pass" };
      if (input.ticket.instrumentId && input.ticket.positionEffect === "CLOSE_OR_REDUCE")
        return { kind: "ai_review_required", reason: "bound_close_requires_lifecycle_flow" };
      // §1 identity mandatory.
      if (
        typeof input.clientOrderId !== "string" ||
        input.clientOrderId.length === 0 ||
        typeof input.clientOrderHash !== "string" ||
        input.clientOrderHash.length === 0
      ) {
        return { kind: "idempotency_identity_missing" };
      }
      // §6 MKT policy.
      if (input.ticket.orderType === "MKT" && !deps.allowMarketOrder) {
        return { kind: "market_order_not_allowed" };
      }
      // §5 server-side hash verification.
      const serverHash = computeClientOrderHash(input.ticket);
      if (input.clientOrderHash !== serverHash) {
        return { kind: "client_order_hash_mismatch" };
      }

      // PR15.2 — authoritative instrument-binding gate.
      // BEFORE any persistence / broker contact:
      //   1. resolve the server-side binding for the ticket's
      //      claimed `instrumentId` (never trust the caller);
      //   2. refuse disabled instruments;
      //   3. compare payload symbol + conId to the resolved
      //      binding — a mismatch aborts fail-closed;
      //   4. resolve `allowCrossContractExposure` from the
      //      registry's own executionPolicy — the caller cannot
      //      influence it.
      //
      // If the payload has NO `instrumentId` the submission is
      // treated as a legacy (pre-PR15.2) request: the endpoint
      // layer enforces "instrumentId REQUIRED for
      // /execution/execute-ticket" (see `index.ts`) so this
      // fall-through only fires for pre-PR15.2 internal test
      // paths and the llm-agent proposal flow via
      // `/execution/execute-proposed/:id`. Legacy allowCross-
      // ContractExposure default = server-side `false`.
      let allowCrossContractExposure = deps.allowCrossContractExposure;
      if (input.ticket.instrumentId !== undefined) {
        const bindingCheck = resolveBoundIdentity(deps.bindingAuthority, {
          instrumentId: input.ticket.instrumentId,
          instrument: input.ticket.instrument,
          conid: input.ticket.conid ?? null,
          orderType: input.ticket.orderType,
        });
        if (bindingCheck.kind !== "ok") {
          return bindingCheck.outcome;
        }
        allowCrossContractExposure =
          bindingCheck.bound.instrument.executionPolicy
            ?.allowCrossContractExposure ?? false;
      }

      const metadata: OrderDecisionMetadata = {
        decisionSource: "user",
        decisionActor: "user",
        ...input.decisionMetadata,
      };
      // Idempotency lookup FIRST — matching hash + resumable
      // state → resume path; matching hash + terminal → replay
      // response; mismatch → CONFLICT.
      const existing = await deps.repo.getIdempotencyRecord(input.clientOrderId);
      if (existing) {
        if (existing.clientOrderHash !== input.clientOrderHash) {
          return { kind: "conflict", order: existing.order };
        }
        // PR15.2 — resume-time instrumentId guard. The stored row
        // MUST match the payload's binding: a divergence here
        // means someone reused the same clientOrderId+hash under
        // a different logical instrument. Fail-closed.
        if (
          (existing.order.instrumentId ?? null) !==
          (input.ticket.instrumentId ?? null)
        ) {
          return {
            kind: "binding_identity_mismatch",
            reason: "resume_instrument_id_mismatch",
          };
        }
        const st = existing.order.status;
        if (st === "SUBMITTED" || st === "FILLED") {
          return classifyReplay(existing.order);
        }
        if (
          st === "REJECTED" ||
          st === "CANCELLED" ||
          st === "SUPERSEDED" ||
          st === "EXPIRED"
        ) {
          return { kind: "duplicate_terminal", order: existing.order };
        }
        // PROPOSED
        if (existing.order.executionAttemptedAt || existing.order.brokerOrderId) {
          return { kind: "duplicate_pending_ambiguous", order: existing.order };
        }
        // Clean PROPOSED → resume path with the SAME persisted
        // identity. Re-verify hash against the stored value.
        return runThreePhase({
          order: existing.order,
          clientOrderId: input.clientOrderId,
          clientOrderHash: input.clientOrderHash,
          metadata,
          resumed: true,
          allowCrossContractExposure,
        });
      }
      // Fresh INSERT.
      const positionGuard = await deps.buildPositionGuard();
      let insertOutcome:
        | Awaited<ReturnType<ExecutionRepository["insertProposedFromTicket"]>>
        | { readonly kind: "unique_violation" };
      try {
        insertOutcome = await deps.repo.insertProposedFromTicket(
          input.ticket,
          input.strategy,
          {
            clientOrderId: input.clientOrderId,
            clientOrderHash: input.clientOrderHash,
          },
          positionGuard,
          {
            allowCrossContractExposure,
            reconciliationGate: deps.reconciliationGate(),
          },
        );
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (/duplicate key/i.test(msg) && /client_order_id/i.test(msg)) {
          insertOutcome = { kind: "unique_violation" };
        } else {
          throw err;
        }
      }
      if (insertOutcome.kind === "unique_violation") {
        const raced = await deps.repo.getIdempotencyRecord(input.clientOrderId);
        if (!raced) {
          return { kind: "execution_error", order: null, message: "unique_violation_unresolvable", resumed: false };
        }
        if (raced.clientOrderHash !== input.clientOrderHash) {
          return { kind: "conflict", order: raced.order };
        }
        if (
          (raced.order.instrumentId ?? null) !==
          (input.ticket.instrumentId ?? null)
        ) {
          return {
            kind: "binding_identity_mismatch",
            reason: "resume_instrument_id_mismatch",
          };
        }
        return runThreePhase({
          order: raced.order,
          clientOrderId: input.clientOrderId,
          clientOrderHash: input.clientOrderHash,
          metadata,
          resumed: true,
          allowCrossContractExposure,
        });
      }
      if (insertOutcome.kind === "active_intent_exists") {
        return {
          kind: "active_intent_exists",
          existingOrderId: insertOutcome.existingOrderId,
          existingStatus: insertOutcome.existingStatus,
          existingClientOrderId: insertOutcome.existingClientOrderId,
        };
      }
      if (insertOutcome.kind === "open_position_exists") {
        return {
          kind: "open_position_exists",
          accountId: insertOutcome.accountId,
          quantity: insertOutcome.quantity,
          observedAt: insertOutcome.observedAt,
        };
      }
      if (insertOutcome.kind === "position_state_unavailable") {
        return {
          kind: "position_state_unavailable",
          accountId: insertOutcome.accountId,
          reason: insertOutcome.reason,
        };
      }
      if (insertOutcome.kind === "reconciliation_unavailable") {
        return { kind: "reconciliation_unavailable", reason: insertOutcome.reason };
      }
      if (insertOutcome.kind === "reconciliation_stale") {
        return { kind: "reconciliation_stale", ageSeconds: insertOutcome.ageSeconds };
      }
      if (insertOutcome.kind === "reconciliation_hold") {
        return {
          kind: "reconciliation_hold",
          holdId: insertOutcome.holdId,
          reason: insertOutcome.reason,
          severity: insertOutcome.severity,
        };
      }
      if (insertOutcome.kind === "invalid_ticket_shape") {
        return {
          kind: "execution_error",
          order: null,
          message: `invalid_ticket_shape:${insertOutcome.reason}`,
          resumed: false,
        };
      }
      // "inserted"
      const fresh = await deps.repo.getProposedOrderById(insertOutcome.id);
      if (!fresh) {
        return { kind: "execution_error", order: null, message: "insert_read_failed", resumed: false };
      }
      return runThreePhase({
        order: fresh,
        clientOrderId: input.clientOrderId,
        clientOrderHash: input.clientOrderHash,
        metadata,
        resumed: false,
        allowCrossContractExposure,
      });
    },

    async executeProposed(input) {
      const record = await deps.repo.getExecutableProposedById(
        input.proposedOrderId,
      );
      if (!record) return { kind: "not_found" };
      const { order, clientOrderId: cid, clientOrderHash: cHash } = record;
      // §5 REJECTED is immutable — overrideRejected NEVER
      // reactivates the row.
      if (order.status === "REJECTED") {
        return {
          kind: "rejected_order_immutable",
          proposedOrderId: input.proposedOrderId,
        };
      }
      if (order.status !== "PROPOSED") {
        return {
          kind: "submission_identity_mismatch",
          reason: `status_${order.status}`,
        };
      }
      // §2 legacy identity guard. Presence check only — the
      // canonical hash comparison happens inside `runThreePhase`
      // via the shared `validatePersistedOrderIdentity` helper
      // (single implementation of the SignalTicket
      // reconstruction; covers partialTakeProfits + trailing
      // fields).
      if (
        typeof cid !== "string" ||
        cid.length === 0 ||
        typeof cHash !== "string" ||
        cHash.length === 0
      ) {
        await deps.recordAlert({
          severity: "warn",
          kind: "system",
          message: `execute-proposed refused id=${order.id} — LEGACY_IDEMPOTENCY_IDENTITY_MISSING`,
          payload: {
            proposedOrderId: order.id,
            hasClientOrderId: typeof cid === "string",
            hasClientOrderHash: typeof cHash === "string",
          },
        });
        return {
          kind: "legacy_idempotency_identity_missing",
          proposedOrderId: order.id!,
        };
      }
      // Duplicate / marker guards.
      if (order.executionAttemptedAt || order.brokerOrderId) {
        return { kind: "duplicate_pending_ambiguous", order };
      }
      // PR15.2 — cross-contract exposure policy for the legacy
      // proposal path. If the persisted row carries a logical
      // `instrumentId` (a PR15.2 execute-ticket row that ended
      // up in the execute-proposed retry path), resolve the
      // server-side binding and use its registry policy. Legacy
      // rows without `instrumentId` fall back to the hardcoded
      // safe default (`deps.allowCrossContractExposure=false`).
      // A caller cannot influence either branch — no field of
      // the URL / body payload feeds this decision.
      let allowCrossContractExposure = deps.allowCrossContractExposure;
      if (order.instrumentId !== undefined) {
        const bindingCheck = resolveBoundIdentity(deps.bindingAuthority, {
          instrumentId: order.instrumentId,
          instrument: order.instrument,
          conid: typeof order.conid === "string" ? order.conid : null,
          orderType: order.orderType,
        });
        if (bindingCheck.kind !== "ok") return bindingCheck.outcome;
        allowCrossContractExposure =
          bindingCheck.bound.instrument.executionPolicy
            ?.allowCrossContractExposure ?? false;
      }
      const metadata: OrderDecisionMetadata = {
        decisionSource: "user",
        decisionActor: "user",
        ...input.decisionMetadata,
      };
      return runThreePhase({
        order,
        clientOrderId: cid,
        clientOrderHash: cHash,
        metadata,
        resumed: true,
        allowAiDispatch: true,
        allowCrossContractExposure,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// PR15.2 — server-side binding resolution helper (pure).
// ---------------------------------------------------------------------------

interface BoundIdentityInput {
  readonly instrumentId: string | undefined;
  readonly instrument: string;
  readonly conid: string | null;
  /**
   * PR15.2 hostile-review fix — the ticket's `orderType`. Used
   * to enforce `Instrument.executionPolicy.allowedOrderTypes`.
   * Optional so legacy callers that only need identity checks
   * (resume paths, execute-proposed) can omit it.
   */
  readonly orderType?: string;
}

type BoundIdentityResult =
  | {
      readonly kind: "ok";
      readonly bound: BoundInstrument;
    }
  | { readonly kind: "reject"; readonly outcome: SubmissionOutcome };

/**
 * Resolve the payload's claimed `instrumentId` through the
 * server-side `InstrumentBindingAuthority` and verify the
 * broker-facing identity fields (symbol + conId). Every failure
 * short-circuits with a specific `SubmissionOutcome` variant —
 * the caller MUST NOT proceed to persistence or broker dispatch
 * on a rejection.
 *
 * Invariants proven at this boundary:
 *   - missing `instrumentId` in a Phase 2 request → refused;
 *   - unknown / unbound id → refused;
 *   - `trading.executionEnabled=false` → refused;
 *   - `instrument` symbol mismatch → refused;
 *   - `conid` mismatch → refused.
 */
function resolveBoundIdentity(
  authority: InstrumentBindingAuthority,
  input: BoundIdentityInput,
): BoundIdentityResult {
  const id = input.instrumentId?.trim();
  if (!id) {
    return {
      kind: "reject",
      outcome: {
        kind: "instrument_binding_unavailable",
        reason: "instrument_id_missing",
      },
    };
  }
  const bound = authority.getBoundInstrument(id);
  if (!bound) {
    return {
      kind: "reject",
      outcome: {
        kind: "instrument_binding_unavailable",
        reason: `instrument_id_not_bound:${id}`,
      },
    };
  }
  if (!bound.instrument.trading.executionEnabled) {
    return {
      kind: "reject",
      outcome: {
        kind: "instrument_execution_disabled",
        instrumentId: id,
      },
    };
  }
  if (input.instrument !== bound.brokerSymbol) {
    return {
      kind: "reject",
      outcome: {
        kind: "binding_identity_mismatch",
        reason: `symbol_mismatch:payload=${input.instrument},bound=${bound.brokerSymbol}`,
      },
    };
  }
  const wantConid = String(bound.conId);
  if (input.conid === null) {
    return {
      kind: "reject",
      outcome: {
        kind: "binding_identity_mismatch",
        reason: "conid_missing",
      },
    };
  }
  if (input.conid !== wantConid) {
    return {
      kind: "reject",
      outcome: {
        kind: "binding_identity_mismatch",
        reason: `conid_mismatch:payload=${input.conid},bound=${wantConid}`,
      },
    };
  }
  // PR15.2 hostile-review fix — the server-side registry MUST
  // publish an `executionPolicy` for every bound Phase 2 ticket.
  // Absence means the operator flipped `executionEnabled=true`
  // without configuring the order-critical parameters — refuse
  // rather than fall back to any caller-supplied value.
  const policy = bound.instrument.executionPolicy;
  if (!policy) {
    return {
      kind: "reject",
      outcome: {
        kind: "instrument_policy_unavailable",
        instrumentId: id,
      },
    };
  }
  // Order type must be one the registry policy allows for this
  // instrument. `MKT` is separately forbidden upstream — this
  // gate ADDS the per-instrument allow-list on top.
  if (input.orderType !== undefined) {
    if (!policy.allowedOrderTypes.includes(input.orderType as "LMT" | "STP")) {
      return {
        kind: "reject",
        outcome: {
          kind: "order_type_not_allowed_by_instrument_policy",
          instrumentId: id,
          orderType: input.orderType,
          allowedOrderTypes: policy.allowedOrderTypes,
        },
      };
    }
  }
  // Trusted registry policy's `priceTickSize` MUST match the
  // operator-configured, broker-verified `bound.minTick`. A
  // divergence means either the seed is out of date with the
  // dated contract, or the operator misconfigured the binding
  // — either way, refuse to build a ticket.
  if (!isWseBound(bound) && !tickSizesEqual(policy.priceTickSize, bound.minTick)) {
    return {
      kind: "reject",
      outcome: {
        kind: "instrument_tick_mismatch",
        instrumentId: id,
        policyTick: policy.priceTickSize,
        boundTick: bound.minTick,
      },
    };
  }
  return { kind: "ok", bound };
}
