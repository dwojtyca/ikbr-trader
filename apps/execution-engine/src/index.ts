import { readZeroDayRows, evaluateZeroDay } from "./daily-loss-evidence.js";
import { CompletedOrdersClient } from "./reconciliation/completed-orders-client.js";
import { registerGpwRoutes } from "./gpw-routes.js";
import { buildConfiguredInstrumentRegistry } from "@ikbr/shared";
import { WseMetadataClient } from "./wse-metadata-client.js";
import { isWseBound } from "./wse-market-rules.js";
import { shouldInvalidateExecutionFill } from "./execution-fill-invalidation.js";
import { registerFullCloseRoutes } from "./lifecycle/close-routes.js";
import { CloseConflict, CloseRepository } from "./lifecycle/close-repository.js";
import { FullCloseService } from "./lifecycle/close-service.js";
import { evaluateCloseEvidence } from "./lifecycle/close-evidence.js";
import { assessCloseRisk, validatePersistedClosePrepared } from "./lifecycle/close-risk.js";
import type { PreparedBrokerOrder } from "./tws-execution-client.js";
import { registerLifecycleRoutes } from "./lifecycle/routes.js";
import { registerCancelProposedRoute } from "./lifecycle/cancel-route.js";
import Fastify, { type FastifyReply } from "fastify";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { ProposedOrder, ProposedOrderStatus, SignalTicket } from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { config } from "./config.js";
import { buildExecutionInstrumentBindingAuthority } from "./instrument-bindings-config.js";
import {
  DecisionActor,
  ExecutionRepository,
  OrderDecisionMetadata,
  OrderListFilters,
  type PositionGuardContext,
} from "./repository.js";
import { AccountSnapshot, TwsExecutionClient } from "./tws-execution-client.js";
import { AlertService } from "./alerts.js";
import {
  AuthFailureBurstTracker,
  getExecutionAuthContext,
  registerExecutionAuth,
} from "./auth.js";
import {
  EnvironmentGuardConfig,
  EnvironmentGuardError,
  assertActiveAccountAllowed,
  assertEnvironmentAllowsWrite,
  whitelistForEnvironment,
} from "./env-guard.js";
import { isWriteGuardExempt } from "./write-guard-exemptions.js";
import {
  evaluateReadiness,
  type PositionSnapshotHealthInput,
} from "./readiness.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import { planDirectTicketDispatch } from "./direct-ticket-guard.js";
import { ReconciliationRepository } from "./reconciliation/repository.js";
import { ReconciliationRunner, type RunnerContext } from "./reconciliation/runner.js";
import { ReconciliationScheduler } from "./reconciliation/scheduler.js";
import { registerReconciliationRoutes } from "./reconciliation/routes.js";
import { buildReconciliationSubmissionGate } from "./reconciliation/submission-gate.js";
import { assessAiEntryRisk } from "./ai-entry-risk.js";
import { buildSubmissionApplicationService, type SubmissionOutcome } from "./reconciliation/submission-service.js";
import { loadDurableReadiness } from "./reconciliation/durable-readiness.js";
import { IbBrokerReconciliationAdapter } from "./reconciliation/ib-broker-adapter.js";

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
const pool = new Pool({ connectionString: config.POSTGRES_URL });
const repo = new ExecutionRepository(pool, config.gpwWindow, config.aaplWindow);
const alerts = new AlertService(repo, app.log);
const reconRepo = new ReconciliationRepository(pool);
// Per-process identity for the PR13 submission claim. Combines
// the host name (helps operators correlate the claim with a
// machine) with a boot-time random suffix. This is observability
// only — safety comes from the atomic fencing marker
// (`execution_attempted_at` set in the same UPDATE as the claim),
// which permanently prevents a second broker submission for the
// same row regardless of any owner state or wall-clock time.
const EXECUTION_PROCESS_OWNER_ID = `execution-engine:${hostname()}:${randomUUID().slice(0, 8)}`;
// PR15 — sessionStartedAt drives the reconciliation executions
// windowStart baseline. Wall-clock capture at boot; safe to reuse
// for the entire process lifetime.
const EXECUTION_SESSION_STARTED_AT = new Date();
const wseMetadata = new WseMetadataClient({ host: config.IB_SOCKET_HOST,
  port: config.IB_SOCKET_PORT, clientId: config.IB_METADATA_CLIENT_ID });
let lastBrokerFillObservedAt = 0;
const tws = new TwsExecutionClient(
  {
    host: config.IB_SOCKET_HOST,
    port: config.IB_SOCKET_PORT,
    clientId: config.EXECUTION_CLIENT_ID,
    securityType: config.defaultSecurityType,
    exchange: config.IB_EXCHANGE,
    primaryExchange: config.IB_PRIMARY_EXCHANGE,
    currency: config.IB_CURRENCY,
    executionTimeZone: config.EXECUTION_BROKER_TIME_ZONE,
    orderTimeoutMs: config.EXECUTION_ORDER_TIMEOUT_MS,
    submittedAutoCancelMs: config.EXECUTION_SUBMITTED_AUTO_CANCEL_MS,
    retryAsMktOnCode110: config.executionRetryAsMktOnCode110,
    fractionalSymbols: config.fractionalSymbols,
    blockOutsideUsRth: config.blockOutsideUsRth,
    usRthOpenBufferMin: config.EXECUTION_US_RTH_OPEN_BUFFER_MIN,
    usRthCloseBufferMin: config.EXECUTION_US_RTH_CLOSE_BUFFER_MIN,
    contractFallbackByConid: config.contractFallbackByConid,
    environment: config.IBKR_ENVIRONMENT,
    allowDirectTicket: config.allowDirectTicket,
  },
  (line) => app.log.info(line),
  (update) => {
    // Round-8 invariant: any broker-side event that COULD change
    // exposure MUST invalidate the position snapshot BEFORE the
    // local `applyBrokerStatusUpdate` transitions the row to
    // FILLED. Otherwise a concurrent write path could observe
    //   1. our old flat snapshot (complete=true, quantity=0),
    //   2. no active-intent block (row already FILLED),
    // and submit a duplicate entry.
    //
    // Ordering (async but sequential):
    //   a. `invalidatePositionSnapshot(accountId)` — awaited;
    //      sets `broker_snapshot_syncs.complete=false` under the
    //      account lock. Write path fail-closes as `incomplete`
    //      from THIS moment.
    //   b. `applyBrokerStatusUpdate(update)` — awaited; flips
    //      the local row to FILLED (releases active-intent).
    //   c. `refreshBrokerPositionSnapshot(accountId)` — fire-
    //      and-forget; fetches broker state and (via generation
    //      fence) marks `complete=true` if it's still the
    //      newest refresh. Failure leaves `complete=false` and
    //      readiness at 503.
    //
    // For non-FILLED updates the invalidation is skipped (they
    // do not release exposure).
    //
    // Round-9 account identity: `BrokerOrderStatusUpdate` does
    // NOT carry `accountId` (TWS `orderStatus` events are per-
    // orderId, not per-account). We use `lastActiveAccountId`
    // which enforces the SINGLE-ACTIVE-ACCOUNT invariant:
    // execution-engine has exactly one active account at any
    // time (see `ensureBrokerSession` + env-guard whitelist).
    // A reconnect that changes the active account resets this
    // state before any callback can fire, so a stale event from
    // a previous account CANNOT invalidate a different account's
    // snapshot.
    const status = String(update.status ?? "").toUpperCase();
    if (status === "FILLED") lastBrokerFillObservedAt = Date.now();
    void (async () => {
      try {
        if (status === "FILLED" && lastActiveAccountId !== null) {
          const { generation } = await repo.invalidatePositionSnapshot({
            accountId: lastActiveAccountId,
            sessionId: EXECUTION_PROCESS_OWNER_ID,
            observedAt: new Date(),
          });
          markSnapshotInvalidated(lastActiveAccountId, generation);
        }
        await repo.applyBrokerStatusUpdate(update);
        if (status === "FILLED" && lastActiveAccountId !== null) {
          void refreshBrokerPositionSnapshot(lastActiveAccountId).catch(() => {
            /* logged inside refreshBrokerPositionSnapshot */
          });
        }
      } catch (err) {
        app.log.warn(
          { update, err },
          "failed to apply broker order status update",
        );
      }
    })();
    if (
      status === "REJECTED" ||
      status === "INACTIVE" ||
      status === "CANCELLED" ||
      status === "APICANCELLED"
    ) {
      void alerts.record({
        severity:
          status === "REJECTED" || status === "INACTIVE" ? "error" : "warn",
        kind: "order_rejected",
        message: `Broker order ${update.brokerOrderId} reached terminal status ${status}`,
        payload: {
          brokerOrderId: update.brokerOrderId,
          status,
          message: update.message,
        },
      });
    }
    if (status === "FILLED") {
      void (async () => {
        try {
          const order = await repo.getProposedOrderByBrokerOrderId(
            String(update.brokerOrderId),
          );
          const effect = order?.positionEffect ?? "UNKNOWN";
          const action = effect === "CLOSE_OR_REDUCE" ? "EXIT" : "ENTRY";
          const arrow =
            order?.side === "BUY" ? "🟢" : order?.side === "SELL" ? "🔴" : "⚪";
          const msg =
            `${arrow} ${action} FILLED: ${order?.side ?? "?"} ${order?.quantity ?? "?"} ${order?.instrument ?? "?"}` +
            (order?.entry !== undefined ? ` @ ${order.entry}` : "") +
            (order?.strategy ? ` [${order.strategy}]` : "");
          void alerts.record({
            severity: "info",
            kind: "order_filled",
            message: msg,
            payload: {
              brokerOrderId: update.brokerOrderId,
              proposedOrderId: order?.id,
              instrument: order?.instrument,
              side: order?.side,
              positionEffect: effect,
              quantity: order?.quantity,
              entry: order?.entry,
              stop: order?.stop,
              takeProfit: order?.takeProfit,
              strategy: order?.strategy,
            },
          });
        } catch (err) {
          app.log.warn(
            { err, brokerOrderId: update.brokerOrderId },
            "failed to emit order_filled alert",
          );
        }
      })();
    }
  },
  (fill) => {
    lastBrokerFillObservedAt = Date.now();
    // Round-8: partial fills / executionDetails events also
    // change broker-side exposure. Invalidate BEFORE persisting
    // the fill record (so a write path racing this callback can
    // never observe a stale flat snapshot).
    //
    // Round-9 account identity: `fill.accountId` (when provided
    // by executionDetails) is the authoritative source. Fall
    // back to `lastActiveAccountId` only when the fill does NOT
    // carry an account. If the fill DOES carry an account and
    // it does NOT match `lastActiveAccountId`, log and SKIP —
    // an event from a different (or previous) account MUST NOT
    // invalidate the current active account's snapshot.
    void (async () => {
      try {
        const eventAccount = fill.accountId ?? lastActiveAccountId;
        const shouldApply =
          eventAccount !== null && eventAccount === lastActiveAccountId;
        if (!shouldApply && eventAccount !== null) {
          app.log.warn(
            {
              fillAccount: fill.accountId,
              currentActive: lastActiveAccountId,
            },
            "fill callback: account mismatch — skipping snapshot invalidation for the current active account",
          );
        }
        // Historical reqExecutions repeats known fills. Only exact persisted exposure duplicates may keep the generation.
        const invalidatesExposure = shouldApply && await shouldInvalidateExecutionFill(pool, fill).catch(() => true);
        if (invalidatesExposure && lastActiveAccountId !== null) {
          const { generation } = await repo.invalidatePositionSnapshot({
            accountId: lastActiveAccountId,
            sessionId: EXECUTION_PROCESS_OWNER_ID,
            observedAt: new Date(),
          });
          markSnapshotInvalidated(lastActiveAccountId, generation);
        }
        await repo.upsertBrokerExecutionFill(fill);
        if (invalidatesExposure && lastActiveAccountId !== null) {
          void refreshBrokerPositionSnapshot(lastActiveAccountId).catch(() => {
            /* logged inside refreshBrokerPositionSnapshot */
          });
        }
      } catch (err) {
        app.log.warn({ fill, err }, "failed to persist broker execution fill");
      }
    })();
  },
  (report) => {
    void repo.applyBrokerCommissionReport(report).catch((err) => {
      app.log.warn(
        { report, err },
        "failed to persist broker commission report",
      );
    });
  },
  { resolveBoundInstrument: id => instrumentBindingAuthority.getBoundInstrument(id),
    loadWseMetadata: (bound, accountId) => wseMetadata.load(bound, accountId) },
);

// PR15 — production reconciliation wiring. Uses the REAL
// `IbBrokerReconciliationAdapter` backed by the same `tws`
// client the write path uses. Fake adapter is test-only.
const reconBrokerAdapter = new IbBrokerReconciliationAdapter(tws, new CompletedOrdersClient({
  host: config.IB_SOCKET_HOST, port: config.IB_SOCKET_PORT, clientId: config.IB_COMPLETED_ORDERS_CLIENT_ID,
}));
const reconRunner = new ReconciliationRunner(
  pool,
  repo,
  reconRepo,
  reconBrokerAdapter,
  app.log,
  () => ({ approvals: config.EXECUTION_EXTERNAL_ORDERS_JSON, protectedConIds: instrumentBindingAuthority.listBoundInstruments()
    .filter(b => b.instrument.trading.executionEnabled).map(b => String(b.conId)) }),
);
const reconScheduler = new ReconciliationScheduler(
  reconRunner,
  {
    currentContext(): RunnerContext | null {
      if (!lastActiveAccountId) return null;
      return {
        accountId: lastActiveAccountId,
        sessionId: EXECUTION_PROCESS_OWNER_ID,
        sessionStartedAt: EXECUTION_SESSION_STARTED_AT,
      };
    },
  },
  {
    enabled: config.RECONCILIATION_LOOP_ENABLED === "true",
    intervalMs: config.RECONCILIATION_INTERVAL_MS,
    startupDelayMs: config.RECONCILIATION_STARTUP_DELAY_MS,
    minIntervalMs: config.RECONCILIATION_MIN_INTERVAL_MS,
    sourceTimeoutMs: config.RECONCILIATION_SOURCE_TIMEOUT_MS,
    runTimeoutMs: config.RECONCILIATION_RUN_TIMEOUT_MS,
    executionSafetyMarginMs: config.RECONCILIATION_EXECUTION_SAFETY_MARGIN_MS,
  },
  app.log,
);

const ticketSchema = z.object({
  instrument: z.string().min(1),
  conid: z.string().optional(),
  side: z.enum(["BUY", "SELL", "HOLD"]),
  positionEffect: z.enum(["OPEN_OR_ADD", "CLOSE_OR_REDUCE"]).optional(),
  orderType: z.enum(["MKT", "LMT", "STP"]).default("MKT"),
  quantity: z.coerce.number().positive(),
  entry: z.coerce.number().optional(),
  stop: z.coerce.number().optional(),
  takeProfit: z.coerce.number().optional(),
  reason: z.string().default("manual execution ticket"),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
  timestamp: z.string().default(() => new Date().toISOString()),
  riskCheckStatus: z.enum(["PASS", "REJECT"]).default("PASS"),
});

const decisionActorSchema = z.enum(["llm-agent", "user", "user_override"]);
const decisionMetadataSchema = z.object({
  actor: decisionActorSchema.optional(),
  decisionSource: z.enum(["signal", "llm", "user", "user_override"]).optional(),
  aiDecision: z.enum(["EXECUTE", "REJECT"]).optional(),
  aiReason: z.string().optional(),
  aiModel: z.string().optional(),
  aiDecisionConfidence: z.coerce.number().min(0).max(1).optional(),
  llmDecisionId: z.coerce.number().int().positive().optional(),
  sourceError: z.string().optional(),
});

// Round-7 blocker — the wire schema + server-side default for
// `allowCrossContractExposure` live in a separate module so
// schema-only tests can exercise them without booting Fastify.
import {
  executeTicketBodySchema,
  SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE,
  SERVER_ALLOW_MARKET_ORDER,
} from "./execute-ticket-schema.js";

const executeProposedBodySchema = decisionMetadataSchema.extend({
  overrideRejected: z.boolean().optional(),
});

const rejectProposedBodySchema = decisionMetadataSchema.extend({
  reason: z.string().min(1),
  actor: z.enum(["llm-agent", "user"]),
});

let accountSnapshotCache: {
  accountId: string;
  fetchedAtMs: number;
  snapshot: AccountSnapshot;
} | null = null;
let accountSnapshotInFlight: Promise<AccountSnapshot> | null = null;
let executionSyncCache: { accountId: string; syncedAtMs: number } | null = null;
let executionSyncInFlight: Promise<void> | null = null;

// TODO(reconciliation-sot): Target design in ADR-001 makes the reconciliation
// state table the source of truth for the active broker account and the last
// reconciliation timestamp, so both survive restarts and stay consistent
// across multiple execution-engine instances. For Phase 1 we keep them as
// mutable in-process state.
let lastActiveAccountId: string | null = null;
let lastReconciliationAt: Date | null = null;

// -----------------------------------------------------------------------
// PR14 round-7 blocker — broker-driven position snapshot refresher.
//
// The write-path exposure guard reads `broker_position_snapshots` +
// `broker_snapshot_syncs`. A stale flat snapshot could otherwise be
// consulted by an exposure-increasing write AFTER the broker has
// already reported a fill. The refresher:
//
//   1. Serialises per-account so concurrent triggers do not race.
//   2. Uses the two-phase begin/complete pair on the repository —
//      readers see `complete=false` during the refresh window and
//      the guard fail-closes with `POSITION_STATE_UNAVAILABLE
//      (incomplete)`.
//   3. Publishes health to `snapshotHealthByAccount` so `/ready` can
//      surface an in-flight / failed refresh distinctly from
//      "broker socket up but write path fail-closed".
//
// Trigger points wired below:
//   - startup: on first `ensureBrokerSession` success
//   - fill event: after `executePersistedOrder` observes FILLED
//   - `/execution/account/summary`: awaits refresh before responding
//   - dedicated `POST /execution/refresh-position-snapshot`
//
// Reconnect / TWS position-callback push is out of scope for this
// PR (needs additional TWS wiring) — the fill + summary triggers
// provide sufficient coverage for PR14.
// -----------------------------------------------------------------------

type SnapshotHealth =
  | { readonly kind: "never" }
  | { readonly kind: "healthy"; readonly at: Date }
  | { readonly kind: "in_flight"; readonly startedAt: Date }
  | {
      readonly kind: "failed";
      readonly at: Date;
      readonly error: string;
    };
const snapshotHealthByAccount = new Map<string, SnapshotHealth>();

/**
 * PR14 round-9 blocker — generation-aware refresh coordinator.
 * See `refresh-coordinator.ts` for the full contract; the
 * inline coordinator was replaced with the extracted class so
 * `refresh-coordinator.test.ts` can exercise the
 * invalidate-during-refresh race deterministically.
 */
const refreshCoordinator = new RefreshCoordinator({
  sessionId: EXECUTION_PROCESS_OWNER_ID,
  now: () => new Date(),
  log: {
    info: (obj, msg) => app.log.info(obj, msg),
    warn: (obj, msg) => app.log.warn(obj, msg),
    error: (obj, msg) => app.log.error(obj, msg),
  },
  beginRefresh: (input) => repo.beginPositionSnapshotRefresh(input),
  fetchBrokerSnapshot: (accountId) => tws.getAccountSnapshot(accountId),
  completeRefresh: (input) => repo.completePositionSnapshotRefresh(input),
  getStatus: (accountId) => repo.getPositionSnapshotStatus(accountId),
});

/**
 * Round-8 helper — mark the local health tracker as
 * `in_flight` immediately after `invalidatePositionSnapshot`
 * committed. Ensures `/ready` observes the fail-closed window
 * even if the follow-up refresh has not yet started (or the
 * process crashes between).
 */
function markSnapshotInvalidated(accountId: string, generation: number): void {
  refreshCoordinator.markInvalidated(accountId, generation);
  const current = snapshotHealthByAccount.get(accountId);
  if (current?.kind === "in_flight") return;
  snapshotHealthByAccount.set(accountId, {
    kind: "in_flight",
    startedAt: new Date(),
  });
}

async function refreshBrokerPositionSnapshot(accountId: string): Promise<void> {
  await refreshCoordinator.refresh(accountId);
  // Reflect the coordinator's final health into the local map
  // consumed by `/ready` and by `/execution/account/summary`.
  snapshotHealthByAccount.set(accountId, refreshCoordinator.health(accountId));
}

function toReadinessSnapshotHealth(
  h: SnapshotHealth | undefined,
): PositionSnapshotHealthInput | undefined {
  if (h === undefined) return { kind: "never" };
  switch (h.kind) {
    case "never":
      return { kind: "never" };
    case "healthy":
      return { kind: "healthy" };
    case "in_flight":
      return { kind: "in_flight" };
    case "failed":
      return { kind: "failed", error: h.error };
  }
}

function envGuardConfig(): EnvironmentGuardConfig {
  return {
    environment: config.IBKR_ENVIRONMENT,
    tradingEnabled: config.tradingEnabled,
    allowedPaperAccounts: config.allowedPaperAccounts,
    allowedLiveAccounts: config.allowedLiveAccounts,
  };
}

const READY_AUDIT_CACHE_TTL_MS = 7_000;
let auditWriteHealthCache: { ok: boolean; checkedAtMs: number } | null = null;

async function probeAuditWriteAvailable(): Promise<boolean> {
  const now = Date.now();
  if (
    auditWriteHealthCache &&
    now - auditWriteHealthCache.checkedAtMs < READY_AUDIT_CACHE_TTL_MS
  ) {
    return auditWriteHealthCache.ok;
  }
  let ok = false;
  try {
    await pool.query("SELECT 1");
    ok = true;
  } catch (err) {
    app.log.warn({ err }, "audit write health probe failed");
  }
  auditWriteHealthCache = { ok, checkedAtMs: now };
  return ok;
}

async function syncRecentExecutions(accountId: string): Promise<void> {
  if (
    executionSyncCache &&
    executionSyncCache.accountId === accountId &&
    Date.now() - executionSyncCache.syncedAtMs < 5 * 60_000
  ) {
    return;
  }

  if (executionSyncInFlight) {
    await executionSyncInFlight;
    return;
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  executionSyncInFlight = (async () => {
    const count = await tws.syncExecutions(accountId, since);
    executionSyncCache = {
      accountId,
      syncedAtMs: Date.now(),
    };
    app.log.info(
      { accountId, count, since: since.toISOString() },
      "synced recent broker executions",
    );
  })();

  try {
    await executionSyncInFlight;
  } finally {
    executionSyncInFlight = null;
  }
}

function validateExecutableTicket(ticket: SignalTicket): string | null {
  if (ticket.riskCheckStatus !== "PASS") {
    return "riskCheckStatus must be PASS for execution";
  }

  if (ticket.side !== "BUY" && ticket.side !== "SELL") {
    return `unsupported side for execution: ${ticket.side}`;
  }

  if (!(ticket.quantity > 0)) {
    return "quantity must be greater than 0";
  }

  if (
    ticket.orderType === "LMT" &&
    (ticket.entry === undefined || !Number.isFinite(ticket.entry))
  ) {
    return "LMT order requires entry price";
  }

  return null;
}

function normalizeDecisionMetadata(
  raw: z.infer<typeof decisionMetadataSchema> | undefined,
  fallbackActor: DecisionActor,
): OrderDecisionMetadata {
  const actor = (raw?.actor as DecisionActor | undefined) ?? fallbackActor;

  const defaultDecisionSource =
    actor === "llm-agent"
      ? "llm"
      : actor === "user_override"
        ? "user_override"
        : "user";

  const out: OrderDecisionMetadata = {
    decisionActor: actor,
    decisionSource: raw?.decisionSource ?? defaultDecisionSource,
    aiDecision: raw?.aiDecision,
    aiReason: raw?.aiReason,
    aiModel: raw?.aiModel,
    aiDecisionConfidence: raw?.aiDecisionConfidence,
    llmDecisionId: raw?.llmDecisionId,
    sourceError: raw?.sourceError,
  };

  if (actor === "llm-agent" && !out.aiDecision) {
    out.aiDecision = "EXECUTE";
  }

  return out;
}

function buildSubmittedConflictMessage(
  symbol: string,
  existing: { id: number; brokerOrderId?: string; createdAt: Date },
): string {
  return `Execution blocked for ${symbol}: active SUBMITTED order already exists (id=${existing.id}, brokerOrderId=${existing.brokerOrderId ?? "n/a"}, createdAt=${existing.createdAt.toISOString()})`;
}

/**
 * Detect a Postgres unique-constraint violation. Matches by SQLSTATE
 * `23505`; the `pg` driver exposes it on the error's `code` property.
 * Used by /execution/execute-ticket to resolve the race between the
 * up-front duplicate check and the INSERT statement.
 */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "23505";
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
}

interface KillSwitchStatus {
  enabled: boolean;
  triggered: boolean;
  reason?: string;
  dailyRealizedPnL: number;
  baseCurrency: string;
  since: string;
  thresholds: {
    maxDailyLossPct: number;
  };
  netLiquidation?: number;
  diagnostics: {
    missingFxRates: number;
    missingCommissionReports: number;
    complete: boolean;
    snapshotCacheAgeMs?: number;
    zeroDayEvidence?: { ok: boolean; reason: string; runId?: number };
  };
}

/**
 * Evaluates daily loss using cached account data and broker_execution_fills.
 * The empty-day path may refresh readonly reconciliation once after a position
 * refresh invalidates its generation; it never refreshes the account in a loop.
 * Reads fills
 * persisted by the execution-engine. Returns a structured status so the
 * same code path can answer GET /execution/kill-switch and gate
 * /execution/execute-* endpoints.
 *
 * Conservative behaviour:
 *   - if both USD and PCT thresholds are 0 -> disabled
 *   - if PCT threshold is set but no netLiquidation is known yet -> skip
 *     the PCT bound (USD bound still applies)
 *   - FX rates come from the last cached account snapshot; rows in a
 *     currency we cannot convert are skipped and flagged in diagnostics
 */
async function evaluateKillSwitch(): Promise<KillSwitchStatus> {
  const since = startOfTodayUtc();
  const fxToBaseByCurrency = accountSnapshotCache?.snapshot.fxToBaseByCurrency;
  const netLiquidation = accountSnapshotCache?.snapshot.metrics.netLiquidation;
  const snapshotCacheAgeMs = accountSnapshotCache
    ? Date.now() - accountSnapshotCache.fetchedAtMs
    : undefined;

  const summary = await repo.getRealizedPnLSince({
    baseCurrency: config.IB_CURRENCY,
    since,
    fxToBaseByCurrency,
  });

  let zeroDayEvidence: { ok: boolean; reason: string; runId?: number } | undefined;
  if (!summary.complete && summary.pnl === 0 && summary.missingCommissionReports === 0 && summary.missingFxRates === 0 && lastActiveAccountId && tws.isConnected()) {
    zeroDayEvidence = await evaluateZeroDay({
      read: (accountId, dayStart) => readZeroDayRows(pool, accountId, dayStart),
      refresh: async () => (await reconScheduler.triggerNow()) !== null,
      context: () => !lastActiveAccountId || !tws.isConnected() ? null : ({
        accountId: lastActiveAccountId, sessionId: EXECUTION_PROCESS_OWNER_ID,
        connectionGeneration: tws.getConnectionGeneration(), now: Date.now(), lastBrokerFillObservedAt,
        accountSnapshot: accountSnapshotCache?.snapshot ?? null,
      }),
    });
  }
  const enabled = config.EXECUTION_MAX_DAILY_LOSS_PCT > 0;

  const status: KillSwitchStatus = {
    enabled,
    triggered: false,
    dailyRealizedPnL: summary.pnl,
    baseCurrency: config.IB_CURRENCY,
    since: since.toISOString(),
    thresholds: {
      maxDailyLossPct: config.EXECUTION_MAX_DAILY_LOSS_PCT,
    },
    netLiquidation,
    diagnostics: {
      missingFxRates: summary.missingFxRates,
      missingCommissionReports: summary.missingCommissionReports,
      complete: summary.complete || zeroDayEvidence?.ok === true,
      zeroDayEvidence,
      snapshotCacheAgeMs,
    },
  };

  if (!enabled) {
    return status;
  }

  if (netLiquidation === undefined || netLiquidation <= 0) {
    // PCT bound cannot be evaluated without a positive netLiquidation
    // snapshot. Fail-open here (do not block) but flag in diagnostics by
    // leaving triggered=false; operators can monitor via the status
    // endpoint and force a snapshot refresh.
    return status;
  }

  const lossPct = (-summary.pnl / netLiquidation) * 100;
  if (lossPct >= config.EXECUTION_MAX_DAILY_LOSS_PCT) {
    status.triggered = true;
    status.reason = `daily realized PnL ${summary.pnl.toFixed(2)} ${config.IB_CURRENCY} = -${lossPct.toFixed(2)}% of netLiquidation (${netLiquidation.toFixed(2)}) >= ${config.EXECUTION_MAX_DAILY_LOSS_PCT}%`;
  }

  return status;
}

/**
 * Throws when the kill-switch is triggered and the order would open or
 * add to a position. CLOSE_OR_REDUCE orders always pass so the bot can
 * exit existing positions even after the daily loss limit was hit.
 */
async function assertKillSwitchOk(order: {
  positionEffect?: ProposedOrder["positionEffect"];
  instrument: string;
}): Promise<void> {
  const positionEffect = order.positionEffect ?? "OPEN_OR_ADD";
  if (positionEffect === "CLOSE_OR_REDUCE") return;

  const status = await evaluateKillSwitch();
  if (status.triggered) {
    app.log.warn(
      { instrument: order.instrument, status },
      "kill-switch blocked OPEN_OR_ADD order",
    );
    void alerts.record({
      severity: "error",
      kind: "kill_switch_triggered",
      message: `Kill-switch blocked OPEN_OR_ADD for ${order.instrument}: ${status.reason ?? "triggered"}`,
      payload: { instrument: order.instrument, status },
    });
    throw new Error(
      `Execution blocked for ${order.instrument}: daily loss kill-switch triggered (${status.reason}). Existing positions can still be closed.`,
    );
  }
}

export interface ReconciliationMismatch {
  symbol: string;
  expectedNetShares: number;
  brokerNetShares: number;
  difference: number;
  brokerAveragePrice?: number;
  brokerMarketValue?: number;
}

export interface ReconciliationReport {
  ranAt: string;
  accountId: string;
  expectedPositionsCount: number;
  brokerPositionsCount: number;
  matches: number;
  mismatches: ReconciliationMismatch[];
}

/**
 * Compares the per-symbol net position implied by our persisted broker
 * fills with what TWS reports via reqPositions. Any difference is
 * logged, recorded in system_alerts, and returned in the report. We do
 * not auto-resolve mismatches: those require operator review (the local
 * DB could be stale after a crash, or manual orders in TWS could exist).
 *
 * PR15 — the in-memory implementation was replaced by the
 * authoritative durable runner (`./reconciliation/runner.ts` +
 * scheduler). This function is a compatibility shim that
 * delegates to `reconScheduler.triggerNow()` and rebuilds the
 * legacy `ReconciliationReport` shape for the two remaining
 * call sites (`POST /execution/reconciliation` and the startup
 * fire-and-forget). New callers should use the scheduler / new
 * routes directly.
 */
async function runReconciliation(): Promise<ReconciliationReport> {
  const accountIdBefore = lastActiveAccountId;
  if (!accountIdBefore) {
    // Attempt to hydrate an active account so the scheduler has a
    // context to run under. Mirrors the pre-PR15 behaviour of
    // the legacy runner.
    try {
      await ensureBrokerSession();
    } catch {
      /* leave lastActiveAccountId null — scheduler will skip */
    }
  }
  const report = await reconScheduler.triggerNow();
  lastReconciliationAt = new Date();
  return {
    ranAt: lastReconciliationAt.toISOString(),
    accountId: lastActiveAccountId ?? "",
    expectedPositionsCount: 0,
    brokerPositionsCount: 0,
    matches: report?.matches ?? 0,
    mismatches: [],
  };
}

async function ensureBrokerSession(): Promise<{
  accountId: string;
  accounts: string[];
}> {
  await tws.connect();
  const accounts = await tws.getManagedAccounts();

  const accountId = config.IBKR_ACCOUNT_ID ?? accounts[0];
  if (!accountId) {
    throw new Error(
      "No account available from TWS managed accounts for execution",
    );
  }

  if (config.IBKR_ACCOUNT_ID && !accounts.includes(config.IBKR_ACCOUNT_ID)) {
    throw new Error(
      `Configured IBKR_ACCOUNT_ID=${config.IBKR_ACCOUNT_ID} is not in managed accounts`,
    );
  }

  // Paper/Live environment guard on the resolved broker account. On
  // failure we emit a CRITICAL SAFETY alert (bypasses ALERT_MIN_SEVERITY)
  // and throw an EnvironmentGuardError that the Fastify error handler
  // translates into HTTP 423 Locked.
  const whitelist = whitelistForEnvironment(envGuardConfig());
  if (!whitelist.includes(accountId)) {
    const reason =
      config.IBKR_ENVIRONMENT === "live"
        ? "account_not_allowed_for_live"
        : "account_not_allowed_for_paper";
    const message = `SAFETY:ACCOUNT_ENVIRONMENT_MISMATCH — broker account ${accountId} is not in ALLOWED_${config.IBKR_ENVIRONMENT.toUpperCase()}_ACCOUNTS`;
    void alerts.record({
      severity: "CRITICAL",
      kind: "safety_account_environment_mismatch",
      message,
      payload: {
        accountId,
        environment: config.IBKR_ENVIRONMENT,
        whitelist: [...whitelist],
        managedAccounts: accounts,
      },
    });
    // Do NOT cache mismatched accountId. Force operators to fix config
    // before any state is retained.
    lastActiveAccountId = null;
    throw new EnvironmentGuardError(reason, message);
  }

  lastActiveAccountId = accountId;
  // Round-7 blocker: kick off (or coalesce onto) a broker-driven
  // snapshot refresh whenever we (re-)confirm the active account.
  // Ensures the write-path guard has a fresh snapshot at startup
  // AND after any reconnect that goes through ensureBrokerSession.
  // Fire-and-forget — the refresher is serialised per-account and
  // publishes health for `/ready`.
  void refreshBrokerPositionSnapshot(accountId).catch(() => {
    /* logged inside refreshBrokerPositionSnapshot */
  });
  return { accountId, accounts };
}

/**
 * PR15.2 — server-side authority for logical `instrumentId` →
 * exact broker contract binding. Built ONCE at module load from
 * `INSTRUMENT_BINDINGS_JSON`; malformed input throws here so
 * the process refuses to serve traffic. Execution-engine
 * deliberately constructs its OWN authority — never trusts one
 * propagated by signal-engine.
 *
 * The raw configuration value is NEVER logged; only bound
 * counts / ids appear in the boot log.
 */
const instrumentBindingAuthority = buildExecutionInstrumentBindingAuthority(
  config.INSTRUMENT_BINDINGS_JSON,
  buildConfiguredInstrumentRegistry(process.env),
);
app.get('/execution/aapl-window', async () => repo.getAaplWindowStatus(lastActiveAccountId));
registerGpwRoutes(app, {
  currentAccountId: () => lastActiveAccountId,
  boundInstrument: id => instrumentBindingAuthority.getBoundInstrument(id),
  assertAccountAllowed: accountId => assertActiveAccountAllowed(envGuardConfig(), accountId, {requireKnownAccount:true}),
  loadMetadata: (bound,accountId) => wseMetadata.load(bound,accountId),
  windowStatus: accountId => repo.getGpwWindowStatus(accountId),
});
app.log.info(
  {
    component: "instrument-bindings",
    boundCount: instrumentBindingAuthority.toDiagnostics().boundCount,
    ids: instrumentBindingAuthority.toDiagnostics().ids,
  },
  "instrument bindings loaded",
);

/**
 * PR15 r7 §1 — single production submission service instance.
 * BOTH `/execution/execute-ticket` and
 * `/execution/execute-proposed/:id` delegate to this instance.
 * Tests use the SAME module by construction; only the injected
 * `BrokerOrderDispatcher` is fake in tests.
 */
const submissionService = buildSubmissionApplicationService({
  repo,
  assessAiRisk: async (order, bound, accountId, sessionId) => {
    const [snapshot, response, metadata] = await Promise.all([
      tws.getAccountSnapshot(accountId),
      fetch(`${config.EXECUTION_INGESTION_BASE_URL.replace(/\/$/, "")}/watchlist`,
        { signal: AbortSignal.timeout(5000) }),
      isWseBound(bound) ? wseMetadata.load(bound, accountId) : Promise.resolve(undefined),
    ]);
    if (!response.ok) return { ok: false, reason: "ingestion_unavailable" };
    return assessAiEntryRisk({ order, bound, accountId, sessionId, snapshot, wseMetadata: metadata,
      watchlist: await response.json(), nowMs: Date.now(), limits: {
        maxNotionalPct: config.EXECUTION_AI_MAX_NOTIONAL_PCT,
        maxStopRiskPct: config.EXECUTION_AI_MAX_STOP_RISK_PCT,
        maxExposurePct: config.EXECUTION_AI_MAX_EXPOSURE_PCT,
        aaplUsd: {
          maxNotional: config.EXECUTION_AI_AAPL_MAX_NOTIONAL_USD,
          maxStopRisk: config.EXECUTION_AI_AAPL_MAX_STOP_RISK_USD,
          feeReserve: config.EXECUTION_AI_AAPL_FEE_RESERVE_USD,
        },
        pln: {
          maxNotional: config.EXECUTION_AI_MAX_NOTIONAL_PLN,
          maxStopRisk: config.EXECUTION_AI_MAX_STOP_RISK_PLN,
          feeReserve: config.EXECUTION_AI_FEE_RESERVE_PLN,
        },
      } });
  },
  ensureBrokerSession: async () => {
    const { accountId } = await ensureBrokerSession();
    return { accountId };
  },
  buildPositionGuard: () =>
    lastActiveAccountId !== null
      ? {
          kind: "available",
          accountId: lastActiveAccountId,
          sessionId: EXECUTION_PROCESS_OWNER_ID,
          maxSnapshotAgeMs:
            config.EXECUTION_POSITION_GUARD_MAX_AGE_S * 1000,
        }
      : { kind: "unavailable", reason: "no_active_account" },
  reconciliationGate: () =>
    buildReconciliationSubmissionGate({
      maxAgeSeconds: config.EXECUTION_READY_RECONCILIATION_MAX_AGE_S,
    }),
  prepareBrokerPlan: async ({ order, accountId, clientOrderId }) =>
    tws.prepareBrokerOrderPlan(order, accountId, config.EXECUTION_DEFAULT_TIF, {
      proposedOrderId: order.id ?? null,
      clientOrderId,
    }),
  dispatcher: {
    dispatch: async ({ prepared, windowDeadlineMs }) => tws.dispatchPreparedOrder(prepared, windowDeadlineMs),
  },
  assertKillSwitchOk: async (input) => {
    await assertKillSwitchOk({
      instrument: input.instrument,
      positionEffect:
        (input.positionEffect ?? undefined) as
          | "OPEN_OR_ADD"
          | "CLOSE_OR_REDUCE"
          | undefined,
    });
  },
  recordAlert: async (input) => {
    await alerts.record(input);
  },
  triggerReconciliation: () => reconScheduler.triggerNow(),
  ownerId: EXECUTION_PROCESS_OWNER_ID,
  allowMarketOrder: SERVER_ALLOW_MARKET_ORDER,
  allowCrossContractExposure: SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE,
  bindingAuthority: instrumentBindingAuthority,
  defaultTif: config.EXECUTION_DEFAULT_TIF,
  onSnapshotInvalidated: markSnapshotInvalidated,
  refreshBrokerSnapshot: refreshBrokerPositionSnapshot,
});

app.get("/health", async () => ({ ok: true, twsConnected: tws.isConnected() }));

/**
 * PR15 r7 §6 — SubmissionOutcome → HTTP mapper. The ONLY place
 * transport concerns live. Every route that dispatches through
 * `submissionService` funnels its outcome here.
 */
function sendSubmissionOutcome(
  reply: FastifyReply,
  outcome: SubmissionOutcome,
  instrument: string,
): FastifyReply | Record<string, unknown> {
  switch (outcome.kind) {
    case "awaiting_ai":
      return reply.code(200).send({ outcome: "AWAITING_AI", order: outcome.order });
    case "ai_review_required":
      return reply.code(409).send({ outcome: "AI_REVIEW_REQUIRED", reason: outcome.reason });
    case "risk_rejected":
      return reply.code(409).send({ outcome: "RISK_REJECTED", reason: outcome.reason });
    case "submitted":
      return reply.code(200).send({
        outcome: "SUBMITTED",
        order: outcome.order,
        execution: outcome.execution,
      });
    case "resumed":
      return reply.code(200).send({
        outcome: "RESUMED",
        order: outcome.order,
        execution: outcome.execution,
        resumed: true,
      });
    case "duplicate_submitted":
      return reply.code(200).send({
        outcome: "DUPLICATE_SUBMITTED",
        duplicate: true,
        order: outcome.order,
      });
    case "duplicate_terminal":
      return reply.code(200).send({
        outcome: "DUPLICATE_TERMINAL",
        duplicate: true,
        order: outcome.order,
      });
    case "duplicate_pending_ambiguous":
      return reply.code(200).send({
        outcome: "DUPLICATE_PENDING_AMBIGUOUS",
        duplicate: true,
        order: outcome.order,
      });
    case "pending_claimed":
      return reply.code(200).send({
        outcome: "PENDING_CLAIMED",
        duplicate: true,
        order: outcome.order,
      });
    case "conflict":
      return reply.code(409).send({
        outcome: "CONFLICT",
        error: "idempotency_conflict",
        message:
          outcome.order === null
            ? "clientOrderId conflict"
            : "clientOrderId already exists with a different clientOrderHash",
        ...(outcome.order ? { order: outcome.order } : {}),
      });
    case "active_intent_exists":
      return reply.code(409).send({
        outcome: "ACTIVE_INTENT_EXISTS",
        error: "active_intent_exists",
        message: `instrument ${instrument} already has a non-terminal proposed order (id=${outcome.existingOrderId}, status=${outcome.existingStatus})`,
        existingOrderId: outcome.existingOrderId,
        existingStatus: outcome.existingStatus,
        existingClientOrderId: outcome.existingClientOrderId,
      });
    case "open_position_exists":
      return reply.code(409).send({
        outcome: "OPEN_POSITION_EXISTS",
        error: "open_position_exists",
        message: `instrument ${instrument} has an open broker position (accountId=${outcome.accountId}, quantity=${outcome.quantity})`,
        accountId: outcome.accountId,
        quantity: outcome.quantity,
        observedAt: outcome.observedAt.toISOString(),
      });
    case "position_state_unavailable":
      return reply.code(503).send({
        outcome: "POSITION_STATE_UNAVAILABLE",
        error: "position_state_unavailable",
        message: `broker position snapshot ${outcome.reason} for ${outcome.accountId}`,
        accountId: outcome.accountId,
        reason: outcome.reason,
      });
    case "reconciliation_unavailable":
      return reply.code(503).send({
        outcome: "RECONCILIATION_UNAVAILABLE",
        error: "reconciliation_unavailable",
        reason: outcome.reason,
      });
    case "reconciliation_stale":
      return reply.code(503).send({
        outcome: "RECONCILIATION_STALE",
        error: "reconciliation_stale",
        ageSeconds: outcome.ageSeconds,
      });
    case "reconciliation_hold":
      return reply.code(503).send({
        outcome: "RECONCILIATION_HOLD",
        error: "reconciliation_hold",
        hold: {
          id: outcome.holdId,
          reason: outcome.reason,
          severity: outcome.severity,
        },
      });
    case "submission_identity_mismatch":
      return reply.code(409).send({
        outcome: "SUBMISSION_IDENTITY_MISMATCH",
        error: "submission_identity_mismatch",
        reason: outcome.reason,
      });
    case "invalid_plan":
      return reply.code(500).send({
        outcome: "INVALID_PLAN",
        error: "invalid_plan",
        reason: outcome.reason,
      });
    case "plan_collision":
      return reply.code(500).send({
        outcome: "PLAN_COLLISION",
        error: "plan_collision",
        collidedRefs: outcome.collidedRefs,
      });
    case "client_order_hash_mismatch":
      return reply.code(409).send({
        outcome: "CLIENT_ORDER_HASH_MISMATCH",
        error: "CLIENT_ORDER_HASH_MISMATCH",
      });
    case "market_order_not_allowed":
      return reply.code(400).send({
        outcome: "MARKET_ORDER_NOT_ALLOWED",
        error: "market_order_not_allowed",
      });
    case "idempotency_identity_missing":
      return reply.code(400).send({
        outcome: "IDEMPOTENCY_IDENTITY_MISSING",
        error: "idempotency_identity_missing",
      });
    case "legacy_idempotency_identity_missing":
      return reply.code(409).send({
        outcome: "LEGACY_IDEMPOTENCY_IDENTITY_MISSING",
        error: "LEGACY_IDEMPOTENCY_IDENTITY_MISSING",
        proposedOrderId: outcome.proposedOrderId,
      });
    case "instrument_binding_unavailable":
      // PR15.2 — payload missing `instrumentId`, or referencing an
      // id that is not configured in the server-side
      // `INSTRUMENT_BINDINGS_JSON`. 400 (client fault) because
      // retrying with the same payload will keep failing.
      return reply.code(400).send({
        outcome: "INSTRUMENT_BINDING_UNAVAILABLE",
        error: "INSTRUMENT_BINDING_UNAVAILABLE",
        reason: outcome.reason,
      });
    case "instrument_execution_disabled":
      // PR15.2 — server-side registry has
      // `trading.executionEnabled=false` for the resolved binding.
      // 423 mirrors the environment-guard semantics: state issue,
      // not a client shape issue.
      return reply.code(423).send({
        outcome: "INSTRUMENT_EXECUTION_DISABLED",
        error: "INSTRUMENT_EXECUTION_DISABLED",
        instrumentId: outcome.instrumentId,
      });
    case "binding_identity_mismatch":
      // PR15.2 — payload symbol/conId does not match the server-
      // resolved binding, OR the resume path finds a stored
      // `instrument_id` that does not match the payload claim.
      return reply.code(409).send({
        outcome: "BINDING_IDENTITY_MISMATCH",
        error: "BINDING_IDENTITY_MISMATCH",
        reason: outcome.reason,
      });
    case "instrument_policy_unavailable":
      // PR15.2 hostile-review fix — trusted registry has no
      // `executionPolicy` for the bound instrument. 423 (locked,
      // state-shaped) mirrors env-guard / kill-switch semantics:
      // the operator must fix the registry, not retry the
      // request.
      return reply.code(423).send({
        outcome: "INSTRUMENT_POLICY_UNAVAILABLE",
        error: "INSTRUMENT_POLICY_UNAVAILABLE",
        instrumentId: outcome.instrumentId,
      });
    case "order_type_not_allowed_by_instrument_policy":
      // PR15.2 hostile-review fix — payload orderType not in
      // the trusted policy's allow-list. 400 (client fault) —
      // retrying with the same payload will keep failing until
      // the caller aligns with the registry.
      return reply.code(400).send({
        outcome: "ORDER_TYPE_NOT_ALLOWED_BY_INSTRUMENT_POLICY",
        error: "ORDER_TYPE_NOT_ALLOWED_BY_INSTRUMENT_POLICY",
        instrumentId: outcome.instrumentId,
        orderType: outcome.orderType,
        allowedOrderTypes: outcome.allowedOrderTypes,
      });
    case "instrument_tick_mismatch":
      // PR15.2 hostile-review fix — trusted policy tick does
      // not agree with the operator-verified `bound.minTick`.
      // 423 (locked, state-shaped) — the operator has to fix
      // either the seed policy or the binding.
      return reply.code(423).send({
        outcome: "INSTRUMENT_TICK_MISMATCH",
        error: "INSTRUMENT_TICK_MISMATCH",
        instrumentId: outcome.instrumentId,
        policyTick: outcome.policyTick,
        boundTick: outcome.boundTick,
      });
    case "rejected_order_immutable":
      return reply.code(409).send({
        outcome: "REJECTED_ORDER_IMMUTABLE",
        error: "REJECTED_ORDER_IMMUTABLE",
        proposedOrderId: outcome.proposedOrderId,
      });
    case "kill_switch_triggered":
      return reply.code(423).send({ error: outcome.message });
    case "not_found":
      return reply.code(404).send({ error: "not_found" });
    case "execution_error":
      return reply.code(400).send({
        outcome: "EXECUTION_ERROR",
        error: outcome.message,
        order: outcome.order,
        ...(outcome.resumed ? { resumed: true } : {}),
      });
  }
}

app.get("/ready", async (request, reply) => {
  const auditWriteAvailable = await probeAuditWriteAvailable();

  const guardCfg = envGuardConfig();
  const whitelist = whitelistForEnvironment(guardCfg);
  const accountAllowed =
    lastActiveAccountId !== null && whitelist.includes(lastActiveAccountId);

  const durable = await loadDurableReadiness({
    repository: reconRepo, sessionId: EXECUTION_PROCESS_OWNER_ID, now: () => new Date(),
    current: () => ({ accountId: lastActiveAccountId, generation: tws.getConnectionGeneration(), connected: tws.isConnected() }),
  });

  const result = evaluateReadiness({
    now: new Date(),
    environment: config.IBKR_ENVIRONMENT,
    tradingEnabled: config.tradingEnabled,
    brokerSocketUp: tws.isConnected(),
    activeAccountId: lastActiveAccountId,
    accountAllowedByEnvironment: accountAllowed,
    auditWriteAvailable,
    lastReconciliationAt: durable.lastReconciliationAt,
    reconciliationMaxAgeSeconds:
      config.EXECUTION_READY_RECONCILIATION_MAX_AGE_S,
    // Round-7 blocker: surface broker-driven snapshot refresher
    // health so a stale / in-flight / failed refresh flips
    // `/ready` to 503. The write path is fail-closed either way,
    // but operators must see the difference between "broker
    // socket up but write path fail-closed" and "everything OK".
    positionSnapshotHealth:
      lastActiveAccountId !== null
        ? toReadinessSnapshotHealth(
            snapshotHealthByAccount.get(lastActiveAccountId),
          )
        : undefined,
    reconciliationRunHealth: durable.reconciliationRunHealth,
  });

  return reply.code(result.statusCode).send(result.body);
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof EnvironmentGuardError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      reason: error.reason,
    });
  }
  reply.send(error);
});

app.get("/execution/kill-switch", async () => {
  return evaluateKillSwitch();
});

app.post("/execution/reconciliation", async (_request, _reply) => {
  // PR15 — legacy compat alias. Delegates to the new
  // authoritative runner via the scheduler. Retained ONLY so
  // pre-PR15 operator scripts keep working; new callers should
  // use `POST /execution/reconciliation/run`.
  const report = await reconScheduler.triggerNow();
  return { report };
});

app.get("/execution/alerts", async (request) => {
  const query = z
    .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
    .parse(request.query ?? {});
  const rows = await repo.listSystemAlerts(query.limit);
  return { alerts: rows };
});

app.post("/execution/alerts/test", async (request) => {
  const body = z
    .object({
      severity: z.enum(["info", "warn", "error", "CRITICAL"]).default("warn"),
      message: z.string().default("Test alert from /execution/alerts/test"),
    })
    .parse(request.body ?? {});
  await alerts.record({
    severity: body.severity,
    kind: "system",
    message: body.message,
    payload: { triggeredAt: new Date().toISOString() },
  });
  return { ok: true };
});

app.post("/execution/bootstrap", async () => {
  const { accountId, accounts } = await ensureBrokerSession();
  return {
    socket: {
      host: config.IB_SOCKET_HOST,
      port: config.IB_SOCKET_PORT,
      clientId: config.EXECUTION_CLIENT_ID,
    },
    accountId,
    accounts,
  };
});

// Round-7 blocker: explicit trigger for the broker-driven
// position snapshot refresh. Used by operators (post-manual-
// trade / after external reconciliation) and by internal
// callers that observed a broker-side change outside the fill
// event path. Coalesced per-account; response reflects the
// outcome of the (possibly in-flight) refresh.
app.post("/execution/refresh-position-snapshot", async (_request, reply) => {
  const { accountId } = await ensureBrokerSession();
  await refreshBrokerPositionSnapshot(accountId);
  const health = snapshotHealthByAccount.get(accountId);
  if (!health || health.kind === "healthy") {
    return { accountId, status: health?.kind ?? "never" };
  }
  return reply.code(503).send({
    accountId,
    status: health.kind,
    ...(health.kind === "failed" ? { error: health.error } : {}),
  });
});

app.get("/execution/account/summary", async (request, reply) => {
  const query = z
    .object({
      force: z.coerce.boolean().default(false),
    })
    .parse(request.query ?? {});

  const { accountId, accounts } = await ensureBrokerSession();
  await syncRecentExecutions(accountId);

  if (
    !query.force &&
    accountSnapshotCache &&
    accountSnapshotCache.accountId === accountId &&
    Date.now() - accountSnapshotCache.fetchedAtMs < 10_000
  ) {
    const cumulative = await repo.getCumulativeRealizedPnL({
      baseCurrency: config.IB_CURRENCY,
      fxToBaseByCurrency: accountSnapshotCache.snapshot.fxToBaseByCurrency,
    });
    return {
      source: "cache",
      accounts,
      ...accountSnapshotCache.snapshot,
      totals: {
        ...accountSnapshotCache.snapshot.totals,
        dailyRealizedPnL: accountSnapshotCache.snapshot.totals.realizedPnL,
        cumulativeRealizedPnL: cumulative.pnl,
      },
      diagnostics: {
        cumulativeRealizedPnLComplete: cumulative.complete,
        cumulativeRealizedPnLMissingCommissionReports:
          cumulative.missingCommissionReports,
        cumulativeRealizedPnLMissingFxRates: cumulative.missingFxRates,
      },
    };
  }

  if (!accountSnapshotInFlight) {
    accountSnapshotInFlight = tws.getAccountSnapshot(accountId).finally(() => {
      accountSnapshotInFlight = null;
    });
  }

  const snapshot = await accountSnapshotInFlight;
  const cumulative = await repo.getCumulativeRealizedPnL({
    baseCurrency: config.IB_CURRENCY,
    fxToBaseByCurrency: snapshot.fxToBaseByCurrency,
  });
  accountSnapshotCache = {
    accountId,
    fetchedAtMs: Date.now(),
    snapshot,
  };

  // PR14 round-7 blocker — snapshot persistence is NO LONGER
  // fire-and-forget. Await the broker-driven refresher so:
  //   - the write-path guard consulted immediately after this
  //     HTTP response is guaranteed to see either the freshly
  //     persisted snapshot (success) or `complete=false`
  //     (in-flight / failed) — never a stale flat snapshot;
  //   - `/ready` observes the failure state via
  //     `snapshotHealthByAccount` and reports the write path
  //     as not ready.
  // The refresher itself performs a second `getAccountSnapshot`
  // — the small extra cost is acceptable given this endpoint is
  // low-frequency (UI cache TTL 10 s). Coalesced when concurrent
  // requests arrive.
  await refreshBrokerPositionSnapshot(accountId);
  const snapshotHealth = snapshotHealthByAccount.get(accountId);
  if (snapshotHealth && snapshotHealth.kind === "failed") {
    // Round-8 blocker fix: snapshot persistence failed. The
    // display response is NOT returned as 200 with a live
    // snapshot — that would tempt callers to trust it. Return
    // 503 with the failure reason. The write path is
    // fail-closed and readiness is 503; the endpoint MUST NOT
    // paper over the failure with a happy 200.
    app.log.warn(
      { accountId, error: snapshotHealth.error },
      "account-summary: snapshot persistence failed — returning 503",
    );
    return reply.code(503).send({
      error: "position_snapshot_persistence_failed",
      accountId,
      reason: snapshotHealth.error,
      positionSnapshotPersistence: {
        status: "failed",
        error: snapshotHealth.error,
      },
    });
  }

  return {
    source: "live",
    accounts,
    ...snapshot,
    totals: {
      ...snapshot.totals,
      dailyRealizedPnL: snapshot.totals.realizedPnL,
      cumulativeRealizedPnL: cumulative.pnl,
    },
    diagnostics: {
      cumulativeRealizedPnLComplete: cumulative.complete,
      cumulativeRealizedPnLMissingCommissionReports:
        cumulative.missingCommissionReports,
      cumulativeRealizedPnLMissingFxRates: cumulative.missingFxRates,
    },
  };
});

app.get("/execution/orders", async (request) => {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(500).default(50),
      instrument: z.string().trim().optional(),
      side: z.enum(["BUY", "SELL", "HOLD"]).optional(),
      type: z.enum(["MKT", "LMT", "STP"]).optional(),
      qty: z.string().trim().optional(),
      status: z
        .enum([
          "PROPOSED",
          "REJECTED",
          "SUBMITTED",
          "FILLED",
          "CANCELLED",
          "SUPERSEDED",
          "EXPIRED",
        ])
        .optional(),
      risk: z.enum(["PASS", "REJECT"]).optional(),
      decisionSource: z
        .enum(["signal", "llm", "user", "user_override"])
        .optional(),
      aiDecision: z.enum(["EXECUTE", "REJECT"]).optional(),
    })
    .parse(request.query ?? {});

  let qty: number | undefined;
  if (query.qty) {
    const parsed = Number(query.qty);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid qty filter: ${query.qty}`);
    }
    qty = parsed;
  }

  const filters: OrderListFilters = {
    instrument: query.instrument || undefined,
    side: query.side,
    orderType: query.type,
    qty,
    status: query.status as ProposedOrderStatus | undefined,
    riskCheckStatus: query.risk,
    decisionSource: query.decisionSource,
    aiDecision: query.aiDecision,
  };

  return repo.listOrders(query.limit, filters);
});

app.get("/execution/trades", async (request) => {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
    })
    .parse(request.query ?? {});
  const trades = await repo.listTrades(query.limit);
  return { trades };
});

app.post("/execution/execute-proposed/:id", async (request, reply) => {
  const params = z
    .object({ id: z.coerce.number().int().positive() })
    .parse(request.params ?? {});
  const body = executeProposedBodySchema.parse(request.body ?? {});

  // Pre-lookup the order ONLY to read `.instrument` for the HTTP
  // mapper's message strings + to derive the actor. Every state
  // decision is made inside the service.
  const preview = await repo.getProposedOrderById(params.id);
  const fallbackActor: DecisionActor = body.overrideRejected
    ? "user_override"
    : ((body.actor as DecisionActor | undefined) ?? "user");
  const metadata = normalizeDecisionMetadata(body, fallbackActor);
  const outcome = await submissionService.executeProposed({
    proposedOrderId: params.id,
    overrideRejected: body.overrideRejected === true,
    decisionMetadata: metadata,
  });
  return sendSubmissionOutcome(reply, outcome, preview?.instrument ?? "");
});

app.post("/execution/reject-proposed/:id", async (request, reply) => {
  const params = z
    .object({ id: z.coerce.number().int().positive() })
    .parse(request.params ?? {});
  const body = rejectProposedBodySchema.parse(request.body ?? {});

  const order = await repo.getProposedOrderById(params.id);
  if (!order) {
    return reply
      .code(404)
      .send({ error: `proposed order id=${params.id} not found` });
  }

  if (order.status !== "PROPOSED") {
    return reply.code(409).send({
      error: `order id=${params.id} cannot be rejected (current=${order.status})`,
    });
  }

  const metadata = normalizeDecisionMetadata(body, body.actor ?? "user");
  metadata.aiDecision = "REJECT";
  if (!await repo.rejectPendingProposal(params.id, body.reason, metadata))
    return reply.code(409).send({ error: "proposal_no_longer_rejectable" });
  const fresh = await repo.getProposedOrderById(params.id);
  return { order: fresh };
});

registerCancelProposedRoute(app, {
  repository: repo, broker: tws,
  requestReconciliation: () => reconScheduler.triggerNow(),
});

const fullCloseService = new FullCloseService(new CloseRepository(pool, repo), {
  context: (instrumentId) => lastActiveAccountId && tws.isConnected() ? {
    accountId: lastActiveAccountId, sessionId: EXECUTION_PROCESS_OWNER_ID,
    clientId: tws.getClientId(), generation: tws.getConnectionGeneration(), nowMs: Date.now(),
    bound: instrumentBindingAuthority?.getBoundInstrument(instrumentId) ?? null,
  } : null,
  refresh: async () => {
    if (!lastActiveAccountId) throw new CloseConflict("close_account_unavailable");
    await refreshBrokerPositionSnapshot(lastActiveAccountId);
    if (!await reconScheduler.triggerFresh()) throw new CloseConflict("close_fresh_capture_unavailable");
  },
  evaluate: evaluateCloseEvidence,
  assessRisk: async (ticket, bound, context) => {
    const response = await fetch(`${config.EXECUTION_INGESTION_BASE_URL.replace(/\/$/, "")}/watchlist`,
      { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new CloseConflict("close_quote_unavailable");
    const metadata = isWseBound(bound) ? await wseMetadata.load(bound, context.accountId) : undefined;
    return assessCloseRisk(ticket, bound, { ...context, nowMs: Date.now() }, await response.json(), metadata);
  },
  prepare: async (ticket, clientOrderId, originalProposalId) => {
    // Preparation is read-only at IBKR; the close proposal and marker commit before dispatch.
    const prepared = await tws.prepareBrokerOrderPlan(ticket, lastActiveAccountId!, "DAY",
      { proposedOrderId: originalProposalId, clientOrderId });
    return { normalizedTicket: prepared.normalizedTicket, payload: prepared,
      persistence: { clientOrderId, clientOrderHash: computeClientOrderHash(ticket), instrument: ticket.instrument,
        instrumentId: ticket.instrumentId, conid: ticket.conid ?? null, legs: prepared.legs } };
  },
  validatePrepared: (prepared, ticket, context) => {
    const failure = validatePersistedClosePrepared(prepared, ticket, context);
    if (failure) throw new CloseConflict(failure);
  },
  cancel: async (leg, context) => {
    if (!leg.permId) throw new CloseConflict("close_cancel_perm_missing");
    const terminal = await tws.cancelOwnedOrder({ ...leg, conid: Number(leg.conid), permId: leg.permId,
      expectedGeneration: context.generation, observedAt: leg.observedAt });
    return { ...leg, status: "CANCELLED", confirmedAt: terminal.confirmedAt,
      generation: terminal.connectionGeneration, sessionId: context.sessionId };
  },
  dispatch: async (prepared, _operation, context) => {
    await tws.dispatchPreparedClose(prepared.payload as PreparedBrokerOrder, context.generation);
  },
  alert: async (operation, reason) => {
    await alerts.record({ severity: "CRITICAL", kind: "system",
      message: `Close operation ${operation.id} requires attention: ${reason}`,
      payload: { operationId: operation.id, originalProposalId: operation.originalProposalId, state: operation.state,
        accountId: operation.accountId, conid: operation.conid } });
  },
});
registerFullCloseRoutes(app, fullCloseService);

registerLifecycleRoutes(app, {
  repository: repo,
  currentAccountId: () => lastActiveAccountId,
  currentSessionId: () => EXECUTION_PROCESS_OWNER_ID,
  boundInstrument: (id) => instrumentBindingAuthority?.getBoundInstrument(id) ?? null,
});

app.post("/execution/execute-ticket", async (request, reply) => {
  const body = executeTicketBodySchema.parse(request.body ?? {});
  const ticket = body.ticket as SignalTicket;
  // PR15 r7 §1 — all routing decisions are made INSIDE the
  // single production `submissionService`. This handler only:
  //   (a) parses HTTP,
  //   (b) refuses persist=false with a distinct 400 (direct-
  //       ticket path is out of scope for PR15),
  //   (c) delegates to `submissionService.submitTicket(...)`,
  //   (d) maps the discriminated outcome to HTTP.
  if (!body.persist) {
    void alerts
      .record({
        severity: "warn",
        kind: "direct_ticket_migrated",
        message:
          `direct-ticket path refused (persist=false) — reconciliation ` +
          `requires durable intent. Instrument=${ticket.instrument}`,
        payload: {
          instrument: ticket.instrument,
          side: ticket.side,
          quantity: ticket.quantity,
        },
      })
      .catch(() => undefined);
    return reply.code(400).send({
      error: "direct_ticket_disallowed_in_pr15",
      detail:
        "POST /execution/execute-ticket requires persist=true so PR15 " +
        "reconciliation can identify the resulting broker order.",
    });
  }
  // PR15.2 — the HTTP endpoint REQUIRES `instrumentId`. The
  // deeper `submissionService` also validates when the field is
  // present, but here at the wire we deterministically refuse
  // any request that omits it so no code path can bypass the
  // authoritative binding gate through this endpoint.
  if (
    typeof ticket.instrumentId !== "string" ||
    ticket.instrumentId.length === 0
  ) {
    return reply.code(400).send({
      outcome: "INSTRUMENT_BINDING_UNAVAILABLE",
      error: "INSTRUMENT_BINDING_UNAVAILABLE",
      reason: "instrument_id_missing",
      detail:
        "POST /execution/execute-ticket requires ticket.instrumentId (PR15.2). " +
        "Legacy proposal-based submissions must use /execution/execute-proposed/:id.",
    });
  }
  const outcome = await submissionService.submitTicket({
    ticket,
    strategy: body.strategy,
    clientOrderId: body.clientOrderId,
    clientOrderHash: body.clientOrderHash,
  });
  return sendSubmissionOutcome(reply, outcome, ticket.instrument);
});

async function main(): Promise<void> {
  // PR14.2 — versioned database migrations. MUST complete before
  // any HTTP route is registered and before the broker connection is
  // opened. A migration failure blocks startup: throw propagates out
  // of `main()`, the top-level handler logs and exits non-zero, so
  // the scheduler / broker never come online against a partial schema.
  try {
    await repo.init();
    app.log.info("database migrations up to date");
  } catch (err) {
    app.log.error(
      { err: (err as Error).message },
      "database migrations failed — refusing to start",
    );
    throw err;
  }

  // Phase 1 / PR2: enforce Bearer auth on every non-public route,
  // stamp x-correlation-id on every response, and write one audit row
  // per request in onResponse. Registered AFTER repo.init() so the
  // execution_audit_log table exists before the first insert.
  const burstTracker = new AuthFailureBurstTracker((burst) => {
    void alerts.record({
      severity: "warn",
      kind: "auth_failure_burst",
      message: `Auth failure burst: ${burst.count} 401s from ip=${burst.ip ?? "unknown"} within ${burst.windowMs}ms`,
      payload: {
        ip: burst.ip,
        count: burst.count,
        windowMs: burst.windowMs,
      },
    });
  });
  const expectedToken = config.EXECUTION_API_TOKEN ?? "";
  if (!expectedToken) {
    app.log.warn(
      "EXECUTION_API_TOKEN is empty; every /execution/* request will be denied. " +
        "Set EXECUTION_API_TOKEN in .env (openssl rand -hex 32) to allow clients through.",
    );
  }
  registerExecutionAuth(app, {
    token: expectedToken,
    publicPaths: new Set(["/health"]),
    burstTracker,
    writeAudit: (row) => repo.insertExecutionAuditLog(row),
    logger: app.log,
  });

  // Environment guard for every mutating /execution/* request.
  // Registered after auth so unauthenticated callers still receive 401
  // instead of 423. Rejections throw EnvironmentGuardError which the
  // global error handler translates into HTTP 423 Locked.
  app.addHook("preHandler", async (request) => {
    if (
      request.method !== "POST" &&
      request.method !== "PUT" &&
      request.method !== "PATCH" &&
      request.method !== "DELETE"
    ) {
      return;
    }
    if (!request.url.startsWith("/execution/")) return;
    const cfg = envGuardConfig();
    if (
      isWriteGuardExempt(
        request.method,
        request.routeOptions.url ?? request.url,
      )
    ) {
      // PR15.3 r4 hostile-review Finding 1 — exempt / risk-reducing
      // endpoints (cancel-proposed, reconciliation operator surface)
      // BYPASS ONLY the administrative write kill switch. Environment,
      // account allowlist, and known-account requirement STILL apply.
      // Bearer + audit (registered earlier) STILL run. This prevents a
      // pre-r4 shape where `isWriteGuardExempt(...) → return` let a
      // cancel-proposed request through with no account check at all.
      assertActiveAccountAllowed(cfg, lastActiveAccountId, {
        requireKnownAccount: true,
      });
      return;
    }
    assertEnvironmentAllowsWrite(cfg, lastActiveAccountId);
  });

  // PR15 — register reconciliation routes.
  registerReconciliationRoutes(app, {
    reconRepo,
    scheduler: reconScheduler,
    resolveTokenProvider: () =>
      config.EXECUTION_RECONCILIATION_RESOLVE_TOKEN?.length
        ? config.EXECUTION_RECONCILIATION_RESOLVE_TOKEN
        : null,
    currentSessionId: () => EXECUTION_PROCESS_OWNER_ID,
    currentAccountId: () => lastActiveAccountId,
    maxAgeSeconds: config.EXECUTION_READY_RECONCILIATION_MAX_AGE_S,
    snapshotMaxAgeSeconds: () =>
      config.EXECUTION_READY_RECONCILIATION_MAX_AGE_S,
  });

  const address = await app.listen({
    port: config.EXECUTION_PORT,
    host: config.EXECUTION_BIND_HOST,
  });
  app.log.info(`execution-engine listening on ${address}`);

  // PR15 — start the reconciliation scheduler. It ticks based on
  // config.RECONCILIATION_* env vars; the runner acquires a
  // session-scoped `recon:<account>` advisory lock and publishes
  // RUNNING → final status via two short `snap:<account>` xact
  // locks around Phase B broker reads.
  reconScheduler.start();

  // Fire-and-forget: try to reconcile positions with the broker on
  // startup. If TWS is not yet reachable we just emit a startup alert
  // and let the operator trigger /execution/reconciliation later.
  void (async () => {
    try {
      const report = await runReconciliation();
      await alerts.record({
        severity: report.mismatches.length > 0 ? "error" : "info",
        kind: "reconciliation_run",
        message: `Startup reconciliation: matches=${report.matches} mismatches=${report.mismatches.length} expected=${report.expectedPositionsCount} broker=${report.brokerPositionsCount}`,
        payload: { report },
      });
    } catch (error) {
      app.log.warn(
        { err: error },
        "startup reconciliation skipped (TWS not reachable)",
      );
      await alerts.record({
        severity: "warn",
        kind: "reconciliation_run",
        message: `Startup reconciliation skipped: ${(error as Error).message}`,
      });
    }
  })();
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    try {
      await reconScheduler.stop();
      tws.disconnect();
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}
