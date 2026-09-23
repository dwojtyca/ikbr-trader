import { Pool } from "pg";
import { IndicatorSnapshot, ProposedOrder, Side } from "@ikbr/shared";

export interface ClaimedOrderRow {
  id: number;
  instrument: string;
  conid: string | null;
  side: Side;
  position_effect: "OPEN_OR_ADD" | "CLOSE_OR_REDUCE" | null;
  order_type: "MKT" | "LMT" | "STP";
  quantity: number;
  entry: number | null;
  stop: number | null;
  take_profit: number | null;
  reason: string;
  confidence: number;
  risk_check_status: "PASS" | "REJECT";
  status: string;
  strategy: string | null;
  indicator_snapshot: IndicatorSnapshot | string | null;
  created_at: Date | string;
}

export interface ClaimedOrder extends ProposedOrder {
  id: number;
}

export interface LlmDecisionInsert {
  proposedOrderId: number;
  symbol: string;
  decision: "EXECUTE" | "REJECT";
  decisionReason: string;
  model?: string;
  promptVersion?: string;
  decisionConfidence?: number;
  newsCount: number;
  positionSnapshotJson?: unknown;
  newsSnapshotJson?: unknown;
  sourceError?: string;
}

export class LlmAgentRepository {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS llm_order_decisions (
        id BIGSERIAL PRIMARY KEY,
        proposed_order_id BIGINT NOT NULL REFERENCES proposed_orders(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        decision TEXT NOT NULL,
        decision_reason TEXT NOT NULL,
        model TEXT,
        prompt_version TEXT,
        decision_confidence DOUBLE PRECISION,
        news_count INTEGER NOT NULL DEFAULT 0,
        position_snapshot_json JSONB,
        news_snapshot_json JSONB,
        source_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Older deployments created this table without ON DELETE CASCADE, which
    // broke proposed_orders retention cleanup. Re-add the FK with CASCADE
    // semantics if the existing constraint lacks it.
    await this.pool
      .query(
        `ALTER TABLE llm_order_decisions
         DROP CONSTRAINT IF EXISTS llm_order_decisions_proposed_order_id_fkey;`,
      )
      .catch(() => undefined);
    await this.pool
      .query(
        `ALTER TABLE llm_order_decisions
         ADD CONSTRAINT llm_order_decisions_proposed_order_id_fkey
         FOREIGN KEY (proposed_order_id)
         REFERENCES proposed_orders(id)
         ON DELETE CASCADE;`,
      )
      .catch(() => undefined);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS llm_order_decisions_order_idx
      ON llm_order_decisions (proposed_order_id, created_at DESC);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS llm_order_decisions_symbol_idx
      ON llm_order_decisions (symbol, created_at DESC);
    `);

    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS processing_owner TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS processing_claimed_at TIMESTAMPTZ;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS decision_source TEXT NOT NULL DEFAULT 'signal';`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS decision_actor TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_decision TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_reason TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_model TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_decision_confidence DOUBLE PRECISION;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS llm_decision_id BIGINT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS source_error TEXT;`,
    );
  }

  /**
   * Claim the next unclaimed `PROPOSED` row for LLM adjudication.
   *
   * PR15.3 fail-closed isolation: the WHERE clause requires
   * `decision_source = 'signal'`. Rows created by the Phase 2
   * trading loop / `/execution/execute-ticket` path carry
   * `decision_source = 'user'` (set in
   * `apps/execution-engine/src/repository.ts::insertProposedFromTicket`)
   * and MUST NOT be picked up here. Without this filter the
   * llm-agent could race the Phase 2 E2E window in the short
   * interval between the INSERT commit and the atomic marker
   * transaction inside `runThreePhase`, waste LLM/News budget on a
   * ticket it does not own, and add ambiguity to the audit trail.
   * Legacy signal-engine rows (default `decision_source = 'signal'`
   * from the base migration / signal-engine `runAndPersist`) keep
   * flowing through unchanged.
   */
  async claimNextProposed(
    workerId: string,
    staleMs: number,
  ): Promise<ClaimedOrder | null> {
    const result = await this.pool.query(
      `
      WITH candidate AS (
        SELECT id
        FROM proposed_orders
        WHERE status = 'PROPOSED'
          AND decision_source = 'signal'
          AND instrument_id IS NULL
          AND (
            processing_claimed_at IS NULL
            OR processing_claimed_at < NOW() - (($2::BIGINT || ' milliseconds')::interval)
          )
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE proposed_orders po
      SET processing_owner = $1,
          processing_claimed_at = NOW()
      FROM candidate
      WHERE po.id = candidate.id
      RETURNING po.id, po.instrument, po.conid, po.side, po.position_effect,
                po.order_type, po.quantity, po.entry, po.stop, po.take_profit,
                po.reason, po.confidence, po.risk_check_status, po.status,
                po.strategy, po.indicator_snapshot, po.created_at
      `,
      [workerId, staleMs],
    );

    if (!result.rows[0]) return null;
    return this.mapClaimedOrder(result.rows[0] as ClaimedOrderRow);
  }

  async releaseClaim(orderId: number, workerId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET processing_owner = NULL,
          processing_claimed_at = NULL
      WHERE id = $1
        AND processing_owner = $2
      `,
      [orderId, workerId],
    );
  }

  async deleteProposedOrderIfPending(orderId: number): Promise<boolean> {
    const result = await this.pool.query(
      `
      DELETE FROM proposed_orders
      WHERE id = $1
        AND status = 'PROPOSED'
      `,
      [orderId],
    );

    return Number(result.rowCount ?? 0) > 0;
  }

  async insertDecision(input: LlmDecisionInsert): Promise<number> {
    const result = await this.pool.query(
      `
      INSERT INTO llm_order_decisions (
        proposed_order_id,
        symbol,
        decision,
        decision_reason,
        model,
        prompt_version,
        decision_confidence,
        news_count,
        position_snapshot_json,
        news_snapshot_json,
        source_error,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, NOW()
      )
      RETURNING id
      `,
      [
        input.proposedOrderId,
        input.symbol.toUpperCase(),
        input.decision,
        input.decisionReason,
        input.model ?? null,
        input.promptVersion ?? null,
        input.decisionConfidence ?? null,
        input.newsCount,
        input.positionSnapshotJson
          ? JSON.stringify(input.positionSnapshotJson)
          : null,
        input.newsSnapshotJson ? JSON.stringify(input.newsSnapshotJson) : null,
        input.sourceError ?? null,
      ],
    );

    return Number(result.rows[0].id);
  }

  async updateDecisionError(
    decisionId: number,
    sourceError: string,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE llm_order_decisions
      SET source_error = $2
      WHERE id = $1
      `,
      [decisionId, sourceError],
    );
  }

  async isSymbolInCooldown(
    symbol: string,
    cooldownMs: number,
  ): Promise<boolean> {
    if (cooldownMs <= 0) return false;

    const result = await this.pool.query(
      `
      SELECT 1
      FROM llm_order_decisions
      WHERE symbol = $1
        AND decision_reason NOT ILIKE 'AI reject: cooldown_active%'
        AND created_at >= NOW() - (($2::BIGINT || ' milliseconds')::interval)
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [symbol.toUpperCase(), cooldownMs],
    );

    return Boolean(result.rows[0]);
  }

  mapClaimedOrder(row: ClaimedOrderRow): ClaimedOrder {
    const createdAt =
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at);

    return {
      id: Number(row.id),
      instrument: row.instrument,
      conid: row.conid ?? undefined,
      side: row.side,
      positionEffect: row.position_effect ?? undefined,
      orderType: row.order_type,
      quantity: row.quantity,
      entry: row.entry ?? undefined,
      stop: row.stop ?? undefined,
      takeProfit: row.take_profit ?? undefined,
      reason: row.reason,
      confidence: row.confidence,
      timestamp: createdAt.toISOString(),
      riskCheckStatus: row.risk_check_status,
      status: row.status === "PROPOSED" ? "PROPOSED" : "REJECTED",
      strategy: row.strategy ?? undefined,
      indicators: this.normalizeIndicators(row.indicator_snapshot),
      createdAt,
    };
  }

  private normalizeIndicators(
    value: IndicatorSnapshot | string | null,
  ): IndicatorSnapshot | undefined {
    if (!value) return undefined;
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as IndicatorSnapshot;
      } catch {
        return undefined;
      }
    }
    return value;
  }
}
