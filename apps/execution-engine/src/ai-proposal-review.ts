import type { Pool, PoolClient } from "pg";
import type { ProposedOrder } from "@ikbr/shared";

export interface AiProposalReview {
  proposed_order_id: number;
  client_order_hash: string;
  instrument_id: string;
  conid: string;
  account_id: string;
  session_id: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  expires_at: Date;
  decision_json: { decision: string; reason: string; confidence: number; model: string; promptVersion: string } | null;
  delivery_started_at: Date | null;
  database_now: Date;
}

export async function readAiProposalReview(db: Pool | PoolClient, id: number, lock = false): Promise<AiProposalReview | null> {
  const result = await db.query<AiProposalReview>(`SELECT *, clock_timestamp() AS database_now
    FROM proposal_ai_reviews WHERE proposed_order_id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
  return result.rows[0] ?? null;
}

export function aiApprovalFailure(review: AiProposalReview | null, order: ProposedOrder,
  hash: string, accountId?: string, sessionId?: string): string | undefined {
  if (!review) return "ai_review_missing";
  if (Number(review.proposed_order_id) !== order.id || review.client_order_hash !== hash ||
    review.instrument_id !== order.instrumentId || review.conid !== order.conid ||
    (accountId !== undefined && review.account_id !== accountId) ||
    (sessionId !== undefined && review.session_id !== sessionId)) return "ai_review_identity_mismatch";
  if (review.expires_at.getTime() <= review.database_now.getTime()) return "ai_review_expired";
  if (review.status !== "APPROVED") return `ai_review_${review.status.toLowerCase()}`;
  const decision = review.decision_json;
  if (!review.delivery_started_at || !decision || decision.decision !== "EXECUTE" ||
    typeof decision.reason !== "string" || !decision.reason.trim() ||
    typeof decision.model !== "string" || !decision.model.trim() ||
    typeof decision.promptVersion !== "string" || !decision.promptVersion.trim() ||
    !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1)
    return "ai_review_invalid_decision";
  return undefined;
}

export async function expireAiProposals(db: PoolClient): Promise<void> {
  const expired = await db.query<{ id: number }>(`SELECT p.id FROM proposed_orders p
    JOIN proposal_ai_reviews r ON r.proposed_order_id=p.id
    WHERE p.status='PROPOSED' AND p.execution_attempted_at IS NULL AND p.broker_order_id IS NULL
      AND r.status IN ('PENDING','APPROVED') AND r.expires_at <= clock_timestamp()
    ORDER BY p.id FOR UPDATE OF p SKIP LOCKED`);
  for (const { id } of expired.rows) {
    await db.query(`UPDATE proposal_ai_reviews SET status='EXPIRED' WHERE proposed_order_id=$1
      AND status IN ('PENDING','APPROVED') AND expires_at <= clock_timestamp()`, [id]);
    await db.query(`UPDATE proposed_orders SET status='EXPIRED', last_error='ai_review_expired'
      WHERE id=$1 AND status='PROPOSED' AND execution_attempted_at IS NULL AND broker_order_id IS NULL`, [id]);
  }
}

export async function findAccountReservation(db: PoolClient, accountId: string, exceptId?: number) {
  const result = await db.query<{ id: number; status: "PROPOSED" | "SUBMITTED"; client_order_id: string | null }>(`
    SELECT p.id,p.status,p.client_order_id FROM proposed_orders p
    LEFT JOIN proposal_ai_reviews r ON r.proposed_order_id=p.id
    WHERE p.status IN ('PROPOSED','SUBMITTED') AND ($2::bigint IS NULL OR p.id<>$2)
      AND (r.account_id=$1 OR p.execution_account_id=$1 OR r.proposed_order_id IS NULL)
    ORDER BY p.id LIMIT 1`, [accountId, exceptId ?? null]);
  return result.rows[0];
}
