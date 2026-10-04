import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ResearchStore } from '@ikbr/shared/instrument-research';

export function registerResearchAuditRoute(app: FastifyInstance, deps: { pool: Pool; store: Pick<ResearchStore, 'getBinding' | 'readSnapshot'> }) {
  app.get<{ Params: { id: string } }>('/execution/orders/:id/research', async (request, reply) => {
    const id = Number(request.params.id);
    if (!/^[1-9]\d*$/.test(request.params.id) || !Number.isSafeInteger(id)) return reply.code(400).send({ error: 'invalid_proposal_id' });
    const { rows } = await deps.pool.query(`SELECT p.id,r.status,r.expires_at,r.decision_json,r.risk_evidence,
      c.request_hash,c.request_json,c.started_at,c.deadline_at,o.outcome_json,o.received_at
      FROM proposed_orders p LEFT JOIN proposal_ai_reviews r ON r.proposed_order_id=p.id
      LEFT JOIN proposal_ai_model_calls c ON c.proposed_order_id=p.id
      LEFT JOIN proposal_ai_model_outcomes o ON o.proposed_order_id=p.id WHERE p.id=$1`, [id]);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'proposal_not_found' });
    const binding = await deps.store.getBinding(id);
    const snapshot = binding ? await deps.store.readSnapshot(binding.snapshotId) : null;
    return { proposalId: id, binding, snapshot, review: { status: row.status, expiresAt: row.expires_at,
      decision: row.decision_json, executionRisk: row.risk_evidence },
      modelCall: row.request_hash ? { requestHash: row.request_hash, request: row.request_json, startedAt: row.started_at,
        deadlineAt: row.deadline_at, outcome: row.outcome_json, receivedAt: row.received_at } : null };
  });
}
