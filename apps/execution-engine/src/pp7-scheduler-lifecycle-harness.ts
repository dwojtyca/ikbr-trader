import { ReconciliationRunner } from './reconciliation/runner.js';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { BoundInstrument, SignalTicket, StockMarketMetadata } from '@ikbr/shared';
import { computeClientOrderHash } from '@ikbr/shared/client-order-hash';
import { ExecutionRepository } from './repository.js';
import { ReconciliationRepository } from './reconciliation/repository.js';
import type { BrokerReconciliationSnapshot } from './reconciliation/broker-adapter.js';
import { paperAccountDayStart } from './paper-daily-loss.js';
import { deriveParentOrderRef, deriveChildOrderRef } from './reconciliation/order-ref.js';
import type { PreparedBrokerOrder } from './tws-execution-client.js';
import { CloseRepository } from './lifecycle/close-repository.js';
import { FullCloseService } from './lifecycle/close-service.js';
import { evaluateCloseEvidence } from './lifecycle/close-evidence.js';
import { assessCloseRisk, validatePersistedClosePrepared } from './lifecycle/close-risk.js';
import { LifecycleObserver } from './lifecycle/observer.js';
import { LifecycleObserverRepository } from './lifecycle/observer-repository.js';
import type { LifecycleAlertStore } from './lifecycle/lifecycle-alerts.js';
import { stockMetadataFixture } from './stock-market-test-fixture.js';
export function controlledPlan(ticket: SignalTicket, bound: BoundInstrument, accountId: string, clientOrderId: string, close = false): PreparedBrokerOrder {
    const ids = close ? [201] : [101, 102, 103];
    const legs: PreparedBrokerOrder['legs'] = ids.map((id, i) => ({
        role: i === 0 ? 'PARENT' : i === 1 ? 'TP' : 'SL', roleOrdinal: i === 0 ? 0 : 1, brokerOrderId: String(id), orderRef: i === 0 ? deriveParentOrderRef(clientOrderId) : deriveChildOrderRef(clientOrderId, { role: i === 1 ? 'TP' : 'SL', ordinal: 1 })
    }));
    return {
        contract: {
            conId: bound.conId, symbol: bound.brokerSymbol, secType: 'STK', exchange: bound.exchange, currency: bound.currency, primaryExch: bound.instrument.primaryExchange
        }, normalizedTicket: ticket, legs,
        plan: {
            parentOrderId: ids[0], relatedOrderIds: new Set(ids), ...(close ? {} : { bracket: { takeProfitOrderId: 102, stopLossOrderId: 103 } }), orders: ids.map((id, i) => ({
                orderId: id, order: {
                    account: accountId, action: close || i > 0 ? 'SELL' : 'BUY', totalQuantity: 1, orderType: i === 2 ? 'STP' : 'LMT', tif: 'DAY', transmit: close || i === 2, orderRef: legs[i].orderRef,
                    ...(i === 2 ? { auxPrice: ticket.stop } : { lmtPrice: i === 1 ? ticket.takeProfit : ticket.entry }), ...(i > 0 ? { parentId: 101, ocaGroup: 'pp7-bracket', ocaType: 2 } : {})
                }
            }))
        }
    };
}
export async function lifecycleHarness(input: {
    pool: Pool;
    repo: ExecutionRepository;
    bound: BoundInstrument;
    accountId: string;
    sessionId: string;
    alerts: LifecycleAlertStore;
    assertCurrent(): void;
    metadata: StockMarketMetadata;
}) {
    const { pool, repo, bound, accountId, sessionId, alerts } = input;
    const reconciliation = new ReconciliationRepository(pool), closeRepo = new CloseRepository(pool, repo);
    const state = {
        entry: null as PreparedBrokerOrder | null, entryAt: null as Date | null, position: 0, working: [] as string[], close: null as PreparedBrokerOrder | null, closeAt: null as Date | null, closeFilled: false, cancels: [] as string[], closeDispatches: 0
    };
    const context = () => ({ accountId, sessionId, clientId: 7, generation: 1, nowMs: Date.now(), bound });
    async function refresh() {
        const observed = new Date((await pool.query('SELECT clock_timestamp() now')).rows[0].now);
        const { generation } = await repo.beginPositionSnapshotRefresh({ accountId, sessionId, observedAt: observed });
        await repo.completePositionSnapshotRefresh({
            accountId, sessionId, generation, observedAt: observed, positions: state.position ? [{ instrument: bound.brokerSymbol, conid: String(bound.conId), quantity: 1 }] : []
        });
        const db = await pool.connect();
        try {
            const captured = new Date((await db.query('SELECT clock_timestamp() now')).rows[0].now);
            const execution = (plan: PreparedBrokerOrder, at: Date, side: 'BOT' | 'SLD', execId: string) => ({
                accountId, conId: String(bound.conId), symbol: bound.brokerSymbol, secType: 'STK', currency: bound.currency, brokerOrderId: plan.legs[0].brokerOrderId, orderRef: plan.legs[0].orderRef, permId: String(Number(plan.legs[0].brokerOrderId) + 1000), execId, shares: 1, price: plan.normalizedTicket.entry!, side, executedAt: at
            });
            const executions = [
                ...(state.entry && state.entryAt ? [execution(state.entry, state.entryAt, 'BOT', 'pp7-entry')] : []), ...(state.closeFilled && state.close && state.closeAt ? [execution(state.close, state.closeAt, 'SLD', 'pp7-close')] : [])
            ];
            const openOrders = state.working.map(role => { const leg = role === 'CLOSE' ? state.close!.legs[0] : state.entry!.legs.find(l => l.role === role)!; return {
                accountId, conId: String(bound.conId), secType: 'STK', currency: bound.currency, brokerOrderId: leg.brokerOrderId, orderRef: leg.orderRef, permId: String(Number(leg.brokerOrderId) + 1000), clientId: 7, status: 'Submitted', remaining: 1, filled: 0, action: 'SELL', observedAt: captured, orderType: role === 'SL' ? 'STP' : 'LMT', limitPrice: role === 'TP' ? state.entry!.normalizedTicket.takeProfit : state.close?.normalizedTicket.entry, stopPrice: role === 'SL' ? state.entry!.normalizedTicket.stop : undefined, totalQuantity: 1, parentId: role === 'CLOSE' ? '0' : '101', ocaGroup: role === 'CLOSE' ? '' : 'pp7-bracket', ocaType: role === 'CLOSE' ? 0 : 2, tif: 'DAY'
            }; });
            const positions = state.position ? [{ accountId, conId: String(bound.conId), symbol: bound.brokerSymbol, position: 1 }] : [];
            const source = (count: number) => ({ available: true, boundedWindow: true, timedOut: false, count });
            const snapshot: BrokerReconciliationSnapshot = {
                accountId, sessionId, connectionGeneration: 1, capturedAt: captured, exposureComplete: true, recoveryComplete: true, positions, openOrders, executions, completedOrders: [], sourceCoverage: {
                    positions: source(positions.length), openOrders: source(openOrders.length), completedOrders: source(0), session: source(1), executions: {
                        available: true, timedOut: false, count: executions.length, window: {
                            from: new Date(paperAccountDayStart(Date.now())).toISOString(), ...{ certifiedFrom: new Date(paperAccountDayStart(Date.now())).toISOString() }, to: captured.toISOString(), exposureWindowComplete: true, recoveryWindowComplete: true
                        }
                    }
                }
            };
            for (const fill of executions) {
                await repo.upsertBrokerExecutionFill({
                    execId: fill.execId, orderId: Number(fill.brokerOrderId), accountId, conid: fill.conId, symbol: bound.brokerSymbol, currency: bound.currency, secType: 'STK', side: fill.side === 'BOT' ? 'BUY' : 'SELL', shares: 1, price: fill.price, executedAt: fill.executedAt.toISOString()
                });
                await repo.applyBrokerCommissionReport({
                    execId: fill.execId, commission: .1, currency: bound.currency, realizedPnL: fill.side === 'BOT' ? 0 : fill.price - state.entry!.normalizedTicket.entry!
                });
            }
            const runner = new ReconciliationRunner(pool, repo, reconciliation, {
                capture: async () => {
                    const now = new Date((await pool.query('SELECT clock_timestamp() now')).rows[0].now);
                    return {
                        ...snapshot, capturedAt: now, openOrders: snapshot.openOrders.map(order => ({ ...order, observedAt: now })), sourceCoverage: {
                            ...snapshot.sourceCoverage, executions: { ...snapshot.sourceCoverage.executions, window: { ...snapshot.sourceCoverage.executions.window!, to: now.toISOString() } }
                        }
                    };
                }
            }, { info() { }, warn() { }, error() { } });
            const report = await runner.runOnce({ accountId, sessionId, sessionStartedAt: new Date(paperAccountDayStart(Date.now())) }, { runTimeoutMs: 5000, sourceTimeoutMs: 3000, executionSafetyMarginMs: 1000 });
            assert.ok(report, 'isolated fixture runner unexpectedly contended');
            const runId = report.runId;
            const end = (await db.query('SELECT completed_at FROM reconciliation_runs WHERE id=$1', [runId])).rows[0].completed_at.getTime();
            assert.ok(end - Date.now() < 1000, 'test database clock unexpectedly ahead');
            while (Date.now() < end)
                await new Promise(r => setTimeout(r, Math.max(1, end - Date.now())));
        }
        finally {
            db.release();
        }
    }
    const close = new FullCloseService(closeRepo, {
        context, refresh, evaluate: evaluateCloseEvidence, assertManagementAllowed: input.assertCurrent, durableFaults: true,
        assessRisk: async (ticket, b, c) => assessCloseRisk(ticket, b, c, {
            connected: true, watchlist: [
                {
                    instrumentId: b.instrumentId, conid: String(b.conId), subscribed: true, marketState: {
                        conid: String(b.conId), marketDataType: 1, bid: 100.19, ask: 100.21, bidObservedAt: new Date(c.nowMs - 1).toISOString(), askObservedAt: new Date(c.nowMs - 1).toISOString()
                    }
                }
            ]
        }, stockMetadataFixture(b, accountId, c.nowMs)),
        prepare: async (ticket, clientOrderId) => { const payload = controlledPlan(ticket, bound, accountId, clientOrderId, true); return {
            normalizedTicket: ticket, persistence: {
                clientOrderId, clientOrderHash: computeClientOrderHash(ticket), instrument: ticket.instrument, instrumentId: ticket.instrumentId, conid: ticket.conid!, legs: payload.legs
            }, payload
        }; },
        validatePrepared: (p, t, c) => { assert.equal(validatePersistedClosePrepared(p, t, c), null); }, cancel: async (leg, c) => { state.cancels.push(leg.role); state.working = state.working.filter(role => role !== leg.role); return { ...leg, status: 'CANCELLED', confirmedAt: new Date().toISOString(), generation: c.generation, sessionId: c.sessionId }; },
        dispatch: async (p, op) => { const durable = await closeRepo.get(op.originalProposalId); assert.ok(durable?.submissionAttemptedAt); state.close = p.payload as PreparedBrokerOrder; state.working.push('CLOSE'); state.closeDispatches++; }, alert: async (op, reason) => alerts.recordFault({ accountId, proposalId: op.originalProposalId, code: 'CLOSE_BLOCKED', evidence: { reason } })
    });
    const store = new LifecycleObserverRepository(pool, repo);
    const observer = new LifecycleObserver(store, {
        currentContext: () => ({ accountId, sessionId }), context: async () => context(), refresh, close, faults: alerts, closePrice: async () => 100.19, assertManagementAllowed: input.assertCurrent, automationEnabled: true, adoptExisting: false, exitBeforeCloseMinutes: 15, onHealth() { }, logCritical() { }
    });
    await observer.triggerNow();
    assert.equal(observer.status().healthy, true, JSON.stringify(observer.status()));
    return {
        observer, close, state, context, refresh, async fillEntry(plan: PreparedBrokerOrder) { state.entry = plan; state.entryAt = new Date(); state.position = 1; state.working = ['TP', 'SL']; await refresh(); }, async deadline() { const schedule = structuredClone(input.metadata.sessionEvidence.schedule!); schedule.sessions[0].end = new Date(Date.now() + 14 * 60000).toISOString(); await pool.query('UPDATE instrument_session_schedules SET evidence=$1,updated_at=clock_timestamp() WHERE instrument_id=$2', [schedule, bound.instrumentId]); await observer.triggerNow(); }, async fillClose() { state.closeFilled = true; state.closeAt = new Date(); state.position = 0; state.working = []; await refresh(); await observer.triggerNow(); }
    };
}
