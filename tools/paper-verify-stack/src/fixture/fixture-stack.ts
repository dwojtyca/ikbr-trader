/**
 * PR15.1 follow-up — dynamic-port fixture stack.
 *
 * Three localhost HTTP servers bound to `127.0.0.1:0` (OS-
 * allocated ports) so the fixture never collides with the
 * real Docker Compose services on `3101` / `3102` / `3103`.
 * Serves canned JSON payloads for the exact 14 endpoint keys
 * declared in [../endpoints.ts]; response paths and service
 * ownership are derived from that registry so the fixture
 * cannot silently drift from the tool's allowlist.
 *
 * The fixture NEVER contacts IBKR, never fires broker
 * requests, and only accepts `GET` — every other method
 * responds `404 not_found`. Requests are logged for later
 * inspection by the harness / tests.
 */

import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import {
  ENDPOINTS,
  type EndpointKey,
  type EndpointService,
} from "../endpoints.js";

export interface FixtureRequest {
  readonly service: EndpointService;
  readonly port: number;
  readonly method: string;
  readonly url: string;
  readonly key: EndpointKey | null;
  readonly at: number;
}

export interface FixtureHandle {
  readonly ingestionUrl: string;
  readonly signalUrl: string;
  readonly executionUrl: string;
  readonly ports: Readonly<Record<EndpointService, number>>;
  requestLog(): readonly FixtureRequest[];
  clearRequestLog(): void;
  shutdown(): Promise<void>;
  isShutdown(): boolean;
}

export interface StartFixtureStackOptions {
  /** Fixed timestamp anchor for `FRESH_ISO` payloads; defaults to `Date.now()`. */
  readonly now?: number;
}

interface FixturePayload {
  readonly status: number;
  readonly body: unknown;
}

function buildPayloads(now: number): Record<EndpointKey, FixturePayload> {
  const freshIso = new Date(now - 5_000).toISOString();
  return {
    INGESTION_HEALTH: {
      status: 200,
      body: {
        ok: true,
        connected: true,
        bootstrapped: true,
        bootstrapping: false,
        lastBootstrapAt: freshIso,
        lastTickAt: freshIso,
        lastCandleAt: freshIso,
      },
    },
    INGESTION_WATCHLIST: {
      status: 200,
      body: {
        connected: true,
        bootstrapped: true,
        bootstrapping: false,
        lastBootstrapAt: freshIso,
        watchlist: [
          {
            symbol: "AAPL",
            displayName: "Apple",
            conid: "265598",
            subscribed: true,
            marketState: { ts: freshIso },
            latestCandle1m: { ts: freshIso },
          },
        ],
      },
    },
    SIGNAL_HEALTH: { status: 200, body: { ok: true } },
    SIGNAL_RUNTIME_HEALTH: { status: 200, body: { ok: true } },
    SIGNAL_RUNTIME_READY: {
      status: 200,
      body: { ready: true, checks: { init: { ok: true } } },
    },
    SIGNAL_EXECUTE_READY: {
      status: 200,
      body: {
        ready: true,
        checks: {
          redis: { ok: true },
          postgres: { ok: true },
          paperGuard: { ok: true },
        },
      },
    },
    SIGNAL_LOOP_STATUS: {
      status: 200,
      body: {
        enabled: false,
        running: false,
        startedAt: null,
        lastCycleAt: null,
        nextCycleAt: null,
        activeInstruments: [],
        cycleCount: 0,
        lastOutcomes: {},
      },
    },
    SIGNAL_LOOP_READY: {
      status: 200,
      body: {
        ready: true,
        enabled: false,
        checks: { init: { ok: true } },
      },
    },
    EXECUTION_HEALTH: {
      status: 200,
      body: { ok: true, twsConnected: true },
    },
    EXECUTION_READY: {
      status: 200,
      body: {
        ready: true,
        environment: "paper",
        tradingEnabled: false,
        account: "DU1234567",
        reconciliation: {
          ageSeconds: 5,
          maxAgeSeconds: 300,
          lastRanAt: freshIso,
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
      },
    },
    EXECUTION_KILL_SWITCH: {
      status: 200,
      body: {
        enabled: true,
        triggered: false,
        dailyRealizedPnL: 0,
        baseCurrency: "USD",
        since: freshIso,
        thresholds: { maxDailyLossPct: 5 },
        netLiquidation: 100_000,
        diagnostics: {
          missingFxRates: 0,
          missingCommissionReports: 0,
          complete: true,
          snapshotCacheAgeMs: 1_000,
        },
      },
    },
    RECON_LATEST: {
      status: 200,
      body: {
        accountId: "DU1234567",
        sessionId: "sess-1",
        run: {
          sessionId: "sess-1",
          accountId: "DU1234567",
          completedAt: freshIso,
          status: "CLEAN",
          snapshotComplete: true,
        },
        stale: false,
        maxAgeSeconds: 300,
      },
    },
    RECON_HOLDS_ACTIVE: { status: 200, body: { holds: [] } },
    EXECUTION_ACCOUNT_SUMMARY: {
      status: 200,
      body: { accountId: "DU1234567", netLiquidation: 100_000 },
    },
  };
}

/**
 * The fixture's canonical account ID (embedded in payloads).
 * Exported so harness / tests can assert redaction without
 * hard-coding the literal.
 */
export const FIXTURE_ACCOUNT_ID = "DU1234567";

const SERVICES: readonly EndpointService[] = ["ingestion", "signal", "execution"];

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeQuiet(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

export async function startFixtureStack(
  opts: StartFixtureStackOptions = {},
): Promise<FixtureHandle> {
  const now = opts.now ?? Date.now();
  const payloads = buildPayloads(now);
  const requestLog: FixtureRequest[] = [];

  // Route map is keyed on the FULL canonical path from
  // `ENDPOINTS` — including any query string. A request
  // whose `url` does not match verbatim (missing / changed /
  // reordered / additional query) MUST 404. This prevents
  // silent drift between the tool's allowlist and what the
  // fixture accepts.
  const routesByService = new Map<EndpointService, Map<string, EndpointKey>>();
  for (const svc of SERVICES) routesByService.set(svc, new Map());
  for (const key of Object.keys(ENDPOINTS) as EndpointKey[]) {
    const d = ENDPOINTS[key];
    const map = routesByService.get(d.service);
    if (map) map.set(d.path, key);
  }

  const serversByService = new Map<EndpointService, Server>();
  for (const svc of SERVICES) {
    const routes = routesByService.get(svc);
    const server = createServer((req, res) => {
      const addr = server.address() as AddressInfo | null;
      const port =
        addr && typeof addr === "object" ? addr.port : 0;
      const rawUrl = req.url ?? "";
      const method = req.method ?? "?";
      // Exact-match against the full canonical URL (path +
      // query). No pathname-only fallback.
      const key = routes?.get(rawUrl) ?? null;
      requestLog.push({
        service: svc,
        port,
        method,
        url: rawUrl,
        key,
        at: Date.now(),
      });
      if (method !== "GET" || key === null) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not_found");
        return;
      }
      const payload = payloads[key];
      const body = JSON.stringify(payload.body);
      res.writeHead(payload.status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
      });
      res.end(body);
    });
    serversByService.set(svc, server);
  }

  try {
    await Promise.all(
      [...serversByService.values()].map((s) => listen(s, 0)),
    );
  } catch (err) {
    await Promise.all(
      [...serversByService.values()].map((s) => closeQuiet(s)),
    );
    throw err;
  }

  function urlOf(svc: EndpointService): string {
    const server = serversByService.get(svc);
    if (!server) throw new Error(`fixture-stack: no server for ${svc}`);
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error(`fixture-stack: unresolved address for ${svc}`);
    }
    return `http://127.0.0.1:${addr.port}`;
  }

  const ports: Record<EndpointService, number> = {
    ingestion: (serversByService.get("ingestion")!.address() as AddressInfo).port,
    signal: (serversByService.get("signal")!.address() as AddressInfo).port,
    execution: (serversByService.get("execution")!.address() as AddressInfo).port,
  };

  let shutdownPromise: Promise<void> | null = null;
  async function shutdown(): Promise<void> {
    if (shutdownPromise === null) {
      shutdownPromise = Promise.all(
        [...serversByService.values()].map((s) => closeQuiet(s)),
      ).then(() => undefined);
    }
    return shutdownPromise;
  }
  function isShutdown(): boolean {
    return (
      shutdownPromise !== null &&
      [...serversByService.values()].every((s) => !s.listening)
    );
  }

  return {
    ingestionUrl: urlOf("ingestion"),
    signalUrl: urlOf("signal"),
    executionUrl: urlOf("execution"),
    ports,
    requestLog(): readonly FixtureRequest[] {
      return requestLog;
    },
    clearRequestLog(): void {
      requestLog.length = 0;
    },
    shutdown,
    isShutdown,
  };
}
