import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import Fastify, { type FastifyInstance } from "fastify";
import {
  DEFAULT_FRESHNESS_POLICY,
  InstrumentRegistry,
  type ExecutionTicketPolicy,
  type Instrument,
} from "@ikbr/shared";

import { createRuntimeEngines } from "./engines.js";
import {
  MarketDataRuntime,
  buildRuntimeFreshnessPolicy,
} from "./runtime.js";
import { PriceContextProvider } from "./price-provider.js";
import { runtimeRoutesPlugin } from "./routes.js";
import type {
  MarketDataRuntimeReader,
  RuntimeMarketState,
} from "./market-data-reader.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INSTRUMENT: Instrument = {
  id: "routes_test_stk",
  displayName: "Routes Test Stock",
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

function fakeReader(state: RuntimeMarketState | null): MarketDataRuntimeReader {
  return {
    async readMarketState() {
      return state;
    },
  };
}

const POLICY: ExecutionTicketPolicy = {
  quantity: 10,
  orderType: "LMT",
  timeInForce: "DAY",
  outsideRth: false,
  transmit: true,
  priceTickSize: 0.01,
  priceRoundingMode: "nearest",
};

async function buildApp(
  reader: MarketDataRuntimeReader,
  readiness: {
    readonly redis: { ping: () => Promise<unknown> };
    readonly postgres: { query: (text: string) => Promise<unknown> };
  } = {
    redis: { ping: async () => "PONG" },
    postgres: { query: async () => ({}) },
  },
): Promise<FastifyInstance> {
  const provider = new PriceContextProvider({
    reader,
    freshnessTtlMs: 30_000,
  });
  const { pipeline } = createRuntimeEngines({ registry: REGISTRY });
  const runtime = new MarketDataRuntime({
    registry: REGISTRY,
    providers: [provider],
    pipeline,
    freshnessPolicy: buildRuntimeFreshnessPolicy({
      base: DEFAULT_FRESHNESS_POLICY,
      maxTickAgeMs: 30_000,
    }),
  });
  const app = Fastify({ logger: false });
  await app.register(runtimeRoutesPlugin, {
    runtime,
    readinessDeps: readiness,
  });
  return app;
}

const openApps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(openApps.map((a) => a.close()));
});

async function makeApp(
  reader: MarketDataRuntimeReader,
  readiness?: Parameters<typeof buildApp>[1],
): Promise<FastifyInstance> {
  const app = await buildApp(reader, readiness);
  openApps.push(app);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /runtime/health", () => {
  it("returns 200 with { ok: true }", async () => {
    const app = await makeApp(fakeReader(null));
    const res = await app.inject({ method: "GET", url: "/runtime/health" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });
});

describe("GET /runtime/ready", () => {
  it("returns 200 when both Redis and Postgres respond", async () => {
    const app = await makeApp(fakeReader(null));
    const res = await app.inject({ method: "GET", url: "/runtime/ready" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ready: boolean };
    assert.equal(body.ready, true);
  });

  it("returns 503 when Redis is unreachable", async () => {
    const app = await makeApp(fakeReader(null), {
      redis: {
        ping: async () => {
          throw new Error("no redis");
        },
      },
      postgres: { query: async () => ({}) },
    });
    const res = await app.inject({ method: "GET", url: "/runtime/ready" });
    assert.equal(res.statusCode, 503);
  });
});

describe("POST /runtime/dry-run — validation", () => {
  it("rejects a body with a missing instrumentId", async () => {
    const app = await makeApp(fakeReader(null));
    const res = await app.inject({
      method: "POST",
      url: "/runtime/dry-run",
      payload: { policy: POLICY },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, "invalid_body");
  });

  it("rejects a body with an unsupported orderType (e.g. MKT)", async () => {
    const app = await makeApp(fakeReader(null));
    const res = await app.inject({
      method: "POST",
      url: "/runtime/dry-run",
      payload: {
        instrumentId: INSTRUMENT.id,
        policy: { ...POLICY, orderType: "MKT" },
      },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe("POST /runtime/dry-run — outcomes", () => {
  it("returns 404 for an unknown instrument", async () => {
    const app = await makeApp(fakeReader(null));
    const res = await app.inject({
      method: "POST",
      url: "/runtime/dry-run",
      payload: { instrumentId: "does_not_exist", policy: POLICY },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(
      (res.json() as { error: string }).error,
      "instrument_not_found",
    );
  });

  it("returns 200 with a non-SUCCESS TradingPipelineResult when price is unavailable", async () => {
    const app = await makeApp(fakeReader(null));
    const res = await app.inject({
      method: "POST",
      url: "/runtime/dry-run",
      payload: { instrumentId: INSTRUMENT.id, policy: POLICY },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      instrumentId: string;
      snapshot: { sections: { price: { status: string } } };
      pipeline: { outcome: string; ticket: unknown };
    };
    assert.equal(body.instrumentId, INSTRUMENT.id);
    assert.equal(body.snapshot.sections.price.status, "unavailable");
    assert.notEqual(body.pipeline.outcome, "SUCCESS");
    assert.equal(body.pipeline.ticket, null);
  });

  it("returns 200 with pipeline evaluated for a fresh tick", async () => {
    const app = await makeApp(
      fakeReader({
        instrumentId: INSTRUMENT.id,
        lastPrice: 100,
        bid: 99.98,
        ask: 100.02,
        observedAt: new Date(),
        source: "redis:market-state:999002",
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/runtime/dry-run",
      payload: { instrumentId: INSTRUMENT.id, policy: POLICY },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      snapshot: {
        sections: { price: { status: string; data: { last: number } } };
      };
      pipeline: { outcome: string; durationMs: number };
    };
    assert.equal(body.snapshot.sections.price.status, "fresh");
    assert.equal(body.snapshot.sections.price.data.last, 100);
    // The exact outcome is a function of the default engines'
    // ruleset — asserted separately in runtime.test.ts. Here we only
    // confirm the HTTP layer returns a legitimate discriminated
    // union value with a well-formed shape.
    assert.ok(
      ["SUCCESS", "NO_TRADE", "FAILURE"].includes(body.pipeline.outcome),
    );
    assert.equal(typeof body.pipeline.durationMs, "number");
  });
});
