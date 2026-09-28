import assert from "node:assert/strict";
import { test } from "node:test";
import { InstrumentRegistry, InstrumentBindingAuthority, type SignalTicket } from "@ikbr/shared";
import { buildManagementMonitoringAuthority, createLegacyManagementSnapshot, decodeLegacyManagementSnapshot, validateRetainedOwnership, assertManagementCompatibility } from "@ikbr/shared/trading-config";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { fixture, nowMs } from "./close-test-fixture.js";
import { evaluateCloseEvidence } from "./close-evidence.js";
import { assessCloseRisk } from "./close-risk.js";
import { FullCloseService } from "./close-service.js";
import type { CloseRepository } from "./close-repository.js";
import type { CloseContext, CloseOperation, CloseTerminalEvidence } from "./close-types.js";

for (const removal of [true, false]) test(`owned close preserves original authority after snapshot restart (${removal ? "removed" : "monitoring disabled"})`, async () => {
  const f = fixture(), bound = f.context.bound!;
  const binding = { instrumentId: bound.instrumentId, conId: bound.conId, exchange: bound.exchange, currency: bound.currency, localSymbol: bound.localSymbol, tradingClass: bound.tradingClass, minTick: bound.minTick };
  const original = new InstrumentBindingAuthority(new InstrumentRegistry([bound.instrument]), [binding]);
  const persisted = createLegacyManagementSnapshot(original);
  const restored = decodeLegacyManagementSnapshot(persisted.canonical, persisted.sourceHash);
  const owned = [{ instrumentId: "test", conId: "123", symbol: "TEST", strategy: "test_strategy", clientOrderHash: f.evidence.clientOrderHash }];
  validateRetainedOwnership(restored, owned);
  const disabled = { ...bound.instrument, executionPolicy: undefined, trading: { executionEnabled: false, monitoringEnabled: false, signalGenerationEnabled: false, aiAnalysisEnabled: false } };
  const current = new InstrumentBindingAuthority(new InstrumentRegistry(removal ? [] : [disabled]), removal ? [] : [binding]);
  const monitoring = buildManagementMonitoringAuthority(current, restored, owned);
  const { buildMergedWatchlist } = await import(new URL("../../../ingestion/src/bound-watchlist.ts", import.meta.url).href);
  const ingested = buildMergedWatchlist({ authority: monitoring, legacyWatchlist: [] }) as { boundWatchlist: Array<{ instrumentId?: string; conid?: string }> };
  assert.equal(ingested.boundWatchlist.length, 1);
  assert.equal(ingested.boundWatchlist[0].conid, "123");
  assert.equal(monitoring.getBoundInstrument("test")!.instrument.trading.executionEnabled, false);
  assert.equal(restored.getBoundInstrument("test")!.instrument.trading.executionEnabled, true);
  assert.equal(computeClientOrderHash(f.order), f.evidence.clientOrderHash);
  let clock = nowMs, op: CloseOperation | null = null, risks = 0, preparations = 0;
  const context = (): CloseContext => ({ accountId: "DU_TEST", sessionId: "current", clientId: 7, generation: 1, nowMs: clock, bound: restored.getBoundInstrument("test")! });
  const refresh = async () => {
    clock += 10;
    f.run.started_at = new Date(clock - 3).toISOString(); f.run.completed_at = new Date(clock).toISOString();
    f.snapshot.capturedAt = new Date(clock - 1).toISOString(); f.coverage.executions.window.to = new Date(clock - 3).toISOString();
    f.evidence.positionSnapshot!.observedAt = new Date(clock - 4).toISOString();
    f.evidence.positionSnapshot!.positions[0].observedAt = new Date(clock - 4).toISOString();
  };
  const repo = {
    get: async () => op,
    execution: { getLifecycleEvidence: async () => f.evidence },
    reserve: async () => {
      const initial = evaluateCloseEvidence(f.evidence, context(), { mode: "initial", terminals: [], closeLink: null, barrierAt: null });
      assert.equal(initial.ok, true, initial.reasons.join(","));
      op = { id: 1, originalProposalId: 42, requestId: "fixture-request", accountId: "DU_TEST", sessionId: "current", clientId: 7, generation: 1,
        originalHash: f.evidence.clientOrderHash!, instrumentId: "test", conid: "123", limitPrice: 100, state: "PREPARING", owner: "fixture", terminals: [], cancelAttempts: [],
        barrierAt: null, closeProposalId: null, closeLink: null, submissionAttemptedAt: null, observation: null, failureReason: null };
      return { operation: op, created: true };
    },
    evidence: async () => f.evidence,
    markCancel: async () => {},
    recordTerminal: async (_op: CloseOperation, terminal: CloseTerminalEvidence) => {
      op!.terminals.push(terminal); op!.barrierAt = terminal.confirmedAt;
      f.snapshot.openOrders = f.snapshot.openOrders.filter(row => row.brokerOrderId !== terminal.brokerOrderId);
      f.coverage.openOrders.count = f.snapshot.openOrders.length;
    },
    block: async (_op: CloseOperation, state: CloseOperation["state"], reason: string) => { op!.state = state; op!.failureReason = reason; return op!; },
    claimAlert: async () => false,
    observe: async () => op!,
  } as unknown as CloseRepository;
  const service = new FullCloseService(repo, {
    context, refresh, evaluate: evaluateCloseEvidence,
    cancel: async (leg, ctx) => ({ ...leg, status: "CANCELLED", confirmedAt: new Date(clock).toISOString(), generation: ctx.generation, sessionId: ctx.sessionId }),
    assessRisk: async (ticket, retained, ctx) => {
      risks++;
      const watchlist = { connected: true, watchlist: ingested.boundWatchlist.map(row => ({ instrumentId: row.instrumentId, conid: row.conid, subscribed: true,
        marketState: { conid: row.conid, bid: 100, ask: 100.1, marketDataType: 1, bidObservedAt: new Date(clock - 1).toISOString(), askObservedAt: new Date(clock - 1).toISOString() } })) };
      const risk = assessCloseRisk(ticket, retained, ctx, watchlist);
      assert.equal(risk.ok, true, risk.reasons.join(",")); return risk;
    },
    prepare: async () => { preparations++; throw Error("fixture_after_valid_close_risk"); },
    validatePrepared: () => { throw Error("fixture_never_dispatch"); },
    dispatch: async () => { throw Error("fixture_never_dispatch"); }, alert: async () => {},
  });
  const result = await service.request(42, "fixture-request", 100, "fixture");
  assert.equal(result.failureReason, "fixture_after_valid_close_risk");
  assert.equal(risks, 1); assert.equal(preparations, 1);
  assert.equal(computeClientOrderHash(f.order), f.evidence.clientOrderHash);
});

test("missing management or changed retained identity cannot manufacture close ownership", () => {
  const f = fixture(), b = f.context.bound!, binding = { instrumentId: "test", conId: 123, exchange: "SMART", currency: "USD", localSymbol: "TEST", tradingClass: "TEST", minTick: .01 };
  const authority = new InstrumentBindingAuthority(new InstrumentRegistry([b.instrument]), [binding]);
  const owned = [{ instrumentId: "test", conId: "123", symbol: "TEST", strategy: "test_strategy", clientOrderHash: f.evidence.clientOrderHash }];
  assert.throws(() => validateRetainedOwnership(null, owned), /SNAPSHOT_REQUIRED/);
  assert.throws(() => validateRetainedOwnership(authority, [{ ...owned[0], conId: "999" }]), /SNAPSHOT_REQUIRED/);
  const changed = new InstrumentBindingAuthority(new InstrumentRegistry([b.instrument]), [{ ...binding, conId: 999 }]);
  assert.throws(() => assertManagementCompatibility(changed, authority), /IDENTITY_CONFLICT/);
  const ticket = { ...f.order, side: "SELL", positionEffect: "CLOSE_OR_REDUCE", stop: undefined, takeProfit: undefined } as SignalTicket;
  assert.equal(assessCloseRisk(ticket, null, { accountId: "DU_TEST", sessionId: "current", clientId: 7, generation: 1, nowMs, bound: null }, {}).ok, false);
});
