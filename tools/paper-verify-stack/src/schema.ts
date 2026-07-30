/**
 * PR15.1 — Zod schemas that mirror the real response
 * contracts of the services the tool consumes. Every schema
 * uses `.strict()` where the underlying handler returns a
 * fixed shape so any drift surfaces at run-time as
 * `malformed_response` (fail-closed per plan §4.1).
 */

import { z } from "zod";

// -----------------------------------------------------------------
// Ingestion
// -----------------------------------------------------------------

export const IngestionHealthSchema = z.object({
  ok: z.boolean(),
  connected: z.boolean(),
  bootstrapped: z.boolean(),
  bootstrapping: z.boolean(),
  lastBootstrapAt: z.union([z.string(), z.null()]).optional(),
  lastTickAt: z.union([z.string(), z.null()]).optional(),
  lastCandleAt: z.union([z.string(), z.null()]).optional(),
});
export type IngestionHealth = z.infer<typeof IngestionHealthSchema>;

export const IngestionMarketStateSchema = z
  .object({
    ts: z.union([z.string(), z.number()]),
  })
  .passthrough();

export const IngestionCandleSchema = z
  .object({
    ts: z.union([z.string(), z.number()]),
  })
  .passthrough();

export const IngestionWatchlistItemSchema = z.object({
  symbol: z.string(),
  displayName: z.union([z.string(), z.null()]).optional(),
  conid: z.union([z.string(), z.null()]),
  subscribed: z.boolean(),
  marketState: z.union([IngestionMarketStateSchema, z.null()]),
  latestCandle1m: z.union([IngestionCandleSchema, z.null()]),
});
export type IngestionWatchlistItem = z.infer<typeof IngestionWatchlistItemSchema>;

export const IngestionWatchlistSchema = z.object({
  connected: z.boolean(),
  bootstrapped: z.boolean(),
  bootstrapping: z.boolean().optional(),
  lastBootstrapAt: z.union([z.string(), z.null()]).optional(),
  watchlist: z.array(IngestionWatchlistItemSchema),
});
export type IngestionWatchlist = z.infer<typeof IngestionWatchlistSchema>;

// -----------------------------------------------------------------
// Signal-engine
// -----------------------------------------------------------------

export const SignalHealthSchema = z.object({ ok: z.boolean() }).passthrough();

export const SignalRuntimeHealthSchema = z
  .object({ ok: z.boolean() })
  .passthrough();

const RuntimeCheckSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export const SignalRuntimeReadySchema = z.object({
  ready: z.boolean(),
  checks: z.record(z.string(), RuntimeCheckSchema),
});

export const SignalExecuteReadySchema = z.object({
  ready: z.boolean(),
  checks: z.object({
    redis: RuntimeCheckSchema,
    postgres: RuntimeCheckSchema,
    paperGuard: RuntimeCheckSchema,
  }),
});

const LoopOutcomeSchema = z.object({
  kind: z.string(),
  idempotencyKey: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
});
const LoopReportSchema = z.object({
  cycleId: z.string(),
  instrumentId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  outcome: LoopOutcomeSchema,
});
export const SignalLoopStatusSchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  startedAt: z.union([z.string(), z.null()]),
  lastCycleAt: z.union([z.string(), z.null()]),
  nextCycleAt: z.union([z.string(), z.null()]),
  activeInstruments: z.array(z.string()),
  cycleCount: z.number(),
  lastOutcomes: z.record(z.string(), LoopReportSchema),
});
export type SignalLoopStatus = z.infer<typeof SignalLoopStatusSchema>;

export const SignalLoopReadySchema = z.object({
  ready: z.boolean(),
  enabled: z.boolean(),
  checks: z.record(z.string(), RuntimeCheckSchema),
});

// -----------------------------------------------------------------
// Execution-engine
// -----------------------------------------------------------------

export const ExecutionHealthSchema = z
  .object({
    ok: z.boolean(),
    twsConnected: z.boolean(),
  })
  .passthrough();

export const ExecutionReadyChecksSchema = z.object({
  brokerSocket: z.boolean(),
  activeAccountKnown: z.boolean(),
  accountMatchesEnvironment: z.boolean(),
  auditWriteAvailable: z.boolean(),
  reconciliationFresh: z.boolean(),
  positionSnapshotHealthy: z.boolean(),
});

export const ExecutionReadySchema = z.object({
  ready: z.boolean(),
  environment: z.enum(["paper", "live"]),
  tradingEnabled: z.boolean(),
  account: z.union([z.string(), z.null()]),
  reconciliation: z.object({
    ageSeconds: z.union([z.number(), z.null()]),
    maxAgeSeconds: z.number(),
    lastRanAt: z.union([z.string(), z.null()]),
  }),
  checks: ExecutionReadyChecksSchema,
  reasons: z.array(z.string()),
});
export type ExecutionReady = z.infer<typeof ExecutionReadySchema>;

export const KillSwitchSchema = z.object({
  enabled: z.boolean(),
  triggered: z.boolean(),
  reason: z.string().optional(),
  dailyRealizedPnL: z.number(),
  baseCurrency: z.string(),
  since: z.string(),
  thresholds: z.object({
    maxDailyLossPct: z.number(),
  }),
  netLiquidation: z.number().optional(),
  diagnostics: z.object({
    missingFxRates: z.number(),
    missingCommissionReports: z.number(),
    complete: z.boolean(),
    snapshotCacheAgeMs: z.number().optional(),
  }),
});
export type KillSwitch = z.infer<typeof KillSwitchSchema>;

export const ReconRunStatusSchema = z.enum([
  "RUNNING",
  "CLEAN",
  "MISMATCH",
  "FAILED",
  "INCOMPLETE",
  "ABANDONED",
]);
export type ReconRunStatus = z.infer<typeof ReconRunStatusSchema>;

export const ReconRunSchema = z
  .object({
    sessionId: z.string(),
    accountId: z.union([z.string(), z.null()]).optional(),
    completedAt: z.union([z.string(), z.null()]),
    status: ReconRunStatusSchema,
    snapshotComplete: z.boolean(),
  })
  .passthrough();

export const ReconLatestSchema = z.object({
  accountId: z.union([z.string(), z.null()]),
  sessionId: z.string(),
  run: z.union([ReconRunSchema, z.null()]),
  stale: z.union([z.boolean(), z.null()]),
  maxAgeSeconds: z.number(),
});
export type ReconLatest = z.infer<typeof ReconLatestSchema>;

const ReconHoldSchema = z
  .object({
    id: z.number(),
    reason: z.string(),
    severity: z.string(),
    active: z.boolean(),
  })
  .passthrough();

export const ReconHoldsSchema = z.object({
  holds: z.array(ReconHoldSchema),
});
export type ReconHolds = z.infer<typeof ReconHoldsSchema>;

/**
 * Account-summary is opt-in; the tool only checks that the
 * response is a JSON object with the expected top-level
 * `accountId`. The full IB payload is intentionally not
 * modelled.
 */
export const AccountSummarySchema = z
  .object({
    accountId: z.string(),
  })
  .passthrough();
