import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { LlmAgentRepository, type ClaimedOrder, type ClaimedOrderRow } from "./repository.js";

export interface BoundClaim {
  order: ClaimedOrder;
  proposalSnapshot?: Record<string, unknown>;
  identity: { clientOrderHash: string; instrumentId: string; conid: string; accountId: string; sessionId: string };
  token: string;
}

export interface BoundDecision {
  decision: "EXECUTE" | "REJECT";
  reason: string;
  confidence: number;
  model: string;
  promptVersion: string;
  context: unknown;
}

export type DeliveryOutcome = "SUBMITTED" | "UNKNOWN" | "REFUSED";
export interface BoundReviewStore {
  claim(): Promise<BoundClaim | null>;
  finalize(claim: BoundClaim, decision: BoundDecision): Promise<boolean>;
  recordDelivery(claim: BoundClaim, outcome: DeliveryOutcome): Promise<void>;
}

// Every transaction locks the proposal before its review, matching submission.
export class BoundReviewRepository implements BoundReviewStore {
  constructor(private readonly pool: Pool) {}

  async claim(): Promise<BoundClaim | null> {
    return this.transaction(async (client) => {
      await this.expire(client);
      const selected = await client.query(`
        SELECT po.* FROM proposed_orders po
        JOIN proposal_ai_reviews r ON r.proposed_order_id = po.id
        WHERE po.status = 'PROPOSED' AND po.execution_attempted_at IS NULL
          AND po.broker_order_id IS NULL AND po.instrument_id IS NOT NULL
          AND r.status = 'PENDING' AND r.expires_at > clock_timestamp()
          AND r.delivery_started_at IS NULL
          AND (r.claim_until IS NULL OR r.claim_until <= clock_timestamp())
        ORDER BY po.id LIMIT 1 FOR UPDATE OF po SKIP LOCKED`);
      if (!selected.rows[0]) return null;
      const row = selected.rows[0];
      const token = randomUUID();
      const review = await client.query(`
        UPDATE proposal_ai_reviews SET claim_token = $2::uuid,
          claim_until = clock_timestamp() + interval '30 seconds'
        WHERE proposed_order_id = $1 AND status = 'PENDING'
          AND expires_at > clock_timestamp() AND delivery_started_at IS NULL
          AND (claim_until IS NULL OR claim_until <= clock_timestamp())
          AND client_order_hash = $3 AND instrument_id = $4 AND conid = $5
        RETURNING *`, [row.id, token, row.client_order_hash, row.instrument_id, row.conid]);
      if (!review.rows[0]) return null;
      const r = review.rows[0];
      return {
        order: new LlmAgentRepository(this.pool).mapClaimedOrder(row as ClaimedOrderRow),
        proposalSnapshot: row,
        identity: { clientOrderHash: r.client_order_hash, instrumentId: r.instrument_id,
          conid: r.conid, accountId: r.account_id, sessionId: r.session_id }, token,
      };
    });
  }

  async finalize(claim: BoundClaim, decision: BoundDecision): Promise<boolean> {
    return this.transaction(async (client) => {
      const proposal = await client.query(`SELECT * FROM proposed_orders WHERE id = $1 FOR UPDATE`, [claim.order.id]);
      const row = proposal.rows[0];
      if (!row || row.status !== 'PROPOSED' || row.execution_attempted_at || row.broker_order_id ||
          row.client_order_hash !== claim.identity.clientOrderHash || row.instrument_id !== claim.identity.instrumentId ||
          row.conid !== claim.identity.conid) return false;
      const result = await client.query(`
        UPDATE proposal_ai_reviews
        SET status = $3, decision_json = $4::jsonb, decided_at = clock_timestamp(),
          delivery_started_at = CASE WHEN $3 = 'APPROVED' THEN clock_timestamp() ELSE NULL END
        WHERE proposed_order_id = $1 AND claim_token = $2::uuid
          AND status = 'PENDING' AND decision_json IS NULL
          AND claim_until > clock_timestamp() AND expires_at > clock_timestamp()
          AND delivery_started_at IS NULL AND client_order_hash = $5 AND instrument_id = $6
          AND conid = $7 AND account_id = $8 AND session_id = $9
        RETURNING proposed_order_id`, [claim.order.id, claim.token,
        decision.decision === "EXECUTE" ? "APPROVED" : "REJECTED", JSON.stringify(decision),
        claim.identity.clientOrderHash, claim.identity.instrumentId, claim.identity.conid,
        claim.identity.accountId, claim.identity.sessionId]);
      if (!result.rowCount) return false;
      if (decision.decision === "REJECT") {
        await client.query(`UPDATE proposed_orders SET status = 'REJECTED', execution_message = $2
          WHERE id = $1`, [claim.order.id, `AI reject: ${decision.reason.slice(0, 700)}`]);
      }
      return decision.decision === "EXECUTE";
    });
  }

  async recordDelivery(claim: BoundClaim, outcome: DeliveryOutcome): Promise<void> {
    await this.pool.query(`UPDATE proposal_ai_reviews SET delivery_outcome = $3
      WHERE proposed_order_id = $1 AND claim_token = $2::uuid
        AND status IN ('APPROVED', 'EXPIRED', 'REJECTED') AND delivery_started_at IS NOT NULL
        AND delivery_outcome IS NULL`, [claim.order.id, claim.token, outcome]);
  }

  private async expire(client: PoolClient): Promise<void> {
    const expired = await client.query(`SELECT po.id FROM proposed_orders po
      JOIN proposal_ai_reviews r ON r.proposed_order_id = po.id
      WHERE po.status = 'PROPOSED' AND po.execution_attempted_at IS NULL
        AND po.broker_order_id IS NULL AND r.status IN ('PENDING', 'APPROVED')
        AND r.expires_at <= clock_timestamp()
      ORDER BY po.id FOR UPDATE OF po SKIP LOCKED`);
    for (const row of expired.rows) {
      const result = await client.query(`UPDATE proposal_ai_reviews SET status = 'EXPIRED'
        WHERE proposed_order_id = $1 AND status IN ('PENDING', 'APPROVED')
          AND expires_at <= clock_timestamp()
        RETURNING proposed_order_id`, [row.id]);
      if (result.rowCount) await client.query(`UPDATE proposed_orders
        SET status = 'EXPIRED', last_error = 'ai_review_expired' WHERE id = $1`, [row.id]);
    }
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}
