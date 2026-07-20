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
import type { ProposedOrder, SignalTicket } from "@ikbr/shared";

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
  readonly allowCrossContractExposure: boolean;
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
      const result = await deps.dispatcher.dispatch({
        proposedOrderId: order.id!,
        accountId,
        prepared,
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
  }): Promise<SubmissionOutcome> {
    const { order, clientOrderId, clientOrderHash, metadata, resumed } = input;
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
    // Phase B — atomic claim + full plan persistence + identity
    // binding under the same tx.
    const positionGuard = await deps.buildPositionGuard();
    const claim = await deps.repo.tryStartSubmissionWithPlan({
      id: validatedOrder.id!,
      owner: deps.ownerId,
      instrument: validatedOrder.instrument,
      conid: typeof validatedOrder.conid === "string" ? validatedOrder.conid : null,
      allowCrossContractExposure: deps.allowCrossContractExposure,
      positionGuard,
      reconciliationGate: deps.reconciliationGate(),
      prepared: {
        clientOrderId,
        clientOrderHash,
        instrument: validatedOrder.instrument,
        conid: typeof validatedOrder.conid === "string" ? validatedOrder.conid : null,
        legs: prepared.legs,
      },
      accountId,
      metadata,
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
            allowCrossContractExposure: deps.allowCrossContractExposure,
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
        return runThreePhase({
          order: raced.order,
          clientOrderId: input.clientOrderId,
          clientOrderHash: input.clientOrderHash,
          metadata,
          resumed: true,
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
      });
    },
  };
}
