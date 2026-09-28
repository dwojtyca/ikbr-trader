import assert from "node:assert/strict";
import { test } from "node:test";
import { InstrumentBindingAuthority, InstrumentRegistry, type ProposedOrder, type SignalTicket } from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { createTradingConfigurationRuntime, type LoadedTradingConfiguration, type TradingConfigurationAdmissionState, type TradingConfigurationStore } from "@ikbr/shared/trading-config";
import { buildSubmissionApplicationService } from "./submission-service.js";
import type { ExecutionRepository } from "../repository.js";
import type { PreparedBrokerOrder } from "../tws-execution-client.js";

async function harness(scenario: "prepare" | "bundle" | "drift" | "store-failure" | "before-prepare" | "after-claim" | "last-permit" | "during-idempotency" | "during-position") {
  let latched = scenario === "drift";
  const unavailable = scenario === "store-failure";
  const loaded = { mode: scenario === "bundle" ? "bundle" : "legacy", migrationPrepare: scenario === "prepare", diagnostics: [], effectiveHash: "a".repeat(64) } as LoadedTradingConfiguration;
  const state = (): TradingConfigurationAdmissionState => ({ latched, observations: [], nowMs: Date.now() });
  const store = { register: async () => ({ preparationPending: false, managementAuthority: null, ownership: [], legacySourceHash: null }),
    readAdmissionState: async () => { if (unavailable) throw Error("fixture-store-failure"); return state(); } } as unknown as TradingConfigurationStore;
  const runtime = createTradingConfigurationRuntime({ service: "execution-engine", loaded, store, tradingEnabled: false });
  await runtime.initialize();
  const counts = { reads: 0, writes: 0, brokerSession: 0, prepare: 0, claim: 0, dispatch: 0, brokerWrites: 0, alerts: 0, reconciliation: 0 };
  const ticket: SignalTicket = { instrument: "FIXTURE", conid: "555", side: "BUY", orderType: "LMT", quantity: 1, entry: 10, stop: 9, takeProfit: 12,
    reason: "fixture", confidence: 1, riskCheckStatus: "PASS", timestamp: new Date().toISOString() };
  const order: ProposedOrder = { ...ticket, id: 1, strategy: "fixture", status: "PROPOSED" };
  const hash = computeClientOrderHash(ticket);
  const prepared: PreparedBrokerOrder = { contract: { conId: 555, symbol: "FIXTURE", secType: "STK", currency: "USD", exchange: "SMART" }, normalizedTicket: ticket,
    legs: [{ role: "PARENT", roleOrdinal: 0, brokerOrderId: "10", orderRef: "fixture" }],
    plan: { parentOrderId: 10, relatedOrderIds: new Set([10]), orders: [{ orderId: 10, order: { action: "BUY", totalQuantity: 1, orderType: "LMT", lmtPrice: 10 } }] } };
  const repo = {
    getExecutableProposedById: async () => { counts.reads++; return { order, clientOrderId: "fixture", clientOrderHash: hash }; },
    getProposedOrderById: async () => order,
    getIdempotencyRecord: async () => { counts.reads++; await Promise.resolve(); if (scenario === "during-idempotency") latched = true; return null; },
    insertProposedFromTicket: async () => { counts.writes++; throw Error("must-not-insert"); },
    checkPaperEntry: async () => ({ ok: true, endsAtMs: Date.now() + 30_000 }),
    checkSessionEntry: async () => ({ ok: true, endsAtMs: Date.now() + 30_000 }),
    tryStartSubmissionWithPlan: async () => { counts.claim++; order.executionAttemptedAt = new Date(); if (scenario === "after-claim") latched = true; return { kind: "claimed_with_persisted_plan" }; },
    withEntryDispatchPermit: async (_order: ProposedOrder, _account: string, send: () => void, beforeSend?: () => Promise<void>) => {
      await Promise.resolve(); if (scenario === "last-permit") latched = true; await beforeSend?.(); send();
    },
    setDecisionMetadata: async () => {},
  } as unknown as ExecutionRepository;
  const service = buildSubmissionApplicationService({ repo, assertEntryAllowed: () => runtime.assertEntryAllowed(),
    ensureBrokerSession: async () => { counts.brokerSession++; if (scenario === "before-prepare") latched = true; return { accountId: "DU_FIXTURE" }; },
    buildPositionGuard: async () => { await Promise.resolve(); if (scenario === "during-position") latched = true; return { kind: "available", accountId: "DU_FIXTURE", sessionId: "fixture", maxSnapshotAgeMs: 30_000 }; },
    reconciliationGate: () => async () => null,
    prepareBrokerPlan: async () => { counts.prepare++; return prepared; },
    dispatcher: { dispatch: async ({ sendWithEntryPermit }) => { counts.dispatch++; await sendWithEntryPermit!(() => { counts.brokerWrites++; }); return { status: "SUBMITTED", brokerOrderId: "10" }; } },
    assertKillSwitchOk: () => {}, recordAlert: async () => { counts.alerts++; }, triggerReconciliation: () => { counts.reconciliation++; },
    ownerId: "fixture", allowMarketOrder: false, allowCrossContractExposure: false,
    bindingAuthority: new InstrumentBindingAuthority(new InstrumentRegistry([]), []), defaultTif: "DAY" });
  return { service, counts, ticket, hash, order };
}
for (const scenario of ["prepare", "bundle", "drift", "store-failure"] as const) test(`${scenario} blocks actual submit/AI-approved execution before reads, proposals, prepares or writes`, async () => {
  const h = await harness(scenario);
  assert.equal((await h.service.submitTicket({ ticket: h.ticket, strategy: "fixture", clientOrderId: "fixture", clientOrderHash: h.hash })).kind, "risk_rejected");
  assert.equal((await h.service.executeProposed({ proposedOrderId: 1, overrideRejected: false, decisionMetadata: { aiDecision: "EXECUTE", decisionActor: "llm-agent" } })).kind, "risk_rejected");
  assert.deepEqual(h.counts, { reads: 0, writes: 0, brokerSession: 0, prepare: 0, claim: 0, dispatch: 0, brokerWrites: 0, alerts: 0, reconciliation: 0 });
});
for (const scenario of ["before-prepare", "after-claim", "last-permit"] as const) test(`${scenario} drift is rechecked after awaited preflight without retrying or clearing attempted state`, async () => {
  const h = await harness(scenario), result = await h.service.executeProposed({ proposedOrderId: 1, overrideRejected: false });
  assert.equal(h.counts.brokerWrites, 0);
  if (scenario === "before-prepare") { assert.equal(result.kind, "risk_rejected"); assert.equal(h.counts.prepare, 0); assert.equal(h.counts.claim, 0); }
  else {
    assert.equal(h.counts.claim, 1); assert.ok(h.order.executionAttemptedAt);
    if (scenario === "after-claim") { assert.equal(result.kind, "risk_rejected"); assert.equal(h.counts.dispatch, 0); }
    else { assert.equal(result.kind, "execution_error"); assert.equal(h.counts.dispatch, 1); assert.equal(h.counts.alerts, 1); assert.equal(h.counts.reconciliation, 1); }
  }
});

for (const scenario of ["during-idempotency", "during-position"] as const) test(`${scenario} pause prevents the fresh proposal/AI-review insert`, async () => {
  const h = await harness(scenario);
  const result = await h.service.submitTicket({ ticket: h.ticket, strategy: "fixture", clientOrderId: "fixture", clientOrderHash: h.hash });
  assert.equal(result.kind, "risk_rejected"); assert.equal(h.counts.writes, 0); assert.equal(h.counts.prepare, 0); assert.equal(h.counts.brokerWrites, 0);
});
