import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { SignalTicket } from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import {
  ExecutionRepository,
  validatePersistedOrderIdentity,
} from "../repository.js";
import { deriveParentOrderRef } from "../reconciliation/order-ref.js";
import type { LifecycleEvidence, LifecycleLegLink } from "./ownership.js";
import type {
  CloseContext,
  CloseEvaluator,
  CloseOperation,
  CloseLegIdentity,
  CloseTerminalEvidence,
  CloseState,
  ClosePrepared,
  CloseRisk,
} from "./close-types.js";
export class CloseConflict extends Error {}
export const closeOptions = (
  op: CloseOperation,
  mode: "initial" | "cancelling" | "after_cancel" | "reconcile",
) => ({
  mode,
  terminals: op.terminals,
  closeLink: op.closeLink,
  barrierAt: op.barrierAt,
  originalGeneration: op.generation,
  originalSessionId: op.sessionId,
});
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;
export class CloseRepository {
  constructor(
    readonly pool: Pool,
    readonly execution: ExecutionRepository,
  ) {}
  private async read(
    db: Pool | PoolClient,
    originalId: number,
    lock = false,
  ): Promise<CloseOperation | null> {
    const r = await db.query(
      `SELECT * FROM lifecycle_close_operations WHERE original_proposal_id=$1${lock ? " FOR UPDATE" : ""}`,
      [originalId],
    );
    const v = r.rows[0];
    if (!v) return null;
    let closeLink: LifecycleLegLink | null = null;
    if (v.close_proposal_id) {
      const links = await db.query<LifecycleLegLink>(
        `SELECT * FROM broker_order_links WHERE proposed_order_id=$1`,
        [v.close_proposal_id],
      );
      if (links.rows.length !== 1)
        throw new CloseConflict("close_plan_links_invalid");
      closeLink = {
        ...links.rows[0],
        proposed_order_id: Number(links.rows[0].proposed_order_id),
      };
    }
    return {
      id: Number(v.id),
      originalProposalId: Number(v.original_proposal_id),
      requestId: v.request_id,
      accountId: v.account_id,
      sessionId: v.session_id,
      clientId: v.client_id,
      generation: Number(v.socket_generation),
      originalHash: v.original_hash,
      instrumentId: v.instrument_id,
      conid: v.conid,
      limitPrice: Number(v.limit_price),
      state: v.state,
      owner: v.owner,
      terminals: v.terminals,
      cancelAttempts: v.cancel_attempts,
      barrierAt: iso(v.barrier_at),
      closeProposalId: v.close_proposal_id ? Number(v.close_proposal_id) : null,
      closeLink,
      submissionAttemptedAt: iso(v.submission_attempted_at),
      observation: v.observation,
      failureReason: v.failure_reason,
    };
  }
  get(id: number) {
    return this.read(this.pool, id);
  }
  private async transaction<T>(
    account: string,
    fn: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
        `snap:${account}`,
      ]);
      const value = await fn(db);
      await db.query("COMMIT");
      return value;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async evidence(op: CloseOperation, db?: PoolClient) {
    return this.execution.getLifecycleEvidence(
      op.originalProposalId,
      op.accountId,
      db,
      op.closeProposalId,
    );
  }
  async reserve(
    originalId: number,
    requestId: string,
    limitPrice: number,
    actor: string,
    context: CloseContext,
    evaluate: CloseEvaluator,
  ): Promise<{
    operation: CloseOperation;
    created: boolean;
  }> {
    return this.transaction(context.accountId, async (db) => {
      const existing = await this.read(db, originalId, true);
      if (existing) {
        if (
          existing.requestId !== requestId ||
          existing.limitPrice !== limitPrice ||
          existing.accountId !== context.accountId
        )
          throw new CloseConflict("close_request_conflict");
        return { operation: existing, created: false };
      }
      const evidence = await this.execution.getLifecycleEvidence(
        originalId,
        context.accountId,
        db,
      );
      if (!evidence) throw new CloseConflict("original_proposal_missing");
      const report = evaluate(
        evidence,
        { ...context, nowMs: Date.now() },
        { mode: "initial", terminals: [], closeLink: null, barrierAt: null },
      );
      if (!report.ok) throw new CloseConflict(report.reasons.join(","));
      const active = await db.query(
        `SELECT p.id FROM proposed_orders p LEFT JOIN proposal_ai_reviews r ON r.proposed_order_id=p.id WHERE p.id<>$1 AND p.status IN ('PROPOSED','SUBMITTED') AND (p.execution_account_id=$2 OR r.account_id=$2 OR (p.execution_account_id IS NULL AND r.account_id IS NULL)) LIMIT 1`,
        [originalId, context.accountId],
      );
      const other = await db.query(
        `SELECT id FROM lifecycle_close_operations WHERE account_id=$1 AND state<>'COMPLETED'`,
        [context.accountId],
      );
      if (active.rowCount || other.rowCount)
        throw new CloseConflict("account_reserved");
      await db.query(
        `INSERT INTO lifecycle_close_operations(original_proposal_id,request_id,account_id,session_id,client_id,socket_generation,original_hash,instrument_id,conid,limit_price,owner,actor,state,observation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          originalId,
          requestId,
          context.accountId,
          context.sessionId,
          context.clientId,
          context.generation,
          evidence.clientOrderHash,
          evidence.order.instrumentId,
          evidence.order.conid,
          limitPrice,
          randomUUID(),
          actor,
          report.canComplete ? "COMPLETED" : "PREPARING",
          JSON.stringify(report),
        ],
      );
      if (report.canComplete)
        await db.query(
          "UPDATE proposed_orders SET status='FILLED' WHERE id=$1 AND status IN ('PROPOSED','SUBMITTED')",
          [originalId],
        );
      return { operation: (await this.read(db, originalId))!, created: true };
    });
  }
  async markCancel(
    op: CloseOperation,
    leg: CloseLegIdentity,
    context: CloseContext,
    evaluate: CloseEvaluator,
  ): Promise<void> {
    await this.transaction(op.accountId, async (db) => {
      const current = await this.owned(db, op);
      const evidence = await this.evidence(current, db);
      if (!evidence) throw new CloseConflict("original_missing");
      this.identity(current, evidence, context);
      const report = evaluate(
        evidence,
        { ...context, nowMs: Date.now() },
        closeOptions(current, "cancelling"),
      );
      const actual = report.legs.find((v) => v.role === leg.role);
      if (
        !report.ok ||
        !actual?.working ||
        JSON.stringify(actual) !== JSON.stringify(leg) ||
        current.cancelAttempts.some((v) => v.role === leg.role)
      )
        throw new CloseConflict("cancel_authority_changed");
      await db.query(
        `UPDATE lifecycle_close_operations SET cancel_attempts=cancel_attempts || $2::jsonb,updated_at=clock_timestamp() WHERE id=$1`,
        [op.id, JSON.stringify([leg])],
      );
    });
  }
  async recordTerminal(
    op: CloseOperation,
    terminal: CloseTerminalEvidence,
  ): Promise<void> {
    await this.transaction(op.accountId, async (db) => {
      const current = await this.owned(db, op);
      const attempted = current.cancelAttempts.find(
        (v) => v.role === terminal.role,
      );
      if (
        !attempted ||
        terminal.status !== "CANCELLED" ||
        terminal.generation !== op.generation ||
        terminal.sessionId !== op.sessionId ||
        !Number.isFinite(Date.parse(terminal.confirmedAt)) ||
        [
          "accountId",
          "conid",
          "brokerOrderId",
          "orderRef",
          "permId",
          "clientId",
        ].some(
          (k) =>
            attempted[k as keyof CloseLegIdentity] !==
            terminal[k as keyof CloseTerminalEvidence],
        )
      )
        throw new CloseConflict("cancel_ack_identity_mismatch");
      if (current.terminals.some((v) => v.role === terminal.role))
        throw new CloseConflict("duplicate_cancel_ack");
      await db.query(
        `UPDATE lifecycle_close_operations SET terminals=terminals || $2::jsonb,barrier_at=$3,updated_at=clock_timestamp() WHERE id=$1`,
        [op.id, JSON.stringify([terminal]), terminal.confirmedAt],
      );
    });
  }
  private identity(op: CloseOperation, e: LifecycleEvidence, c: CloseContext) {
    if (
      op.accountId !== c.accountId ||
      op.sessionId !== c.sessionId ||
      op.generation !== c.generation ||
      op.clientId !== c.clientId ||
      op.originalHash !== e.clientOrderHash ||
      op.instrumentId !== e.order.instrumentId ||
      op.conid !== e.order.conid
    )
      throw new CloseConflict("close_identity_changed");
  }
  private async owned(db: PoolClient, op: CloseOperation) {
    const current = await this.read(db, op.originalProposalId, true);
    if (
      !current ||
      current.owner !== op.owner ||
      current.state !== "PREPARING" ||
      current.submissionAttemptedAt
    )
      throw new CloseConflict("close_not_owned");
    const immutable: (keyof CloseOperation)[] = [
      "id",
      "originalProposalId",
      "requestId",
      "limitPrice",
      "accountId",
      "sessionId",
      "generation",
      "clientId",
      "instrumentId",
      "conid",
      "originalHash",
    ];
    if (immutable.some((key) => current[key] !== op[key]))
      throw new CloseConflict("close_operation_identity_changed");
    return current;
  }
  async block(
    op: CloseOperation,
    state: Extract<
      CloseState,
      "BLOCKED" | "CANCEL_UNKNOWN" | "SUBMISSION_UNKNOWN"
    >,
    reason: string,
  ) {
    await this.pool.query(
      `UPDATE lifecycle_close_operations SET state=$3,failure_reason=$4,updated_at=clock_timestamp() WHERE id=$1 AND owner=$2 AND state<>'COMPLETED'`,
      [op.id, op.owner, state, reason],
    );
    return (await this.get(op.originalProposalId))!;
  }
  async claimAlert(op: CloseOperation, reason: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE lifecycle_close_operations SET alerted_reason=$2 WHERE id=$1 AND state<>'COMPLETED' AND failure_reason=$2 AND alerted_reason IS DISTINCT FROM $2 RETURNING id",
      [op.id, reason],
    );
    return result.rowCount === 1;
  }
  async observe(
    op: CloseOperation,
    context: CloseContext,
    evaluate: CloseEvaluator,
  ) {
    return this.transaction(op.accountId, async (db) => {
      const current = (await this.read(db, op.originalProposalId, true))!;
      const evidence = await this.evidence(current, db);
      if (!evidence) throw new CloseConflict("original_missing");
      const report = evaluate(
        evidence,
        { ...context, nowMs: Date.now() },
        closeOptions(current, "reconcile"),
      );
      if (
        current.originalProposalId !== evidence.order.id ||
        current.instrumentId !== evidence.order.instrumentId ||
        current.conid !== evidence.order.conid ||
        current.accountId !== evidence.order.executionAccountId ||
        current.originalHash !== evidence.clientOrderHash ||
        current.accountId !== context.accountId
      ) {
        report.ok = false;
        report.canComplete = false;
        report.reasons.push("close_original_operation_identity_changed");
      }
      if (current.closeProposalId) {
        const close = await this.execution.getLifecycleEvidence(
          current.closeProposalId,
          current.accountId,
          db,
        );
        const value = close?.order;
        if (
          !close ||
          !value ||
          !validatePersistedOrderIdentity(value, close.clientOrderHash).ok ||
          value.instrumentId !== current.instrumentId ||
          value.conid !== current.conid ||
          value.executionAccountId !== current.accountId ||
          value.side !== "SELL" ||
          value.positionEffect !== "CLOSE_OR_REDUCE" ||
          value.quantity !== 1 ||
          value.orderType !== "LMT" ||
          value.entry !== current.limitPrice ||
          !value.executionAttemptedAt ||
          !current.submissionAttemptedAt
        ) {
          report.ok = false;
          report.canComplete = false;
          report.reasons.push("close_persisted_identity_invalid");
        }
      }
      const complete =
        report.ok &&
        report.canComplete &&
        context.accountId === current.accountId &&
        evidence.clientOrderHash === current.originalHash;
      const missingClose = Boolean(
        current.submissionAttemptedAt &&
          report.ok &&
          !report.closeWorking &&
          (report.residualQuantity ?? 0) > 0,
      );
      const observationReason = missingClose
        ? "close_order_missing_with_residual_position"
        : !report.ok
          ? `close_observation_unresolved:${report.reasons.join(",")}`
          : null;
      await db.query(
        `UPDATE lifecycle_close_operations SET observation=$2,state=CASE WHEN $3 THEN 'COMPLETED' WHEN $4 THEN 'SUBMISSION_UNKNOWN' ELSE state END,failure_reason=CASE WHEN $3 THEN NULL ELSE COALESCE($5,failure_reason) END,updated_at=clock_timestamp() WHERE id=$1`,
        [
          op.id,
          JSON.stringify(report),
          complete,
          missingClose,
          observationReason,
        ],
      );
      if (complete) {
        if (current.closeProposalId)
          await db.query(
            "UPDATE proposed_orders SET status='FILLED',broker_order_id=$2,executed_at=COALESCE(executed_at,clock_timestamp()) WHERE id=$1 AND status IN ('PROPOSED','SUBMITTED')",
            [current.closeProposalId, current.closeLink!.broker_order_id],
          );
        const parentFilled =
          report.legs.find((leg) => leg.role === "PARENT")?.fullyFilled ===
          true;
        await db.query(
          "UPDATE proposed_orders SET status=$2 WHERE id=$1 AND status IN ('PROPOSED','SUBMITTED')",
          [current.originalProposalId, parentFilled ? "FILLED" : "CANCELLED"],
        );
      }
      return (await this.read(db, op.originalProposalId))!;
    });
  }
  async claim(
    op: CloseOperation,
    ticket: SignalTicket,
    prepared: ClosePrepared,
    risk: CloseRisk,
    context: CloseContext,
    evaluate: CloseEvaluator,
    validatePrepared: () => void,
  ) {
    return this.transaction(op.accountId, async (db) => {
      const current = await this.owned(db, op);
      const evidence = await this.evidence(current, db);
      if (!evidence) throw new CloseConflict("original_missing");
      this.identity(current, evidence, context);
      const report = evaluate(
        evidence,
        { ...context, nowMs: Date.now() },
        closeOptions(current, "after_cancel"),
      );
      if (
        !report.ok ||
        report.quantity !== 1 ||
        !report.allTerminal ||
        report.legs.some((v) => v.working)
      )
        throw new CloseConflict("close_claim_evidence_invalid");
      if (
        !risk.ok ||
        Date.parse(risk.expiresAt) <= Date.now() ||
        !Number.isFinite(Date.parse(risk.expiresAt))
      )
        throw new CloseConflict("close_risk_expired");
      const riskEvidence = risk.evidence as Record<string, unknown> | null;
      if (
        !riskEvidence ||
        riskEvidence.accountId !== op.accountId ||
        riskEvidence.sessionId !== op.sessionId ||
        riskEvidence.clientId !== op.clientId ||
        riskEvidence.generation !== op.generation ||
        riskEvidence.instrumentId !== op.instrumentId ||
        riskEvidence.conid !== op.conid ||
        riskEvidence.orderHash !== computeClientOrderHash(ticket) ||
        riskEvidence.expiresAt !== risk.expiresAt
      )
        throw new CloseConflict("close_risk_identity_invalid");
      validatePrepared();
      const hash = computeClientOrderHash(ticket);
      const p = prepared.persistence;
      const leg = p.legs[0];
      const clientOrderId = `close-${op.requestId}`;
      if (
        ticket.side !== "SELL" ||
        ticket.positionEffect !== "CLOSE_OR_REDUCE" ||
        ticket.orderType !== "LMT" ||
        ticket.quantity !== 1 ||
        ticket.entry !== op.limitPrice ||
        ticket.instrumentId !== op.instrumentId ||
        ticket.conid !== op.conid ||
        ticket.instrument !== evidence.order.instrument ||
        ticket.stop !== undefined ||
        ticket.takeProfit !== undefined ||
        ticket.trailingStopPct !== undefined ||
        ticket.trailingStopActivationR !== undefined ||
        (ticket.partialTakeProfits?.length ?? 0) > 0 ||
        ticket.riskCheckStatus !== "PASS" ||
        computeClientOrderHash(prepared.normalizedTicket) !== hash ||
        prepared.normalizedTicket.instrumentId !== op.instrumentId ||
        p.clientOrderId !== clientOrderId ||
        p.clientOrderHash !== hash ||
        p.instrumentId !== op.instrumentId ||
        p.instrument !== ticket.instrument ||
        p.conid !== op.conid ||
        p.legs.length !== 1 ||
        leg.role !== "PARENT" ||
        leg.roleOrdinal !== 0 ||
        !/^\d+$/.test(leg.brokerOrderId) ||
        leg.orderRef !== deriveParentOrderRef(clientOrderId)
      )
        throw new CloseConflict("invalid_close_plan");
      const competing = await db.query(
        `SELECT id FROM proposed_orders WHERE id<>$1 AND status IN ('PROPOSED','SUBMITTED') AND (execution_account_id=$2 OR execution_account_id IS NULL) LIMIT 1`,
        [op.originalProposalId, op.accountId],
      );
      if (competing.rowCount) throw new CloseConflict("account_intent_changed");
      const inserted = await db.query(
        `INSERT INTO proposed_orders(instrument,instrument_id,conid,side,position_effect,order_type,quantity,entry,reason,confidence,risk_check_status,status,strategy,decision_source,decision_actor,client_order_id,client_order_hash,execution_account_id,execution_attempted_at,processing_owner) VALUES($1,$2,$3,'SELL','CLOSE_OR_REDUCE','LMT',1,$4,$5,1,'PASS','PROPOSED',$6,'user','user',$7,$8,$9,clock_timestamp(),$10) RETURNING id`,
        [
          ticket.instrument,
          op.instrumentId,
          op.conid,
          op.limitPrice,
          ticket.reason,
          evidence.order.strategy,
          clientOrderId,
          hash,
          op.accountId,
          op.owner,
        ],
      );
      const id = Number(inserted.rows[0].id);
      await db.query(
        `INSERT INTO broker_order_links(proposed_order_id,account_id,role,role_ordinal,broker_order_id,order_ref,status) VALUES($1,$2,'PARENT',0,$3,$4,'PLANNED')`,
        [id, op.accountId, leg.brokerOrderId, leg.orderRef],
      );
      await db.query(
        `INSERT INTO broker_order_ref_map(broker_order_ref,client_order_id,proposed_order_id,role) VALUES($1,$2,$3,'PARENT')`,
        [leg.orderRef, clientOrderId, id],
      );
      await db.query(
        `UPDATE lifecycle_close_operations SET close_proposal_id=$2,risk_evidence=$3,prepared_plan=$4,submission_attempted_at=clock_timestamp(),state='SUBMISSION_UNKNOWN',observation=$5,updated_at=clock_timestamp() WHERE id=$1`,
        [
          op.id,
          id,
          JSON.stringify(risk.evidence),
          JSON.stringify(prepared.payload, (_key, value: unknown) =>
            value instanceof Set ? [...value] : value,
          ),
          JSON.stringify(report),
        ],
      );
      const finalEvidence = await this.execution.getLifecycleEvidence(
        op.originalProposalId,
        op.accountId,
        db,
        id,
      );
      if (!finalEvidence) throw new CloseConflict("original_missing");
      this.identity(current, finalEvidence, context);
      const finalReport = evaluate(
        finalEvidence,
        { ...context, nowMs: Date.now() },
        closeOptions(current, "after_cancel"),
      );
      if (
        !finalReport.ok ||
        finalReport.quantity !== 1 ||
        !finalReport.allTerminal ||
        Date.parse(risk.expiresAt) <= Date.now()
      )
        throw new CloseConflict("close_claim_expired");
      validatePrepared();
      return (await this.read(db, op.originalProposalId))!;
    });
  }
  async submitted(op: CloseOperation) {
    await this.transaction(op.accountId, async (db) => {
      await db.query(
        `UPDATE lifecycle_close_operations SET state='SUBMITTED',updated_at=clock_timestamp() WHERE id=$1 AND owner=$2 AND state='SUBMISSION_UNKNOWN' AND submission_attempted_at IS NOT NULL`,
        [op.id, op.owner],
      );
      await db.query(
        `UPDATE proposed_orders SET status='SUBMITTED',broker_order_id=$2 WHERE id=$1 AND status='PROPOSED'`,
        [op.closeProposalId, op.closeLink?.broker_order_id],
      );
    });
    return (await this.get(op.originalProposalId))!;
  }
}
