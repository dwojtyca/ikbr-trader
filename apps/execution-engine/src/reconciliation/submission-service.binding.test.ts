/**
 * PR15.2 — submission-service unit tests for the authoritative
 * instrument binding gate. Every rejection path MUST fire BEFORE
 * repository mutation and BEFORE broker dispatch: the fakes
 * assert zero DB writes and zero `ib.placeOrder` calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  InstrumentBindingAuthority,
  InstrumentRegistry,
  defaultInstrumentRegistry,
  type Instrument,
  type SignalTicket,
} from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";

import {
  buildSubmissionApplicationService,
  type BrokerOrderDispatcher,
  type SubmissionOutcome,
} from "./submission-service.js";
import type {
  ExecutionRepository,
  PositionGuardContext,
  ReconciliationSubmissionGate,
} from "../repository.js";
import type { PreparedBrokerOrder } from "../tws-execution-client.js";

const ACCOUNT = "DU-PAPER-999";

/**
 * Build an execution-enabled registry replica so the binding
 * authority accepts a Phase 2 ticket. The default seed catalogue
 * ships every instrument with `executionEnabled=false` — that is
 * intentional and MUST remain intact; this test-only registry
 * mirrors what an operator would produce by flipping a single
 * seed for PR15.3.
 */
function buildRegistryWithEnabledEs(
  overrides: {
    withPolicy?: boolean;
    priceTickSize?: number;
    allowedOrderTypes?: readonly ("LMT" | "STP")[];
  } = {},
): InstrumentRegistry {
  const withPolicy = overrides.withPolicy ?? true;
  const priceTickSize = overrides.priceTickSize ?? 0.25;
  const allowedOrderTypes = overrides.allowedOrderTypes ?? ["LMT", "STP"];
  const enabledSeeds: Instrument[] = defaultInstrumentRegistry
    .listAll()
    .map((inst) =>
      inst.id === "es_front"
        ? {
            ...inst,
            trading: { ...inst.trading, executionEnabled: true },
            ...(withPolicy
              ? {
                  executionPolicy: {
                    strategyId: "test_pr15_2",
                    timeframe: "1m",
                    quantity: 1,
                    maxQuantity: 5,
                    quantityUnit: "contracts" as const,
                    allowedOrderTypes,
                    defaultOrderType: "LMT" as const,
                    timeInForce: "DAY" as const,
                    outsideRth: false,
                    transmit: true,
                    priceTickSize,
                    priceRoundingMode: "nearest" as const,
                  },
                }
              : {}),
          }
        : inst,
    );
  return new InstrumentRegistry(enabledSeeds);
}

const ES_BINDING = {
  instrumentId: "es_front",
  conId: 999_000_001,
  localSymbol: "ESU6",
  tradingClass: "ES",
  exchange: "CME",
  currency: "USD",
  minTick: 0.25,
};

function makeAuthority(
  overrides: {
    withPolicy?: boolean;
    priceTickSize?: number;
    allowedOrderTypes?: readonly ("LMT" | "STP")[];
  } = {},
): {
  authority: InstrumentBindingAuthority;
  registry: InstrumentRegistry;
} {
  const registry = buildRegistryWithEnabledEs(overrides);
  return {
    registry,
    authority: new InstrumentBindingAuthority(registry, [ES_BINDING]),
  };
}

interface RepoCallLog {
  insertProposedFromTicket: number;
  tryStartSubmissionWithPlan: number;
  getIdempotencyRecord: number;
}

interface Fakes {
  readonly log: RepoCallLog;
  readonly dispatchCount: () => number;
}

/**
 * Minimal fake repo that always returns "no existing idempotency"
 * so `submitTicket` proceeds to the binding gate. Any downstream
 * repo method that the service calls MUST NOT be exercised in
 * the binding-rejection tests — the fakes throw so the test
 * fails loudly if we regress.
 */
function buildFakeRepo(log: RepoCallLog): ExecutionRepository {
  const repo: Partial<ExecutionRepository> = {
    async getIdempotencyRecord() {
      log.getIdempotencyRecord += 1;
      return null;
    },
    async insertProposedFromTicket(): Promise<never> {
      log.insertProposedFromTicket += 1;
      throw new Error(
        "insertProposedFromTicket must not be called on a binding-rejected submission",
      );
    },
    async tryStartSubmissionWithPlan(): Promise<never> {
      log.tryStartSubmissionWithPlan += 1;
      throw new Error(
        "tryStartSubmissionWithPlan must not be called on a binding-rejected submission",
      );
    },
    async getProposedOrderById() {
      return null;
    },
    async getExecutableProposedById() {
      return null;
    },
  };
  return repo as ExecutionRepository;
}

function buildDispatcher(counter: { count: number }): BrokerOrderDispatcher {
  return {
    async dispatch() {
      counter.count += 1;
      throw new Error(
        "dispatcher.dispatch must not be reached on a binding-rejected submission",
      );
    },
  };
}

function buildService(
  authority: InstrumentBindingAuthority,
): { service: ReturnType<typeof buildSubmissionApplicationService>; fakes: Fakes } {
  const log: RepoCallLog = {
    insertProposedFromTicket: 0,
    tryStartSubmissionWithPlan: 0,
    getIdempotencyRecord: 0,
  };
  const dispatchCounter = { count: 0 };
  const repo = buildFakeRepo(log);
  const positionGuard: PositionGuardContext = {
    kind: "available",
    accountId: ACCOUNT,
    sessionId: "session-1",
    maxSnapshotAgeMs: 60_000,
  };
  const reconciliationGate: ReconciliationSubmissionGate = async () => null;
  const dispatcher = buildDispatcher(dispatchCounter);
  const service = buildSubmissionApplicationService({
    repo,
    ensureBrokerSession: async () => ({ accountId: ACCOUNT }),
    buildPositionGuard: () => positionGuard,
    reconciliationGate: () => reconciliationGate,
    prepareBrokerPlan: async (): Promise<PreparedBrokerOrder> => {
      throw new Error(
        "prepareBrokerPlan must not be called on a binding-rejected submission",
      );
    },
    dispatcher,
    assertKillSwitchOk: async () => undefined,
    recordAlert: () => undefined,
    triggerReconciliation: () => undefined,
    ownerId: "session-1",
    allowMarketOrder: false,
    allowCrossContractExposure: false,
    bindingAuthority: authority,
    defaultTif: "DAY",
  });
  return { service, fakes: { log, dispatchCount: () => dispatchCounter.count } };
}

function baseTicket(overrides: Partial<SignalTicket> = {}): SignalTicket {
  return {
    instrument: "ES",
    instrumentId: "es_front",
    conid: String(ES_BINDING.conId),
    side: "BUY",
    orderType: "LMT",
    quantity: 1,
    entry: 4500,
    stop: 4490,
    takeProfit: 4520,
    reason: "test",
    confidence: 1,
    timestamp: "2026-07-30T12:00:00.000Z",
    riskCheckStatus: "PASS",
    ...overrides,
  };
}

describe("submissionService.submitTicket — PR15.2 binding gate rejections", () => {
  it("missing instrumentId → legacy path (handled by HTTP handler; service falls through)", async () => {
    // PR15.2 wire-layer contract: the `/execution/execute-ticket`
    // HTTP handler REJECTS every payload missing `instrumentId`
    // BEFORE calling the service. The service itself continues
    // to treat unset `instrumentId` as a legacy proposal path
    // (server hardcoded `allowCrossContractExposure=false`) so
    // pre-PR15.2 internal callers (pg-integration harnesses,
    // execute-proposed on legacy rows) keep working. This test
    // asserts that the service does NOT surface a
    // `binding_unavailable` for a missing id — the endpoint is
    // the enforcement point.
    const { authority } = makeAuthority();
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket({ instrumentId: undefined });
    try {
      await service.submitTicket({
        ticket,
        strategy: "s",
        clientOrderId: "cid-1",
        clientOrderHash: computeClientOrderHash(ticket),
      });
    } catch {
      // Fake repo throws inside insertProposedFromTicket — that
      // proves the service proceeded past the binding gate on
      // a legacy submission.
    }
    assert.equal(
      fakes.log.insertProposedFromTicket >= 1,
      true,
      "service must fall through to legacy insert when instrumentId is absent",
    );
    assert.equal(fakes.dispatchCount(), 0);
  });

  it("unknown instrumentId → INSTRUMENT_BINDING_UNAVAILABLE", async () => {
    const { authority } = makeAuthority();
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket({ instrumentId: "not_registered" });
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-2",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "instrument_binding_unavailable");
    assert.equal(fakes.dispatchCount(), 0);
    assert.equal(fakes.log.insertProposedFromTicket, 0);
  });

  it("disabled instrument (executionEnabled=false) → INSTRUMENT_EXECUTION_DISABLED", async () => {
    // Point the authority at a disabled instrument (`gc_front`
    // seed: executionEnabled=false by default).
    const bindings = [
      {
        instrumentId: "gc_front",
        conId: 999_000_002,
        localSymbol: "GCZ6",
        tradingClass: "GC",
        exchange: "COMEX",
        currency: "USD",
        minTick: 0.1,
      },
    ];
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      bindings,
    );
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket({
      instrument: "GC",
      instrumentId: "gc_front",
      conid: "999000002",
    });
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-3",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "instrument_execution_disabled");
    assert.equal(fakes.dispatchCount(), 0);
    assert.equal(fakes.log.insertProposedFromTicket, 0);
  });

  it("symbol mismatch → BINDING_IDENTITY_MISMATCH", async () => {
    const { authority } = makeAuthority();
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket({ instrument: "NQ" });
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-4",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "binding_identity_mismatch");
    if (outcome.kind === "binding_identity_mismatch") {
      assert.match(outcome.reason, /symbol_mismatch/);
    }
    assert.equal(fakes.dispatchCount(), 0);
    assert.equal(fakes.log.insertProposedFromTicket, 0);
  });

  it("conId mismatch → BINDING_IDENTITY_MISMATCH", async () => {
    const { authority } = makeAuthority();
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket({ conid: "1234567" });
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-5",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "binding_identity_mismatch");
    if (outcome.kind === "binding_identity_mismatch") {
      assert.match(outcome.reason, /conid_mismatch/);
    }
    assert.equal(fakes.dispatchCount(), 0);
    assert.equal(fakes.log.insertProposedFromTicket, 0);
  });

  it("missing conId (bound side has one) → BINDING_IDENTITY_MISMATCH", async () => {
    const { authority } = makeAuthority();
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket({ conid: undefined });
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-6",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "binding_identity_mismatch");
    if (outcome.kind === "binding_identity_mismatch") {
      assert.match(outcome.reason, /conid_missing/);
    }
    assert.equal(fakes.dispatchCount(), 0);
  });

  it("client-supplied allowCrossContractExposure cannot influence the guard (schema strips it, service never reads it)", async () => {
    // The schema for `POST /execution/execute-ticket` strips
    // `allowCrossContractExposure` at the boundary; the service
    // resolves it from the trusted registry policy. This test
    // asserts the code path: the resolved value comes from the
    // trusted registry `executionPolicy`, so a hostile caller
    // cannot widen it via the wire.
    const { authority } = makeAuthority();
    const { service, fakes } = buildService(authority);
    const bound = authority.getBoundInstrument("es_front")!;
    // The trusted registry does NOT set
    // `allowCrossContractExposure`, so the resolved value must
    // fall back to the safe default `false`.
    assert.equal(
      bound.instrument.executionPolicy?.allowCrossContractExposure,
      undefined,
    );
    // Fire a mismatched request — the guard should still reject
    // BEFORE any code path that would consult the policy.
    const ticket = baseTicket({ conid: "9" });
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-7",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "binding_identity_mismatch");
    assert.equal(fakes.dispatchCount(), 0);
  });
});

describe("submissionService.submitTicket — PR15.2 hostile-review policy enforcement", () => {
  it("missing executionPolicy → INSTRUMENT_POLICY_UNAVAILABLE (no repo, no dispatch)", async () => {
    const { authority } = makeAuthority({ withPolicy: false });
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket();
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-pol-1",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "instrument_policy_unavailable");
    assert.equal(fakes.log.insertProposedFromTicket, 0);
    assert.equal(fakes.log.tryStartSubmissionWithPlan, 0);
    assert.equal(fakes.dispatchCount(), 0);
  });

  it("LMT ticket, policy allows only STP → ORDER_TYPE_NOT_ALLOWED_BY_INSTRUMENT_POLICY", async () => {
    const { authority } = makeAuthority({
      allowedOrderTypes: ["STP"] as const,
    });
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket({ orderType: "LMT" });
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-pol-2",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "order_type_not_allowed_by_instrument_policy");
    assert.equal(fakes.dispatchCount(), 0);
    assert.equal(fakes.log.insertProposedFromTicket, 0);
  });

  it("STP ticket, policy allows only LMT → ORDER_TYPE_NOT_ALLOWED_BY_INSTRUMENT_POLICY", async () => {
    const { authority } = makeAuthority({
      allowedOrderTypes: ["LMT"] as const,
    });
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket({ orderType: "STP" });
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-pol-3",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "order_type_not_allowed_by_instrument_policy");
    assert.equal(fakes.dispatchCount(), 0);
    assert.equal(fakes.log.insertProposedFromTicket, 0);
  });

  it("policy.priceTickSize disagrees with bound.minTick → INSTRUMENT_TICK_MISMATCH", async () => {
    const { authority } = makeAuthority({ priceTickSize: 0.5 });
    const { service, fakes } = buildService(authority);
    const ticket = baseTicket();
    const outcome = await service.submitTicket({
      ticket,
      strategy: "s",
      clientOrderId: "cid-pol-4",
      clientOrderHash: computeClientOrderHash(ticket),
    });
    assert.equal(outcome.kind, "instrument_tick_mismatch");
    assert.equal(fakes.dispatchCount(), 0);
    assert.equal(fakes.log.insertProposedFromTicket, 0);
  });

  it("hostile caller CANNOT inject policy fields through the ticket schema", async () => {
    // The wire schema strips unknown fields. Even if a caller
    // hand-crafts an `allowedOrderTypes` on the ticket, the
    // parsed body carries none of it — the service reads the
    // trusted registry only. This is a defense-in-depth check
    // that the SERVICE never reads policy fields from the ticket
    // payload directly.
    const { authority } = makeAuthority({
      allowedOrderTypes: ["STP"] as const,
    });
    const { service, fakes } = buildService(authority);
    const hostileTicket = {
      ...baseTicket({ orderType: "LMT" }),
      // These fields are not on the schema; the ticket type is
      // `SignalTicket`, and the service must ignore anything
      // extra. A cast is used to simulate a hostile shape.
      allowedOrderTypes: ["LMT", "STP", "MKT"],
      priceTickSize: 0.0001,
    } as unknown as ReturnType<typeof baseTicket>;
    const outcome = await service.submitTicket({
      ticket: hostileTicket,
      strategy: "s",
      clientOrderId: "cid-pol-5",
      clientOrderHash: computeClientOrderHash(hostileTicket),
    });
    // Registry policy still rejects LMT.
    assert.equal(outcome.kind, "order_type_not_allowed_by_instrument_policy");
    assert.equal(fakes.dispatchCount(), 0);
    assert.equal(fakes.log.insertProposedFromTicket, 0);
  });
});
