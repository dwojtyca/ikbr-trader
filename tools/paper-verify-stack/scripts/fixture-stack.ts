#!/usr/bin/env node
/**
 * PR15.1 — deterministic fixture stack for the paper-verify
 * CLI acceptance test.
 *
 * Starts three localhost HTTP servers on plan-canonical ports
 * (ingestion 3101, signal 3102, execution 3103) that reply
 * with the same canned JSON payloads exercised by the
 * `run.test.ts` fixtures. Records every observed request and
 * writes the log to stdout on shutdown. GET-only, allowlisted
 * paths only — the servers 404 anything outside the 14 keys
 * declared in `endpoints.ts`.
 *
 * The fixture NEVER contacts IBKR. It NEVER issues broker
 * requests. It is intended to validate the CLI end-to-end
 * without a live paper stack.
 *
 * Usage:
 *   node --import tsx tools/paper-verify-stack/scripts/fixture-stack.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const NOW = Date.now();
const FRESH_ISO = new Date(NOW - 5_000).toISOString();

type Route = (req: IncomingMessage, res: ServerResponse) => void;

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

const requestLog: Array<{ port: number; method: string; url: string }> = [];

function mkServer(port: number, routes: Record<string, Route>) {
  const server = createServer((req, res) => {
    requestLog.push({
      port,
      method: req.method ?? "?",
      url: req.url ?? "?",
    });
    const path = (req.url ?? "").split("?")[0];
    const query = (req.url ?? "").includes("?")
      ? "?" + (req.url ?? "").split("?").slice(1).join("?")
      : "";
    const key = `${req.method} ${path}${query}`;
    const keyNoQuery = `${req.method} ${path}`;
    const handler = routes[key] ?? routes[keyNoQuery];
    if (!handler) {
      res.writeHead(404).end("not_found");
      return;
    }
    handler(req, res);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const ingestion = mkServer(3101, {
  "GET /health": (_req, res) =>
    json(res, {
      ok: true,
      connected: true,
      bootstrapped: true,
      bootstrapping: false,
      lastBootstrapAt: FRESH_ISO,
      lastTickAt: FRESH_ISO,
      lastCandleAt: FRESH_ISO,
    }),
  "GET /watchlist": (_req, res) =>
    json(res, {
      connected: true,
      bootstrapped: true,
      bootstrapping: false,
      lastBootstrapAt: FRESH_ISO,
      watchlist: [
        {
          symbol: "AAPL",
          displayName: "Apple",
          conid: "265598",
          subscribed: true,
          marketState: { ts: FRESH_ISO },
          latestCandle1m: { ts: FRESH_ISO },
        },
      ],
    }),
});

const signal = mkServer(3102, {
  "GET /health": (_req, res) => json(res, { ok: true }),
  "GET /runtime/health": (_req, res) => json(res, { ok: true }),
  "GET /runtime/ready": (_req, res) =>
    json(res, { ready: true, checks: { init: { ok: true } } }),
  "GET /runtime/execute/ready": (_req, res) =>
    json(res, {
      ready: true,
      checks: {
        redis: { ok: true },
        postgres: { ok: true },
        paperGuard: { ok: true },
      },
    }),
  "GET /runtime/trading-loop/status": (_req, res) =>
    json(res, {
      enabled: false,
      running: false,
      startedAt: null,
      lastCycleAt: null,
      nextCycleAt: null,
      activeInstruments: [],
      cycleCount: 0,
      lastOutcomes: {},
    }),
  "GET /runtime/trading-loop/ready": (_req, res) =>
    json(res, {
      ready: true,
      enabled: false,
      checks: { init: { ok: true } },
    }),
});

const execution = mkServer(3103, {
  "GET /health": (_req, res) => json(res, { ok: true, twsConnected: true }),
  "GET /ready": (_req, res) =>
    json(res, {
      ready: true,
      environment: "paper",
      tradingEnabled: false,
      account: "DU1234567",
      reconciliation: {
        ageSeconds: 5,
        maxAgeSeconds: 300,
        lastRanAt: FRESH_ISO,
      },
      checks: {
        brokerSocket: true,
        activeAccountKnown: true,
        accountMatchesEnvironment: true,
        auditWriteAvailable: true,
        reconciliationFresh: true,
        positionSnapshotHealthy: true,
      },
      reasons: [],
    }),
  "GET /execution/kill-switch": (_req, res) =>
    json(res, {
      enabled: true,
      triggered: false,
      dailyRealizedPnL: 0,
      baseCurrency: "USD",
      since: FRESH_ISO,
      thresholds: { maxDailyLossPct: 5 },
      netLiquidation: 100_000,
      diagnostics: {
        missingFxRates: 0,
        missingCommissionReports: 0,
        complete: true,
        snapshotCacheAgeMs: 1_000,
      },
    }),
  "GET /execution/reconciliation/latest": (_req, res) =>
    json(res, {
      accountId: "DU1234567",
      sessionId: "sess-1",
      run: {
        sessionId: "sess-1",
        accountId: "DU1234567",
        completedAt: FRESH_ISO,
        status: "CLEAN",
        snapshotComplete: true,
      },
      stale: false,
      maxAgeSeconds: 300,
    }),
  "GET /execution/reconciliation/holds?active=true": (_req, res) =>
    json(res, { holds: [] }),
  "GET /execution/account/summary": (_req, res) =>
    json(res, {
      accountId: "DU1234567",
      netLiquidation: 100_000,
    }),
});

function shutdown() {
  process.stderr.write(
    `fixture-stack: observed ${requestLog.length} request(s):\n`,
  );
  for (const r of requestLog) {
    process.stderr.write(`  :${r.port}  ${r.method} ${r.url}\n`);
  }
  ingestion.close();
  signal.close();
  execution.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.stderr.write(
  "fixture-stack: listening on 127.0.0.1:{3101,3102,3103}. Ctrl-C to stop.\n",
);
