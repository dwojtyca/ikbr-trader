import { evaluateRoundTrip } from './lifecycle/round-trip-evidence.js';
import { controlledPlan, lifecycleHarness } from './pp7-scheduler-lifecycle-harness.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool, type PoolClient } from 'pg';
import { buildTradingConfigurationProjection, createTradingConfigurationRuntime, TradingConfigurationStore } from '@ikbr/shared/trading-config';
import { ResearchStore } from '@ikbr/shared/instrument-research';
import { researchFixture } from '@ikbr/shared/instrument-research-testfixture';
import type { ProposedOrder } from '@ikbr/shared';
import { runMigrations } from './migrations.js';
import { ExecutionRepository } from './repository.js';
import { createSessionEntryGuard } from './session-entry-guard.js';
import { paperPolicyFixture } from './paper-run-policy.fixture.js';
import { adoptPaperEntryBudget } from './paper-entry-budget.js';
import { readPaperDailyLoss } from './paper-daily-loss.js';
import { createResearchEntryValidator } from './research-entry-guard.js';
import { buildSubmissionApplicationService } from './reconciliation/submission-service.js';
import { buildReconciliationSubmissionGate } from './reconciliation/submission-gate.js';
import { stockMetadataFixture } from './stock-market-test-fixture.js';
import { assessAiEntryRisk } from './ai-entry-risk.js';
import { buildResearchOrderContext, readContextReconciliation } from './research-order-context.js';
import { registerExecuteTicketRoute } from './submission-routes.js';
import { registerExecutionAuth, AuthFailureBurstTracker } from './auth.js';
import { EntryControlStore } from './entry-control.js';
import { LifecycleAlertStore, LifecycleAlertWorker } from './lifecycle/lifecycle-alerts.js';
import { pinLifecycleEntryPolicy, assertLifecycleEntryDeadline } from './lifecycle/observer-repository.js';
import type { AccountSnapshot, PreparedBrokerOrder } from './tws-execution-client.js';
import { nativeBreakoutCandles, syntheticHistorySchedule, signalModule, llmModule, capturedSchedulerTimers, awaitScheduler } from './pp7-scheduler-harness.js';
const connection = process.env.TEST_POSTGRES_URL;
const sessionId = 'pp7-fixture', token = 'pp7-fixture-token-not-a-real-secret';
async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>) { const db = await pool.connect(); try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
}
catch (e) {
    await db.query('ROLLBACK');
    throw e;
}
finally {
    db.release();
} }
interface Faults {
    decision?: 'REJECT' | 'MALFORMED';
    lostAcknowledgement?: boolean;
    brokerUnknown?: boolean;
    researchChanged?: boolean;
    accountChanged?: boolean;
    stalePrice?: boolean;
    unauthorized?: boolean;
}
async function flow(instrumentId: string, body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, faults: Faults = {}) {
    const name = `pp7_flow_${randomUUID().replaceAll('-', '')}`, url = new URL(connection!);
    url.pathname = '/postgres';
    const admin = new Pool({ connectionString: url.toString() });
    await admin.query(`CREATE DATABASE ${name}`);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString() });
    let f: Awaited<ReturnType<typeof setup>> | undefined;
    try {
        await runMigrations(pool);
        f = await setup(pool, instrumentId, faults);
        await body(f);
    }
    finally {
        await f?.loop.stop();
        await f?.lifecycle.observer.stop();
        await f?.alertsWorker.stop();
        await f?.app.close();
        await pool.end();
        await admin.query(`DROP DATABASE ${name}`);
        await admin.end();
    }
}
async function setup(pool: Pool, instrumentId: string, faults: Faults = {}) {
    const modules = await Promise.all([
        'runtime/strategy/configured-strategy-runtime.ts', 'runtime/strategy/strategy-context-loader.ts', 'runtime/strategy/session-native.fixture.ts', 'runtime/trading-loop/trading-loop-service.ts', 'runtime/runtime.ts', 'runtime/price-provider.ts', 'runtime/broker-state-provider.ts', 'runtime/execution/execution-runtime.ts', 'runtime/execution/submitter.ts', 'runtime/execution/paper-guard.ts', 'portfolio/strategy-portfolio-manager.ts', 'strategies/strategy-registry.ts'
    ].map(signalModule));
    const [{ ConfiguredStrategyRuntime }, { StrategyContextLoader }, { fixtureSessionSchedule }, { TradingLoopService }, { MarketDataRuntime }, { PriceContextProvider }, { BrokerStateContextProvider }, { ExecutionRuntime }, { HttpExecutionTicketSubmitter }, { PaperGuard }, { StrategyPortfolioManager }, { createStrategy }] = modules;
    // Controlled external calendar/history observations are synthetic, never operational evidence.
    let observed = new Date();
    const p = paperPolicyFixture(new Date(observed.getTime() - 60000).toISOString(), new Date(observed.getTime() + 120000).toISOString());
    const accountId = p.policy.accountId, r = researchFixture(observed.getTime(), instrumentId), projection = buildTradingConfigurationProjection(r.config), bound = projection.authority.getBoundInstrument(instrumentId)!;
    const candles = await nativeBreakoutCandles(bound, observed);
    observed = new Date();
    const configStore = new TradingConfigurationStore(pool);
    const runtimes = ['ingestion', 'signal-engine', 'execution-engine', 'llm-agent'].map(service => createTradingConfigurationRuntime({ service: service as 'ingestion', loaded: p.loaded, store: configStore, tradingEnabled: false, processId: randomUUID() }));
    for (const runtime of runtimes)
        await runtime.initialize();
    await pool.query('SELECT capture_strategy_binding_inheritance($1)', [r.configHash]);
    await pool.query('INSERT INTO strategy_runtime_conversion(source_hash,v2_not_before_bucket_ms) VALUES($1,$2)', [r.configHash, Math.floor(observed.getTime() / 60000) * 60000]);
    await transaction(pool, async (db) => { assert.deepEqual(await adoptPaperEntryBudget(db, p.policy, { tradingEnabled: false }), { ok: true }); });
    const research = new ResearchStore(pool);
    await research.registerManifest({ manifest: r.manifest, configuration: r.config, tradingEnabled: false, adopt: true });
    for (const service of ['execution-engine', 'llm-agent'] as const)
        await research.observe({ configHash: r.configHash, manifestHash: r.manifestHash, service, processId: service, tradingEnabled: false });
    await research.storeSnapshot(r.snapshot);
    const metadata = stockMetadataFixture(bound, accountId, observed.getTime());
    await pool.query(`INSERT INTO instrument_session_schedules(instrument_id,conid,use_rth,generation,status,evidence,updated_at) VALUES($1,$2,true,1,'READY',$3,$4)`, [instrumentId, String(bound.conId), metadata.sessionEvidence.schedule, observed]);
    const context = () => ({ accountId, sessionId, connectionGeneration: 1, nowMs: Date.now(), lastBrokerFillObservedAt: 0 });
    const controls = new EntryControlStore(pool), alerts = new LifecycleAlertStore(pool), alertsWorker = new LifecycleAlertWorker(alerts, { enabled: true, send: async () => ({ status: 'DELIVERED', messageId: 'fixture' }) }, { accountIds: [accountId], processId: sessionId });
    await alertsWorker.start();
    const local = { connected: true, generation: 1 };
    const entryContext = { accountId, sessionId, entriesPaused: false, automationEnabled: true };
    const permitDeps = {
        assertCurrent() { assert.ok(local.connected); assert.equal(local.generation, 1); }, alertFailure: (db: PoolClient, a: string, s: string) => alerts.entryFailure(db, a, s)
    };
    await controls.adopt(accountId, false);
    const assertEntryAllowed = async () => { await runtimes[2].assertEntryAllowed(); await controls.check(entryContext, permitDeps); };
    const repo = new ExecutionRepository(pool, undefined, undefined, createSessionEntryGuard(id => projection.authority.getBoundInstrument(id)), () => r.configHash, {
        policy: p.policy, exitMarginMinutes: 15, context, resolveManagement: async (order) => projection.authority.getBoundInstrument(order.instrumentId!)
    }, createResearchEntryValidator({ store: research, loadedIdentity: () => ({ configHash: r.configHash, manifestHash: r.manifestHash }) }), {
        permit: db => controls.permit(db, entryContext, permitDeps), pin: (db, order, a) => pinLifecycleEntryPolicy(db, order, bound, a, new Date(), 15), deadline: assertLifecycleEntryDeadline
    });
    const lifecycle = await lifecycleHarness({ pool, repo, bound, accountId, sessionId, alerts, assertCurrent: permitDeps.assertCurrent, metadata });
    await controls.setPaused(accountId, false, 'fixture', 'authorized synthetic test', db => controls.permit(db, entryContext, permitDeps, { resuming: true }));
    const riskCalls: number[] = [];
    const risk = async (order: ProposedOrder) => {
        const now = Date.now(), stamp = new Date(now - 1).toISOString();
        const account: AccountSnapshot = {
            accountId, retrievedAt: stamp, metrics: {}, positions: [], totals: { positionsCount: 0, longExposure: 0, shortExposure: 0, grossExposure: 0, netExposure: 0, unrealizedPnL: 0, realizedPnL: 0 }, riskEvidence: {
                requestStartedAt: stamp, completedAt: stamp, complete: true, connectionGeneration: 1, configuredBaseCurrency: 'USD', cashByCurrency: { USD: 10000, PLN: 10000 }, exchangeRatesToBase: { USD: 1, PLN: .25 }, usdMetrics: { netLiquidation: 100000, availableFunds: 50000, grossPositionValue: 0 }
            }
        };
        const daily = await readPaperDailyLoss(pool, context());
        assert.ok(daily.ok, JSON.stringify(daily));
        const assessed = assessAiEntryRisk({
            order, bound, accountId, sessionId, snapshot: account, effectiveConfigHash: r.configHash, nowMs: now, stockMetadata: { ...metadata, requestStartedAtMs: now - 1, receivedAtMs: now - 1 }, dailyLossEvidence: daily.evidence,
            watchlist: {
                connected: true, watchlist: [
                    {
                        instrumentId, conid: String(bound.conId), subscribed: true, marketState: {
                            conid: String(bound.conId), bid: 100.19, ask: 100.21, marketDataType: 1, ts: observed.toISOString(), bidObservedAt: stamp, askObservedAt: stamp
                        }
                    }
                ]
            },
            limits: {
                maxNotionalPct: 10, maxStopRiskPct: 1, maxExposurePct: 50, quoteCurrency: { currency: bound.currency as 'USD' | 'PLN', ...p.policy.currencyCaps[bound.currency as 'USD' | 'PLN']! }
            }
        });
        riskCalls.push(now);
        assert.equal(assessed.ok, true, JSON.stringify(assessed));
        return { ...assessed, snapshot: account };
    };
    const dispatches: PreparedBrokerOrder[] = [];
    const service = buildSubmissionApplicationService({
        repo, assertEntryAllowed, strategyPreflight: async () => ({ effectiveConfigHash: r.configHash, observedAt: observed.toISOString() }), assessAiRisk: risk,
        ensureBrokerSession: async () => { permitDeps.assertCurrent(); return { accountId }; }, buildPositionGuard: () => ({ kind: 'available', accountId, sessionId, maxSnapshotAgeMs: 10000 }), reconciliationGate: () => buildReconciliationSubmissionGate({ maxAgeSeconds: 10 }),
        prepareBrokerPlan: async ({ order, clientOrderId }) => controlledPlan(order, bound, accountId, clientOrderId),
        dispatcher: {
            dispatch: async (payload) => { assert.ok(payload.sendWithEntryPermit); await payload.sendWithEntryPermit(() => dispatches.push(payload.prepared)); if (faults.brokerUnknown)
                throw Error('synthetic lost broker acknowledgement'); return { brokerOrderId: '101', status: 'SUBMITTED' }; }
        },
        assertKillSwitchOk: () => permitDeps.assertCurrent(), recordAlert: input => repo.insertSystemAlert(input).then(() => { }), triggerReconciliation: lifecycle.refresh, ownerId: sessionId, allowMarketOrder: false, allowCrossContractExposure: false, bindingAuthority: projection.authority, defaultTif: 'DAY'
    });
    const app = Fastify();
    registerExecutionAuth(app, {
        token, publicPaths: new Set(), writeAudit: input => repo.insertExecutionAuditLog(input), burstTracker: new AuthFailureBurstTracker(() => { }), logger: app.log
    });
    registerExecuteTicketRoute(app, { service, directTicketRefused: () => { throw Error('raw fixture ticket prohibited'); } });
    const http: {
        status: number;
        body: unknown;
    }[] = [];
    const fetchImpl = (async (input: unknown, init: RequestInit) => { const response = await app.inject({
        method: 'POST', url: new URL(String(input)).pathname, headers: init.headers as Record<string, string>, payload: init.body as string
    }); http.push({ status: response.statusCode, body: response.json() }); if (faults.lostAcknowledgement)
        throw Error('synthetic lost HTTP acknowledgement'); return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
    const exposure = {
        readExposure: async () => ({ hasOpenPosition: false, hasActiveOrder: false, hasPendingProposal: false, hasAmbiguousSubmission: false, quantity: 0 })
    };
    const probe = { probeReady: async () => ({ kind: 'ok', ready: true, environment: 'paper', accountMatchesEnvironment: true, tradingEnabled: true }) };
    const market = new MarketDataRuntime({
        registry: projection.registry, pipeline: { run() { throw Error('generic strategy rerun forbidden'); } }, providers: [
            new PriceContextProvider({
                reader: {
                    readMarketState: async () => ({
                        last: 100.2, lastPrice: 100.2, bid: 100.19, ask: 100.21, spread: .02, observedAt: faults.stalePrice ? new Date(observed.getTime() - 120000) : observed, source: 'fixture'
                    })
                }, freshnessTtlMs: 90000
            }), new BrokerStateContextProvider({ probe, exposure })
        ]
    });
    const runtime = new ExecutionRuntime({
        dryRun: market, paperGuard: new PaperGuard({ probe, expectedEnvironment: 'paper' }), submitter: new HttpExecutionTicketSubmitter({ engineUrl: 'http://fixture', bearerToken: faults.unauthorized ? 'invalid' : token, requestTimeoutMs: 10000, fetchImpl }), bindingAuthority: projection.authority, assertEntryAllowed
    });
    const loader = new StrategyContextLoader({
        clock: () => observed, maxMarketStateAgeMs: 90000, repo: {
            getSessionScheduleEvidence: async () => syntheticHistorySchedule(bound, observed), getInstrumentContractByConId: async () => ({ ...r.config.instruments.find(i => i.id === instrumentId)!.contract, conid: String(bound.conId), secType: 'STK', source: 'ibkr' }), getRecentCandlesForContract: async (_s: string, _c: string, tf: string) => candles[tf], getMarketState: async () => ({ conid: String(bound.conId), symbol: bound.brokerSymbol, lastPrice: 100.2, bid: 100.19, ask: 100.21, ts: observed.toISOString() })
        }
    });
    const { ConfiguredStrategyStateRepository } = await signalModule('runtime/strategy/configured-strategy-state.ts');
    const state = new ConfiguredStrategyStateRepository({
        pool, getInheritanceSourceHash: async () => r.configHash, cooldownMs: 60000, outcomeReader: {
            read: async (id: number) => { const evidence = await repo.getRoundTripEvidence(id, accountId); assert.ok(evidence); return evaluateRoundTrip(evidence, lifecycle.context()); }
        }
    });
    const configured = new ConfiguredStrategyRuntime({
        configuration: r.config, effectiveConfigHash: r.configHash, accountId, authority: projection.authority, registry: projection.registry, contextLoader: loader, state, assertEvaluationAllowed: assertEntryAllowed, clock: () => observed
    });
    const makeLoop = () => {
        const timers = capturedSchedulerTimers();
        const loop = new TradingLoopService({
            config: {
                enabled: true, intervalMs: 30000, startupDelayMs: 0, maxConcurrentInstruments: 1, instrumentIds: [instrumentId], shutdownTimeoutMs: 10000, exposureTimeoutMs: 3000
            }, configuredStrategyRuntime: configured, configuredSubmissionEnabled: true, stockMetadataReader: { read: async () => ({ accountId, metadata }) }, assertEntryAllowed, registry: projection.registry, bindingAuthority: projection.authority, marketDataRuntime: market, executionRuntime: runtime, exposureReader: exposure, reconciliationReader: { checkInstrument: async () => ({ kind: 'pass' }) }, portfolioManager: new StrategyPortfolioManager([createStrategy('momentum_breakout_long_v1')]), repo: {}, strategyCooldownMs: 0, maxMarketStateAgeMs: 90000, logger: { info() { }, warn() { }, error() { }, debug() { } }, clock: () => observed, ...timers
        });
        return { loop, timers };
    };
    const { loop, timers } = makeLoop();
    const [{ ResearchBoundReviewRepository }, { BoundReviewWorker }] = await Promise.all([llmModule('research-review-repository.ts'), llmModule('bound-review-worker.ts')]);
    let calls = 0;
    const reviewRepo = new ResearchBoundReviewRepository(pool, { manifest: r.manifest, hash: r.manifestHash });
    const worker = new BoundReviewWorker({
        assertEntryAllowed, repository: reviewRepo, execution: {
            getAiContext: async (id: number) => { const record = await repo.getExecutableProposedById(id); assert.ok(record); const assessed = await risk(record.order); assert.ok(assessed.ok); return buildResearchOrderContext({
                order: record.order, clientOrderHash: record.clientOrderHash!, effectiveConfigHash: r.configHash, accountId, sessionId, connectionGeneration: 1, requestedAt: new Date().toISOString(), nowMs: Date.now(), snapshot: assessed.snapshot, risk: assessed.evidence!, reconciliation: await readContextReconciliation(pool, accountId)
            }); }, executeBoundProposed: async (id: number) => { const out = await service.executeProposed({ proposedOrderId: id, overrideRejected: false }); if (out.kind === 'submitted')
                return 'SUBMITTED'; if (faults.brokerUnknown && out.kind === 'execution_error')
                return 'UNKNOWN'; throw Error(JSON.stringify(out)); }
        }, researchDecider: {
            isConfigured: () => true, decide: async (request: {
                context: {
                    research: {
                        eligibility: {
                            requiredEvidenceRefs: string[];
                        };
                    };
                };
            }) => { calls++; /* Allow the host clock to pass the disposable Docker DB reservation timestamp. */ /* Allow the host clock to pass the disposable Docker DB reservation timestamp. */ await new Promise(resolve => setTimeout(resolve, 150)); if (faults.researchChanged) {
                const negative = structuredClone(r.snapshot);
                negative.coverage[1].status = 'ERROR';
                negative.coverage[1].complete = false;
                await research.storeSnapshot(negative);
            } if (faults.accountChanged)
                local.generation++; return {
                decision: {
                    decision: faults.decision === 'REJECT' ? 'REJECT' : 'EXECUTE', confidence: faults.decision === 'MALFORMED' ? 2 : .8, reason: 'Synthetic cited research', riskFlags: [], evidenceRefs: request.context.research.eligibility.requiredEvidenceRefs
                }, actualModel: 'fixture-model', usage: null
            }; }
        }, model: r.manifest.model.model, promptVersion: r.manifest.model.promptVersion
    });
    return {
        makeLoop, lifecycle, pool, loop, timers, worker, repo, app, alertsWorker, dispatches, http, riskCalls, bound, calls: () => calls, controls, accountId, entryContext
    };
}
for (const id of ['pko_wse', 'aapl_smart', 'xyz_nyse'])
    test(`PP7 scheduled ${id} completes research, fresh-risk bracket and supervised full close`, { skip: !connection }, () => flow(id, async (f) => {
        f.loop.start();
        f.timers.callbacks.startup!();
        await awaitScheduler(f.loop);
        assert.equal(f.http[0]?.status, 200, JSON.stringify({ status: f.loop.status(), http: f.http }));
        const row = (await f.pool.query('SELECT * FROM proposed_orders')).rows[0];
        assert.ok(row);
        const evaluation = f.loop.status().lastOutcomes[id].evaluation;
        assert.equal(evaluation.kind, 'signal');
        assert.deepEqual(row.strategy_attribution, evaluation.strategyAttribution);
        assert.deepEqual(row.strategy_trigger, evaluation.strategyTrigger);
        assert.equal(row.confidence, evaluation.signal.confidenceScore);
        assert.deepEqual(row.indicator_snapshot.stockStrategyPriceEvidence.raw, { entry: evaluation.signal.suggestedEntry, stopLoss: evaluation.signal.stopLoss, takeProfit: evaluation.signal.takeProfit });
        assert.deepEqual(row.indicator_snapshot.stockStrategyPriceEvidence.final, { entry: 100.2, stopLoss: 99.37, takeProfit: 104.35 });
        assert.equal(row.reason, evaluation.signal.entryReason);
        assert.equal(row.strategy_attribution.instanceId, id === 'xyz_nyse' ? 'momentum_custom' : 'momentum_default');
        assert.equal(row.strategy_attribution.instanceRevision, id === 'xyz_nyse' ? 2 : 1);
        assert.deepEqual([row.entry, row.stop, row.take_profit], [100.2, 99.37, 104.35]);
        assert.equal(row.conid, String(f.bound.conId));
        assert.equal(row.instrument, f.bound.brokerSymbol);
        assert.equal(row.execution_attempted_at, null);
        assert.equal(f.dispatches.length, 0);
        await f.lifecycle.observer.triggerNow();
        assert.equal(await f.worker.pollOnce(), true);
        assert.equal(f.calls(), 1);
        assert.equal(f.dispatches.length, 1, JSON.stringify((await f.pool.query('SELECT * FROM proposal_ai_reviews')).rows));
        assert.ok(f.riskCalls.length >= 2);
        const sent = f.dispatches[0];
        assert.equal(sent.contract.currency, f.bound.currency);
        assert.equal(sent.contract.conId, f.bound.conId);
        assert.deepEqual([sent.normalizedTicket.entry, sent.normalizedTicket.stop, sent.normalizedTicket.takeProfit], [100.2, 99.37, 104.35]);
        assert.deepEqual(sent.legs.map(leg => leg.role), ['PARENT', 'TP', 'SL']);
        assert.ok(sent.plan.bracket);
        assert.equal(await f.worker.pollOnce(), false);
        await f.lifecycle.fillEntry(f.dispatches[0]);
        await f.lifecycle.observer.triggerNow();
        assert.equal(f.lifecycle.observer.status().healthy, true, JSON.stringify((await f.pool.query('SELECT observation FROM lifecycle_supervision')).rows));
        await f.lifecycle.deadline();
        assert.equal(f.lifecycle.state.closeDispatches, 1, JSON.stringify((await f.pool.query('SELECT * FROM lifecycle_supervision')).rows));
        await f.lifecycle.fillClose();
        const close = await f.lifecycle.close.get(Number(row.id));
        assert.equal(close?.state, 'COMPLETED', JSON.stringify(close));
        const evidence = await f.repo.getRoundTripEvidence(Number(row.id), f.accountId);
        assert.ok(evidence);
        const report = evaluateRoundTrip(evidence, f.lifecycle.context());
        assert.equal(report.status, 'COMPLETED', JSON.stringify(report.reasons));
        assert.equal(report.accounting, 'COMPLETE');
        assert.equal(report.quoteCurrency, f.bound.currency);
        assert.equal((await f.pool.query('SELECT status FROM lifecycle_supervision')).rows[0].status, 'FLAT');
    }));
async function scheduled(f: Awaited<ReturnType<typeof setup>>) { f.loop.start(); f.timers.callbacks.startup!(); await awaitScheduler(f.loop); }
async function counts(f: Awaited<ReturnType<typeof setup>>) { return (await f.pool.query(`SELECT (SELECT count(*)::int FROM proposed_orders WHERE position_effect IS DISTINCT FROM 'CLOSE_OR_REDUCE') proposals,(SELECT count(*)::int FROM proposal_ai_model_calls) models,(SELECT count(*)::int FROM paper_entry_attempts) attempts`)).rows[0]; }
test('PP7 competing scheduler processes and restart retain one durable trigger after lost HTTP acknowledgement', { skip: !connection }, () => flow('aapl_smart', async (f) => {
    const second = f.makeLoop();
    try {
        f.loop.start();
        second.loop.start();
        f.timers.callbacks.startup!();
        second.timers.callbacks.startup!();
        await Promise.all([awaitScheduler(f.loop), awaitScheduler(second.loop)]);
        assert.equal(f.loop.status().lastOutcomes.aapl_smart.outcome.kind, 'UNKNOWN');
        assert.deepEqual(await counts(f), { proposals: 1, models: 0, attempts: 0 });
        assert.equal(f.dispatches.length, 0);
        await f.lifecycle.observer.triggerNow();
        await f.worker.pollOnce();
        assert.equal(f.dispatches.length, 1);
        assert.deepEqual(await counts(f), { proposals: 1, models: 1, attempts: 1 });
        await f.loop.stop();
        const restarted = f.makeLoop();
        try {
            restarted.loop.start();
            restarted.timers.callbacks.startup!();
            await awaitScheduler(restarted.loop);
            assert.deepEqual(await counts(f), { proposals: 1, models: 1, attempts: 1 });
        }
        finally {
            await restarted.loop.stop();
        }
    }
    finally {
        await second.loop.stop();
    }
}, { lostAcknowledgement: true }));
for (const decision of ['REJECT', 'MALFORMED'] as const)
    test(`PP7 scheduled ${decision} AI response is durable and never dispatched or recharged`, { skip: !connection }, () => flow('aapl_smart', async (f) => {
        await scheduled(f);
        await f.lifecycle.observer.triggerNow();
        await f.worker.pollOnce();
        assert.equal((await f.pool.query('SELECT status FROM proposal_ai_reviews')).rows[0].status, 'REJECTED');
        assert.equal(f.dispatches.length, 0);
        assert.equal(await f.worker.pollOnce(), false);
        assert.deepEqual(await counts(f), { proposals: 1, models: 1, attempts: 0 });
        f.timers.callbacks.tick!();
        await awaitScheduler(f.loop, 2);
        assert.deepEqual(await counts(f), { proposals: 1, models: 1, attempts: 0 });
    }, { decision }));
test('PP7 broker acknowledgement loss preserves one attempted submission across worker and scheduler restart', { skip: !connection }, () => flow('aapl_smart', async (f) => {
    await scheduled(f);
    await f.lifecycle.observer.triggerNow();
    await f.worker.pollOnce();
    assert.equal(f.dispatches.length, 1);
    assert.deepEqual(await counts(f), { proposals: 1, models: 1, attempts: 1 });
    assert.equal((await f.pool.query('SELECT delivery_outcome FROM proposal_ai_reviews')).rows[0].delivery_outcome, 'UNKNOWN');
    await assert.rejects(f.worker.pollOnce(), /LIFECYCLE_RECONCILIATION_UNAVAILABLE/);
    assert.ok((await f.pool.query('SELECT 1 FROM reconciliation_holds WHERE active')).rowCount);
    const restarted = f.makeLoop();
    try {
        restarted.loop.start();
        restarted.timers.callbacks.startup!();
        await awaitScheduler(restarted.loop);
        assert.equal(f.dispatches.length, 1);
        assert.deepEqual(await counts(f), { proposals: 1, models: 1, attempts: 1 });
    }
    finally {
        await restarted.loop.stop();
    }
}, { brokerUnknown: true }));
test('PP7 changed research during AI cannot use previously eligible binding', { skip: !connection }, () => flow('aapl_smart', async (f) => {
    await scheduled(f);
    await f.lifecycle.observer.triggerNow();
    await f.worker.pollOnce();
    assert.equal(f.dispatches.length, 0);
    assert.deepEqual(await counts(f), { proposals: 1, models: 1, attempts: 0 });
    assert.equal((await f.pool.query('SELECT decision_json FROM proposal_ai_reviews')).rows[0].decision_json, null);
}, { researchChanged: true }));
test('PP7 durable entry pause denies scheduler before persistence or model expense', { skip: !connection }, () => flow('aapl_smart', async (f) => {
    await f.controls.setPaused(f.accountId, true, 'fixture', 'pause before scheduled cycle');
    await scheduled(f);
    assert.deepEqual(await counts(f), { proposals: 0, models: 0, attempts: 0 });
    assert.equal(f.http.length, 0);
    assert.equal(f.dispatches.length, 0);
}));
for (const fault of ['stalePrice', 'unauthorized'] as const)
    test(`PP7 scheduled ${fault} refuses persistence and provider/broker calls`, { skip: !connection }, () => flow('aapl_smart', async (f) => {
        await scheduled(f);
        assert.deepEqual(await counts(f), { proposals: 0, models: 0, attempts: 0 });
        assert.equal(f.dispatches.length, 0);
        assert.equal(f.calls(), 0);
        if (fault === 'unauthorized')
            assert.equal(f.http[0].status, 401);
    }, { [fault]: true }));
test('PP7 changed account connection generation during AI remains an unattempted hold', { skip: !connection }, () => flow('aapl_smart', async (f) => {
    await scheduled(f);
    await f.lifecycle.observer.triggerNow();
    await assert.rejects(f.worker.pollOnce());
    assert.deepEqual(await counts(f), { proposals: 1, models: 1, attempts: 0 });
    assert.equal(f.dispatches.length, 0);
    assert.equal((await f.pool.query('SELECT decision_json FROM proposal_ai_reviews')).rows[0].decision_json, null);
}, { accountChanged: true }));
for (const source of ['session', 'configuration peers'] as const)
    test(`PP7 failed ${source} evidence refuses scheduled proposal`, { skip: !connection }, () => flow('aapl_smart', async (f) => {
        if (source === 'session')
            await f.pool.query("UPDATE instrument_session_schedules SET status='FAILED'");
        else
            await f.pool.query("UPDATE trading_configuration_observations SET expires_at=clock_timestamp()-interval '1 second'");
        await scheduled(f);
        assert.deepEqual(await counts(f), { proposals: 0, models: 0, attempts: 0 });
        assert.equal(f.calls(), 0);
        assert.equal(f.dispatches.length, 0);
    }));
