import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Pool } from "pg";
import type { Redis } from "ioredis";

import { SignalRepository } from "./repository.js";

// ---------------------------------------------------------------------------
// PR15.4 §14.11 — repository unit tests with a fake Pool. We assert
// SQL / parameter shape and mutex serialization; NO real DB connection.
// ---------------------------------------------------------------------------

interface FakePool {
  calls: Array<{ sql: string; params?: unknown[] }>;
  handler?: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[] } | { rows: unknown[] }>;
  query: Pool["query"];
}

function makeFakePool(
  handler: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
): FakePool {
  const calls: FakePool["calls"] = [];
  const fp: FakePool = {
    calls,
    handler,
    query: (async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return handler(sql, params);
    }) as unknown as Pool["query"],
  };
  return fp;
}

function makeFakeRedis(): Redis {
  return {
    async get() {
      return null;
    },
  } as unknown as Redis;
}

function buildRepo(pool: FakePool): SignalRepository {
  return new SignalRepository(pool as unknown as Pool, makeFakeRedis());
}

// ---------------------------------------------------------------------------
// getInstrumentContractByConId
// ---------------------------------------------------------------------------

describe("SignalRepository.getInstrumentContractByConId — exact-conId SQL", () => {
  it("executes WHERE conid = $1 with the caller-supplied string; no symbol fallback", async () => {
    const pool = makeFakePool(async () => ({
      rows: [
        {
          symbol: "AAPL",
          conid: "265598",
          sec_type: "STK",
          exchange: "NASDAQ",
          primary_exchange: "NASDAQ",
          currency: "USD",
          local_symbol: "AAPL",
          trading_class: "NMS",
          min_tick: 0.01,
          display_name: null,
          contract_json: null,
          details_json: null,
          source: "ibkr",
          resolved_at: new Date("2026-06-01T00:00:00Z"),
        },
      ],
    }));
    const repo = buildRepo(pool);
    const contract = await repo.getInstrumentContractByConId("265598");
    assert.ok(contract);
    assert.equal(contract!.conid, "265598");
    assert.equal(pool.calls.length, 1);
    assert.match(pool.calls[0].sql, /WHERE conid = \$1/);
    assert.ok(!/UPPER\(symbol\)/.test(pool.calls[0].sql));
    assert.ok(!/OR/i.test(pool.calls[0].sql));
    assert.deepEqual(pool.calls[0].params, ["265598"]);
  });

  it("returns null when no row matches", async () => {
    const pool = makeFakePool(async () => ({ rows: [] }));
    const repo = buildRepo(pool);
    const contract = await repo.getInstrumentContractByConId("999999");
    assert.equal(contract, null);
  });
});

// ---------------------------------------------------------------------------
// getRecentCandlesForContract
// ---------------------------------------------------------------------------

describe("SignalRepository.getRecentCandlesForContract — exact-conId candle SQL", () => {
  it("uses the timeframe-specific table, WHERE UPPER(symbol)=UPPER($1) AND conid=$2", async () => {
    const pool = makeFakePool(async () => ({
      rows: [
        {
          conid: "265598",
          symbol: "AAPL",
          ts: new Date("2026-07-14T12:00:00Z"),
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 1000,
        },
        {
          conid: "265598",
          symbol: "AAPL",
          ts: new Date("2026-07-14T11:00:00Z"),
          open: 99,
          high: 100,
          low: 98,
          close: 99.5,
          volume: 900,
        },
      ],
    }));
    const repo = buildRepo(pool);
    const candles = await repo.getRecentCandlesForContract(
      "AAPL",
      "265598",
      "1h",
      10,
    );
    assert.equal(pool.calls.length, 1);
    assert.match(pool.calls[0].sql, /FROM candles_1h/);
    assert.match(pool.calls[0].sql, /UPPER\(symbol\) = UPPER\(\$1\)/);
    assert.match(pool.calls[0].sql, /conid = \$2/);
    assert.match(pool.calls[0].sql, /LIMIT \$3/);
    assert.deepEqual(pool.calls[0].params, ["AAPL", "265598", 10]);
    // Rows returned newest-first; helper reverses to ascending ts order.
    assert.equal(candles.length, 2);
    assert.ok(candles[0].ts.getTime() < candles[1].ts.getTime());
  });

  it("excludes rows for a different conId (asserted at SQL level via WHERE clause)", async () => {
    // The query already filters by conid = $2. To exercise the safety we
    // simulate the DB filtering: only the row matching conid is returned.
    const pool = makeFakePool(async (_sql, params) => {
      const conid = params?.[1];
      return {
        rows: [
          {
            conid,
            symbol: "AAPL",
            ts: new Date("2026-07-14T12:00:00Z"),
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 1000,
          },
        ],
      };
    });
    const repo = buildRepo(pool);
    const rows = await repo.getRecentCandlesForContract(
      "AAPL",
      "265598",
      "1m",
      5,
    );
    assert.equal(rows[0].conid, "265598");
  });
});

// ---------------------------------------------------------------------------
// syncStrategyRuntimeStates mutex serialization
// ---------------------------------------------------------------------------

describe("SignalRepository.syncStrategyRuntimeStates — mutex serialization", () => {
  it("two concurrent calls with different args are serialized; both complete with their own args preserved", async () => {
    const startOrder: string[] = [];
    const finishOrder: string[] = [];
    const resolvers: { first: (() => void) | null } = { first: null };
    const pool = makeFakePool((async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM strategy_runtime_state")) {
        const strategyIds = params?.[0] as string[] | undefined;
        const label = strategyIds?.[0] ?? "unknown";
        startOrder.push(label);
        if (label === "strategy_a") {
          await new Promise<void>((res) => {
            resolvers.first = res;
          });
        }
        finishOrder.push(label);
      }
      return { rows: [] };
    }) as (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>);
    const repo = buildRepo(pool);
    const p1 = repo.syncStrategyRuntimeStates(["strategy_a"], 1000);
    const p2 = repo.syncStrategyRuntimeStates(["strategy_b"], 2000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(startOrder, ["strategy_a"]);
    resolvers.first?.();
    await Promise.all([p1, p2]);
    assert.deepEqual(startOrder, ["strategy_a", "strategy_b"]);
    assert.deepEqual(finishOrder, ["strategy_a", "strategy_b"]);
    const anyCalls = pool.calls.filter((c) =>
      c.sql.includes("FROM strategy_runtime_state"),
    );
    assert.deepEqual(anyCalls[0].params, [["strategy_a"]]);
    assert.deepEqual(anyCalls[1].params, [["strategy_b"]]);
  });

  it("first sync rejecting does not block the second (mutex tail advances on error)", async () => {
    let call = 0;
    const pool = makeFakePool(async (sql: string) => {
      if (sql.includes("FROM strategy_runtime_state")) {
        call += 1;
        if (call === 1) throw new Error("boom");
      }
      return { rows: [] };
    });
    const repo = buildRepo(pool);
    const p1 = repo.syncStrategyRuntimeStates(["strategy_a"], 1000);
    const p2 = repo.syncStrategyRuntimeStates(["strategy_b"], 2000);
    await assert.rejects(p1, /boom/);
    // Second call must still resolve.
    await p2;
    assert.equal(call, 2);
  });
});
