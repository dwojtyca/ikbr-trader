import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import Fastify, { type FastifyInstance } from "fastify";
import {
  DEFAULT_FRESHNESS_POLICY,
  DecisionEngine,
  ExecutionTicketBuilder,
  InstrumentRegistry,
  RiskEngine,
  SignalEngine,
  TradingPipeline,
  type ExecutionTicketPolicy,
  type Instrument,
  type Rule,
} from "@ikbr/shared";

import {
  MarketDataRuntime,
  buildRuntimeFreshnessPolicy,
} from "../runtime.js";
import { PriceContextProvider } from "../price-provider.js";
import type {
  MarketDataRuntimeReader,
  RuntimeMarketState,
} from "../market-data-reader.js";
import { ExecutionRuntime } from "./execution-runtime.js";
import { PaperGuard } from "./paper-guard.js";
import type { ExecutionTicketSubmitter, SubmitInput, SubmitResult } from "./submitter.js";
import { executionRuntimeRoutesPlugin } from "./routes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INSTRUMENT: Instrument = {
  id: "routes_write_test_stk",
  displayName: "Routes Write Test Stock",
  assetClass: "stock",
  broker: "ibkr",
  brokerSymbol: "RTX",
  exchange: "NYSE",
  currency: "USD",
  primaryExchange: "NYSE",
  trading: {
    executionEnabled: true,
    signalGenerationEnabled: true,
    aiAnalysisEnabled: true,
    monitoringEnabled: true,
  },
  risk: {
    maxQuantity: 100,
    quantityUnit: "shares",
    maxLeverage: 1,
    allowOvernight: true,
    maxSpread: 0.5,
    maxSlippage: 1.0,
  },
  session: {
    useRegularTradingHours: true,
    timezone: "America/New_York",
    sessionTemplate: "us_stock_rth",
  },
  metadata: { tags: [] },
};

const REGISTRY = new InstrumentRegistry([INSTRUMENT]);

const POLICY: ExecutionTicketPolicy = {
  quantity: 10,
  orderType: "LMT",
  timeInForce: "DAY",
  outsideRth: false,
  transmit: true,
  priceTickSize: 0.01,
  priceRoundingMode: "nearest",
  entryOffset: 0,
  stopLossDistance: 1,
  takeProfitDistance: 2,
};

const TOKEN = "test-token-abcdefghijklmnopqrstuvwxyz012345";

function freshState(): RuntimeMarketState {
  return {
    instrumentId: INSTRUMENT.id,
    lastPrice: 100,
    bid: 99.98,
    ask: 100.02,
    observedAt: new Date(),
    source: "redis:market-state:test",
  };
}

function fakeReader(state: RuntimeMarketState | null): MarketDataRuntimeReader {
  return {
    async readMarketState() {
      return state;
    },
  };
}

class BullishFixtureRule implements Rule {
  readonly id = "runtime-test-bullish";
  readonly category = "TECHNICAL" as const;
  supports(): boolean {
    return true;
  }
  evaluate(): ReturnType<Rule["evaluate"]> {
    return {
      scoreContribution: 60,
      reasons: [
        {
          id: "runtime-test-bullish",
          category: "TECHNICAL",
          weight: 1,
          direction: "BULLISH",
          message: "test fixture",
        },
      ],
      warnings: [],
      blockers: [],
    };
  }
}

function buildSuccessPipeline(): TradingPipeline {
  const decisionEngine = new DecisionEngine({
    rules: [new BullishFixtureRule()],
  });
  const riskEngine = new RiskEngine({ rules: [] });
  const signalEngine = new SignalEngine({
    decisionEngine,
    riskEngine,
    instrumentResolver: (id) => REGISTRY.getInstrumentOrThrow(id),
  });
  const ticketBuilder = new ExecutionTicketBuilder({
    idFactory: () => "ticket-id-fixture",
    correlationIdFactory: () => "corr-id-fixture",
  });
  return new TradingPipeline({ signalEngine, ticketBuilder });
}

function paperOkGuard(): PaperGuard {
  return new PaperGuard({
    probe: {
      async probeReady() {
        return {
          kind: "ok",
          ready: true,
          environment: "paper",
          accountMatchesEnvironment: true,
        };
      },
    },
    expectedEnvironment: "paper",
  });
}

function trackingSubmitter(
  behaviour: SubmitResult,
): ExecutionTicketSubmitter & { calls: SubmitInput[] } {
  const calls: SubmitInput[] = [];
  return {
    calls,
    async submit(input) {
      calls.push(input);
      return behaviour;
    },
  };
}

async function buildApp(options: {
  readonly submitter: ExecutionTicketSubmitter;
  readonly paperGuard?: PaperGuard;
  readonly token?: string;
  readonly reader?: MarketDataRuntimeReader;
}): Promise<FastifyInstance> {
  const reader = options.reader ?? fakeReader(freshState());
  const provider = new PriceContextProvider({
    reader,
    freshnessTtlMs: 30_000,
  });
  const dryRun = new MarketDataRuntime({
    registry: REGISTRY,
    providers: [provider],
    pipeline: buildSuccessPipeline(),
    freshnessPolicy: buildRuntimeFreshnessPolicy({
      base: DEFAULT_FRESHNESS_POLICY,
      maxTickAgeMs: 30_000,
    }),
  });
  const runtime = new ExecutionRuntime({
    dryRun,
    paperGuard: options.paperGuard ?? paperOkGuard(),
    submitter: options.submitter,
  });
  const app = Fastify({ logger: false });
  await app.register(executionRuntimeRoutesPlugin, {
    runtime,
    bearerToken: options.token ?? TOKEN,
    readinessDeps: {
      redis: { ping: async () => "PONG" },
      postgres: { query: async () => ({}) },
      paperGuard: options.paperGuard ?? paperOkGuard(),
    },
  });
  return app;
}

const openApps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(openApps.map((a) => a.close()));
});

async function makeApp(
  options: Parameters<typeof buildApp>[0],
): Promise<FastifyInstance> {
  const app = await buildApp(options);
  openApps.push(app);
  return app;
}

const validBody = {
  instrumentId: INSTRUMENT.id,
  policy: POLICY,
  idempotencyKey: "idem-1",
};

const authHeader = { authorization: `Bearer ${TOKEN}` };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /runtime/execute — auth", () => {
  it("returns 401 without an Authorization header", async () => {
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      payload: validBody,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(submitter.calls.length, 0);
  });

  it("returns 401 with an incorrect token", async () => {
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: { authorization: "Bearer wrong-token" },
      payload: validBody,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(submitter.calls.length, 0);
  });

  it("returns 401 when the server has no configured token (fail-closed)", async () => {
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const app = await makeApp({ submitter, token: "" });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: validBody,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(submitter.calls.length, 0);
  });
});

describe("POST /runtime/execute — request validation", () => {
  it("returns 400 when idempotencyKey is missing", async () => {
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: { instrumentId: INSTRUMENT.id, policy: POLICY },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, "invalid_body");
    assert.equal(submitter.calls.length, 0);
  });

  it("returns 400 when policy.orderType is 'MKT' (unsupported)", async () => {
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: {
        ...validBody,
        policy: { ...POLICY, orderType: "MKT" },
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(submitter.calls.length, 0);
  });

  it("returns 400 when policy.orderType is 'STP_LMT' — PR13 does NOT silently coerce to STP", async () => {
    // PR13 blocker fix: STP_LMT is a distinct order type and the
    // legacy `SignalTicket` wire type has no STP_LMT variant.
    // Silently mapping to STP would drop the limit price and
    // change the order semantics at the broker. Reject at the
    // schema layer instead.
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: {
        ...validBody,
        policy: { ...POLICY, orderType: "STP_LMT" },
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, "invalid_body");
    assert.equal(submitter.calls.length, 0);
  });

  it("accepts 'LMT' and 'STP' order types", async () => {
    for (const orderType of ["LMT", "STP"] as const) {
      const submitter = trackingSubmitter({
        kind: "submitted",
        response: {
          execution: {
            accountId: "PAPER-1",
            brokerOrderId: `b-${orderType}`,
            status: "SUBMITTED",
          },
        },
      });
      const app = await makeApp({ submitter });
      const res = await app.inject({
        method: "POST",
        url: "/runtime/execute",
        headers: authHeader,
        payload: {
          ...validBody,
          policy: { ...POLICY, orderType },
        },
      });
      // The dry-run pipeline in this test uses a bullish fixture
      // rule; with STP the pipeline may reject on missing entry.
      // We only assert that the request is NOT rejected at the
      // schema layer (i.e. status is not 400).
      assert.notEqual(
        res.statusCode,
        400,
        `orderType=${orderType} must not be rejected at the schema layer`,
      );
    }
  });
});

describe("POST /runtime/execute — outcome mapping", () => {
  it("SUCCESS + submitter SUBMITTED → 200 SUBMITTED payload", async () => {
    const submitter = trackingSubmitter({
      kind: "submitted",
      response: {
        execution: {
          accountId: "PAPER-1",
          brokerOrderId: "b-1",
          status: "SUBMITTED",
        },
      },
    });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: validBody,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { outcome: string };
    assert.equal(body.outcome, "SUBMITTED");
    assert.equal(submitter.calls.length, 1);
  });

  it("duplicate_submitted → 200 DUPLICATE (idempotent replay is NOT an error)", async () => {
    const submitter = trackingSubmitter({
      kind: "duplicate_submitted",
      response: {
        outcome: "DUPLICATE_SUBMITTED",
        duplicate: true,
        order: { id: 42, status: "SUBMITTED" },
      },
    });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: validBody,
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { outcome: string }).outcome, "DUPLICATE");
  });

  it("duplicate_terminal (previous attempt REJECTED) → 200 DUPLICATE — caller reads previousExecution.status", async () => {
    const submitter = trackingSubmitter({
      kind: "duplicate_terminal",
      response: {
        outcome: "DUPLICATE_TERMINAL",
        duplicate: true,
        order: { id: 42, status: "REJECTED" },
      },
    });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: validBody,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      outcome: string;
      previousExecution: { status: string };
    };
    assert.equal(body.outcome, "DUPLICATE");
    // Terminal status surfaced on previousExecution.order.status
    // — the caller MUST NOT treat this as a successful submission.
    assert.equal(body.previousExecution.status, "REJECTED");
  });

  it("duplicate_pending_ambiguous → 200 PENDING with reason 'ambiguous_attempt'", async () => {
    const submitter = trackingSubmitter({
      kind: "duplicate_pending_ambiguous",
      response: {
        outcome: "DUPLICATE_PENDING_AMBIGUOUS",
        duplicate: true,
        order: {
          id: 42,
          status: "PROPOSED",
          executionAttemptedAt: "2026-07-14T12:00:00.000Z",
        },
      },
    });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: validBody,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { outcome: string; reason: string };
    assert.equal(body.outcome, "PENDING");
    assert.equal(body.reason, "ambiguous_attempt");
  });

  it("pending_claimed → 200 PENDING with reason 'claim_held_by_other'", async () => {
    const submitter = trackingSubmitter({
      kind: "pending_claimed",
      response: {
        outcome: "PENDING_CLAIMED",
        duplicate: true,
        order: { id: 42, status: "PROPOSED" },
      },
    });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: validBody,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { outcome: string; reason: string };
    assert.equal(body.outcome, "PENDING");
    assert.equal(body.reason, "claim_held_by_other");
  });

  it("conflict → 409 CONFLICT", async () => {
    const submitter = trackingSubmitter({
      kind: "conflict",
      message: "idempotency_conflict",
    });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: validBody,
    });
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as { outcome: string }).outcome, "CONFLICT");
  });

  it("execution-engine 500 → 200 UNKNOWN (no client-visible auto-retry)", async () => {
    const submitter = trackingSubmitter({
      kind: "unknown",
      reason: "execution-engine returned 500 Internal Server Error",
    });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: validBody,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { outcome: string; reason: string };
    assert.equal(body.outcome, "UNKNOWN");
    assert.match(body.reason, /500/);
  });
});

describe("POST /runtime/execute — safety invariants", () => {
  it("client CANNOT bypass the pipeline by supplying a raw ticket in the body", async () => {
    const submitter = trackingSubmitter({
      kind: "submitted",
      response: {
        execution: {
          accountId: "PAPER-1",
          brokerOrderId: "b-1",
          status: "SUBMITTED",
        },
      },
    });
    const app = await makeApp({ submitter });
    // Include a bogus `ticket` field in the body — the schema
    // should either ignore it or reject the body. Either way, the
    // downstream submitter must receive the runtime-generated
    // ticket, not the client-supplied one.
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: {
        ...validBody,
        ticket: { instrument: "HACKER_INSTRUMENT", side: "SELL" },
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(submitter.calls.length, 1);
    // Runtime-generated ticket wins.
    assert.equal(submitter.calls[0].ticket.instrument, "RTX");
    assert.equal(submitter.calls[0].ticket.side, "BUY");
  });

  it("paper guard failure → 200 NOT_SUBMITTED, zero submit calls", async () => {
    const submitter = trackingSubmitter({
      kind: "submitted",
      response: {
        execution: {
          accountId: "PAPER-1",
          brokerOrderId: "b-1",
          status: "SUBMITTED",
        },
      },
    });
    const paperGuard = new PaperGuard({
      probe: {
        async probeReady() {
          return {
            kind: "ok",
            ready: true,
            environment: "live",
            accountMatchesEnvironment: true,
          };
        },
      },
      expectedEnvironment: "paper",
    });
    const app = await makeApp({ submitter, paperGuard });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: validBody,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { outcome: string; reason: string };
    assert.equal(body.outcome, "NOT_SUBMITTED");
    assert.equal(body.reason, "PAPER_GUARD_FAILED");
    assert.equal(submitter.calls.length, 0);
  });

  it("stale price → NOT_SUBMITTED, zero submit calls", async () => {
    const submitter = trackingSubmitter({
      kind: "submitted",
      response: {
        execution: {
          accountId: "PAPER-1",
          brokerOrderId: "b-1",
          status: "SUBMITTED",
        },
      },
    });
    const staleReader = fakeReader({
      instrumentId: INSTRUMENT.id,
      lastPrice: 100,
      bid: 99.98,
      ask: 100.02,
      observedAt: new Date(Date.now() - 10 * 60 * 1000),
      source: "redis:market-state:test",
    });
    const app = await makeApp({ submitter, reader: staleReader });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/execute",
      headers: authHeader,
      payload: validBody,
    });
    assert.equal(res.statusCode, 200);
    assert.notEqual((res.json() as { outcome: string }).outcome, "SUBMITTED");
    assert.equal(submitter.calls.length, 0);
  });
});

describe("GET /runtime/execute/ready", () => {
  it("returns 200 when Redis + Postgres + paper-guard all pass", async () => {
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const app = await makeApp({ submitter });
    const res = await app.inject({
      method: "GET",
      url: "/runtime/execute/ready",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ready: boolean };
    assert.equal(body.ready, true);
  });

  it("returns 503 when the paper guard reports live", async () => {
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const paperGuard = new PaperGuard({
      probe: {
        async probeReady() {
          return {
            kind: "ok",
            ready: true,
            environment: "live",
            accountMatchesEnvironment: true,
          };
        },
      },
      expectedEnvironment: "paper",
    });
    const app = await makeApp({ submitter, paperGuard });
    const res = await app.inject({
      method: "GET",
      url: "/runtime/execute/ready",
    });
    assert.equal(res.statusCode, 503);
  });
});
