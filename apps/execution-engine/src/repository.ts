import { Pool } from 'pg';
import { ProposedOrder, ProposedOrderStatus, SignalTicket, Side } from '@ikbr/shared';
import { BrokerOrderStatusUpdate } from './tws-execution-client.js';

interface ProposedOrderRow {
  id: number;
  instrument: string;
  conid: string | null;
  side: Side;
  position_effect: 'OPEN_OR_ADD' | 'CLOSE_OR_REDUCE' | null;
  order_type: 'MKT' | 'LMT';
  quantity: number;
  entry: number | null;
  stop: number | null;
  take_profit: number | null;
  reason: string;
  confidence: number;
  risk_check_status: 'PASS' | 'REJECT';
  status: string;
  strategy: string | null;
  indicator_snapshot: string | null;
  broker_order_id: string | null;
  execution_account_id: string | null;
  execution_message: string | null;
  last_error: string | null;
  execution_attempted_at: Date | string | null;
  executed_at: Date | string | null;
  created_at: Date | string;
}

export interface OrderListFilters {
  instrument?: string;
  side?: Side;
  orderType?: 'MKT' | 'LMT';
  qty?: number;
  status?: ProposedOrderStatus;
  riskCheckStatus?: 'PASS' | 'REJECT';
}

export class ExecutionRepository {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS proposed_orders (
        id BIGSERIAL PRIMARY KEY,
        instrument TEXT NOT NULL,
        conid TEXT,
        side TEXT NOT NULL,
        position_effect TEXT,
        order_type TEXT NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
        entry DOUBLE PRECISION,
        stop DOUBLE PRECISION,
        take_profit DOUBLE PRECISION,
        reason TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        risk_check_status TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PROPOSED',
        strategy TEXT,
        indicator_snapshot JSONB,
        broker_order_id TEXT,
        execution_account_id TEXT,
        execution_message TEXT,
        last_error TEXT,
        execution_attempted_at TIMESTAMPTZ,
        executed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS broker_order_id TEXT;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_account_id TEXT;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_message TEXT;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS last_error TEXT;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_attempted_at TIMESTAMPTZ;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS position_effect TEXT;`);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_status_idx
      ON proposed_orders (status);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_created_idx
      ON proposed_orders (created_at DESC);
    `);

    // Legacy status cleanup: remove old EXECUTED semantics.
    await this.pool.query(`
      UPDATE proposed_orders
      SET status = 'SUBMITTED',
          executed_at = NULL
      WHERE status = 'EXECUTED'
        AND COALESCE(broker_order_id, '') NOT LIKE 'DRYRUN-%'
    `);
    await this.pool.query(`
      UPDATE proposed_orders
      SET status = 'CANCELLED'
      WHERE status = 'EXECUTED'
        AND COALESCE(broker_order_id, '') LIKE 'DRYRUN-%'
    `);
    await this.pool.query(`
      UPDATE proposed_orders
      SET executed_at = NULL
      WHERE status = 'SUBMITTED'
        AND executed_at IS NOT NULL
    `);
  }

  async insertProposedFromTicket(ticket: SignalTicket, strategy = 'manual_ticket'): Promise<number> {
    const result = await this.pool.query(
      `
      INSERT INTO proposed_orders (
        instrument,
        conid,
        side,
        position_effect,
        order_type,
        quantity,
        entry,
        stop,
        take_profit,
        reason,
        confidence,
        risk_check_status,
        status,
        strategy,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, 'PROPOSED', $13, NOW()
      )
      RETURNING id
      `,
      [
        ticket.instrument,
        ticket.conid ?? null,
        ticket.side,
        ticket.positionEffect ?? null,
        ticket.orderType,
        ticket.quantity,
        ticket.entry ?? null,
        ticket.stop ?? null,
        ticket.takeProfit ?? null,
        ticket.reason,
        ticket.confidence,
        ticket.riskCheckStatus,
        strategy
      ]
    );

    return Number(result.rows[0].id);
  }

  async getProposedOrderById(id: number): Promise<ProposedOrder | null> {
    const result = await this.pool.query(
      `
      SELECT id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
             reason, confidence, risk_check_status, status, strategy, indicator_snapshot,
             broker_order_id, execution_account_id, execution_message, last_error,
             execution_attempted_at, executed_at, created_at
      FROM proposed_orders
      WHERE id = $1
      `,
      [id]
    );

    if (!result.rows[0]) return null;
    return this.mapRow(result.rows[0] as ProposedOrderRow);
  }

  async listOrders(limit: number, filters: OrderListFilters = {}): Promise<ProposedOrder[]> {
    const safeLimit = Math.max(1, Math.min(500, limit));

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filters.instrument) {
      params.push(`%${filters.instrument}%`);
      where.push(`instrument ILIKE $${params.length}`);
    }

    if (filters.side) {
      params.push(filters.side);
      where.push(`side = $${params.length}`);
    }

    if (filters.orderType) {
      params.push(filters.orderType);
      where.push(`order_type = $${params.length}`);
    }

    if (filters.qty !== undefined) {
      params.push(filters.qty);
      where.push(`quantity = $${params.length}`);
    }

    if (filters.status) {
      params.push(filters.status);
      where.push(`status = $${params.length}`);
    }

    if (filters.riskCheckStatus) {
      params.push(filters.riskCheckStatus);
      where.push(`risk_check_status = $${params.length}`);
    }

    params.push(safeLimit);
    const limitParam = `$${params.length}`;
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const result = await this.pool.query(
      `
      SELECT id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
             reason, confidence, risk_check_status, status, strategy, indicator_snapshot,
             broker_order_id, execution_account_id, execution_message, last_error,
             execution_attempted_at, executed_at, created_at
      FROM proposed_orders
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${limitParam}
      `,
      params
    );

    return result.rows.map((row) => this.mapRow(row as ProposedOrderRow));
  }

  async markExecutionAttempt(id: number, accountId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET execution_attempted_at = NOW(),
          execution_account_id = $2
      WHERE id = $1
      `,
      [id, accountId]
    );
  }

  async markSubmitted(id: number, accountId: string, brokerOrderId: string, executionMessage: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'SUBMITTED',
          execution_account_id = $2,
          broker_order_id = $3,
          execution_message = $4,
          last_error = NULL,
          executed_at = NULL,
          execution_attempted_at = COALESCE(execution_attempted_at, NOW())
      WHERE id = $1
      `,
      [id, accountId, brokerOrderId, executionMessage]
    );
  }

  async markFilled(id: number, accountId: string, brokerOrderId: string, executionMessage: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'FILLED',
          execution_account_id = $2,
          broker_order_id = $3,
          execution_message = $4,
          last_error = NULL,
          executed_at = COALESCE(executed_at, NOW()),
          execution_attempted_at = COALESCE(execution_attempted_at, NOW())
      WHERE id = $1
      `,
      [id, accountId, brokerOrderId, executionMessage]
    );
  }

  async markRejected(id: number, reason: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'REJECTED',
          last_error = $2,
          execution_message = $2,
          execution_attempted_at = COALESCE(execution_attempted_at, NOW())
      WHERE id = $1
      `,
      [id, reason]
    );
  }

  async markCancelled(id: number, reason: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'CANCELLED',
          last_error = $2,
          execution_message = $2,
          execution_attempted_at = COALESCE(execution_attempted_at, NOW())
      WHERE id = $1
      `,
      [id, reason]
    );
  }

  async applyBrokerStatusUpdate(update: BrokerOrderStatusUpdate): Promise<void> {
    const status = update.status.toUpperCase();

    if (status === 'FILLED') {
      await this.pool.query(
        `
        UPDATE proposed_orders
        SET status = 'FILLED',
            execution_message = $2,
            last_error = NULL,
            executed_at = COALESCE(executed_at, NOW())
        WHERE broker_order_id = $1
        `,
        [update.brokerOrderId, update.message]
      );
      return;
    }

    if (status === 'SUBMITTED' || status === 'PRESUBMITTED' || status === 'PENDINGSUBMIT') {
      await this.pool.query(
        `
        UPDATE proposed_orders
        SET status = 'SUBMITTED',
            execution_message = $2,
            last_error = NULL
        WHERE broker_order_id = $1
          AND status IN ('PROPOSED', 'SUBMITTED', 'EXECUTED')
        `,
        [update.brokerOrderId, update.message]
      );
      return;
    }

    if (status === 'INACTIVE' || status === 'CANCELLED' || status === 'APICANCELLED') {
      await this.pool.query(
        `
        UPDATE proposed_orders
        SET status = 'CANCELLED',
            execution_message = $2,
            last_error = $2
        WHERE broker_order_id = $1
          AND status <> 'FILLED'
        `,
        [update.brokerOrderId, update.message]
      );
    }
  }

  private mapRow(row: ProposedOrderRow): ProposedOrder {
    const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);

    const out: ProposedOrder = {
      id: row.id,
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
      status: this.normalizeStatus(row.status),
      strategy: row.strategy ?? undefined,
      createdAt
    };

    if (row.broker_order_id !== null) out.brokerOrderId = row.broker_order_id;
    if (row.execution_account_id !== null) out.executionAccountId = row.execution_account_id;
    if (row.execution_message !== null) out.executionMessage = row.execution_message;
    if (row.last_error !== null) out.lastError = row.last_error;
    if (row.execution_attempted_at !== null) {
      out.executionAttemptedAt =
        row.execution_attempted_at instanceof Date ? row.execution_attempted_at : new Date(row.execution_attempted_at);
    }
    if (row.executed_at !== null) {
      out.executedAt = row.executed_at instanceof Date ? row.executed_at : new Date(row.executed_at);
    }

    return out;
  }

  private normalizeStatus(status: string): ProposedOrderStatus {
    const normalized = String(status || '').toUpperCase();
    if (normalized === 'PROPOSED') return 'PROPOSED';
    if (normalized === 'REJECTED') return 'REJECTED';
    if (normalized === 'SUBMITTED' || normalized === 'PRESUBMITTED' || normalized === 'PENDINGSUBMIT') return 'SUBMITTED';
    if (normalized === 'FILLED') return 'FILLED';
    if (normalized === 'CANCELLED' || normalized === 'APICANCELLED' || normalized === 'INACTIVE') return 'CANCELLED';
    // Legacy compatibility.
    if (normalized === 'EXECUTED') return 'SUBMITTED';
    return 'REJECTED';
  }
}
