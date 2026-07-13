import Fastify from "fastify";
import { Pool } from "pg";
import { z } from "zod";
import { ProposedOrder, ProposedOrderStatus, SignalTicket } from "@ikbr/shared";
import { config } from "./config.js";
import {
  DecisionActor,
  ExecutionRepository,
  OrderDecisionMetadata,
  OrderListFilters,
} from "./repository.js";
import { AccountSnapshot, TwsExecutionClient } from "./tws-execution-client.js";
import { AlertService } from "./alerts.js";
import {
  AuthFailureBurstTracker,
  registerExecutionAuth,
} from "./auth.js";

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
const pool = new Pool({ connectionString: config.POSTGRES_URL });
const repo = new ExecutionRepository(pool);
const alerts = new AlertService(repo, app.log);
const tws = new TwsExecutionClient(
  {
    host: config.IB_SOCKET_HOST,
    port: config.IB_SOCKET_PORT,
    clientId: config.EXECUTION_CLIENT_ID,
    securityType: config.defaultSecurityType,
    exchange: config.IB_EXCHANGE,
    primaryExchange: config.IB_PRIMARY_EXCHANGE,
    currency: config.IB_CURRENCY,
    orderTimeoutMs: config.EXECUTION_ORDER_TIMEOUT_MS,
    submittedAutoCancelMs: config.EXECUTION_SUBMITTED_AUTO_CANCEL_MS,
    retryAsMktOnCode110: config.executionRetryAsMktOnCode110,
    fractionalSymbols: config.fractionalSymbols,
    blockOutsideUsRth: config.blockOutsideUsRth,
    usRthOpenBufferMin: config.EXECUTION_US_RTH_OPEN_BUFFER_MIN,
    usRthCloseBufferMin: config.EXECUTION_US_RTH_CLOSE_BUFFER_MIN,
    contractFallbackByConid: config.contractFallbackByConid,
  },
  (line) => app.log.info(line),
  (update) => {
    void repo.applyBrokerStatusUpdate(update).catch((err) => {
      app.log.warn(
        { update, err },
        "failed to apply broker order status update",
      );
    });
    const status = String(update.status ?? "").toUpperCase();
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
    void repo.upsertBrokerExecutionFill(fill).catch((err) => {
      app.log.warn({ fill, err }, "failed to persist broker execution fill");
    });
  },
  (report) => {
    void repo.applyBrokerCommissionReport(report).catch((err) => {
      app.log.warn(
        { report, err },
        "failed to persist broker commission report",
      );
    });
  },
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

const executeTicketBodySchema = z.object({
  ticket: ticketSchema,
  persist: z.boolean().default(true),
  strategy: z.string().default("manual_ticket"),
});

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
  };
}

/**
 * Evaluates the daily-loss kill-switch using already-cached account
 * snapshot data (no extra TWS round-trip) and broker_execution_fills
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
      complete: summary.complete,
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
 */
async function runReconciliation(): Promise<ReconciliationReport> {
  const { accountId } = await ensureBrokerSession();
  const snapshot = await tws.getAccountSnapshot(accountId);
  const expected = await repo.computeExpectedNetPositions();

  const expectedBySymbol = new Map<string, number>();
  for (const row of expected) {
    expectedBySymbol.set(row.symbol.toUpperCase(), row.netShares);
  }

  const brokerBySymbol = new Map<
    string,
    { netShares: number; averageCost?: number; marketValue?: number }
  >();
  for (const pos of snapshot.positions) {
    if (!pos.symbol) continue;
    const key = pos.symbol.toUpperCase();
    const prev = brokerBySymbol.get(key);
    brokerBySymbol.set(key, {
      netShares: (prev?.netShares ?? 0) + (pos.position ?? 0),
      averageCost: pos.averageCost ?? prev?.averageCost,
      marketValue: pos.marketValue ?? prev?.marketValue,
    });
  }

  const allSymbols = new Set<string>([
    ...expectedBySymbol.keys(),
    ...brokerBySymbol.keys(),
  ]);

  const mismatches: ReconciliationMismatch[] = [];
  let matches = 0;
  for (const symbol of allSymbols) {
    const expectedShares = expectedBySymbol.get(symbol) ?? 0;
    const broker = brokerBySymbol.get(symbol);
    const brokerShares = broker?.netShares ?? 0;
    if (Math.abs(expectedShares - brokerShares) <= 0.000001) {
      matches += 1;
      continue;
    }
    mismatches.push({
      symbol,
      expectedNetShares: expectedShares,
      brokerNetShares: brokerShares,
      difference: brokerShares - expectedShares,
      brokerAveragePrice: broker?.averageCost,
      brokerMarketValue: broker?.marketValue,
    });
  }

  const report: ReconciliationReport = {
    ranAt: new Date().toISOString(),
    accountId,
    expectedPositionsCount: expectedBySymbol.size,
    brokerPositionsCount: brokerBySymbol.size,
    matches,
    mismatches,
  };

  if (mismatches.length > 0) {
    app.log.warn({ report }, "position reconciliation found mismatches");
    void alerts.record({
      severity: "error",
      kind: "reconciliation_mismatch",
      message: `Position reconciliation found ${mismatches.length} mismatch(es) for account ${accountId}`,
      payload: {
        mismatches,
        expectedPositionsCount: expectedBySymbol.size,
        brokerPositionsCount: brokerBySymbol.size,
      },
    });
  } else {
    app.log.info({ report }, "position reconciliation clean");
  }

  return report;
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

  return { accountId, accounts };
}

async function executePersistedOrder(
  order: ProposedOrder,
  metadata?: OrderDecisionMetadata,
): Promise<{
  execution: {
    orderId: number;
    accountId: string;
    brokerOrderId: string;
    status: string;
  };
}> {
  if (!order.id) {
    throw new Error("persisted order id is missing");
  }

  const validationError = validateExecutableTicket(order);
  if (validationError) {
    await repo.markRejected(order.id, validationError, {
      ...metadata,
      aiDecision: metadata?.aiDecision ?? "REJECT",
    });
    throw new Error(validationError);
  }

  const activeSubmitted = await repo.findActiveSubmittedByInstrument(
    order.instrument,
    order.id,
  );
  if (activeSubmitted) {
    throw new Error(
      buildSubmittedConflictMessage(order.instrument, activeSubmitted),
    );
  }

  await assertKillSwitchOk(order);

  const { accountId } = await ensureBrokerSession();
  await repo.markExecutionAttempt(order.id, accountId, metadata);

  try {
    const result = await tws.placeSignalOrder(
      order,
      accountId,
      config.EXECUTION_DEFAULT_TIF,
    );
    if (result.status === "FILLED") {
      await repo.markFilled(
        order.id,
        accountId,
        result.brokerOrderId,
        `Broker accepted order, status=${result.status}`,
        metadata,
      );
    } else {
      await repo.markSubmitted(
        order.id,
        accountId,
        result.brokerOrderId,
        `Broker accepted order, status=${result.status}`,
        metadata,
      );
    }

    return {
      execution: {
        orderId: order.id,
        accountId,
        brokerOrderId: result.brokerOrderId,
        status: result.status,
      },
    };
  } catch (error) {
    const message = (error as Error).message;
    await repo.markCancelled(order.id, message);
    if (metadata) {
      await repo.setDecisionMetadata(order.id, {
        ...metadata,
        sourceError: message,
      });
    }
    throw error;
  }
}

app.get("/health", async () => ({ ok: true, twsConnected: tws.isConnected() }));

app.get("/execution/kill-switch", async () => {
  return evaluateKillSwitch();
});

app.post("/execution/reconciliation", async (request, reply) => {
  try {
    return await runReconciliation();
  } catch (error) {
    return reply.code(500).send({ error: (error as Error).message });
  }
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

app.get("/execution/account/summary", async (request) => {
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

  const order = await repo.getProposedOrderById(params.id);
  if (!order) {
    return reply
      .code(404)
      .send({ error: `proposed order id=${params.id} not found` });
  }

  const canExecute =
    order.status === "PROPOSED" ||
    (order.status === "REJECTED" && body.overrideRejected === true);
  if (!canExecute) {
    return reply.code(409).send({
      error: `order id=${params.id} cannot be executed (current=${order.status})`,
    });
  }

  const fallbackActor: DecisionActor = body.overrideRejected
    ? "user_override"
    : ((body.actor as DecisionActor | undefined) ?? "user");
  const metadata = normalizeDecisionMetadata(body, fallbackActor);
  const activeSubmitted = await repo.findActiveSubmittedByInstrument(
    order.instrument,
    order.id,
  );
  if (activeSubmitted) {
    return reply.code(409).send({
      error: buildSubmittedConflictMessage(order.instrument, activeSubmitted),
    });
  }

  try {
    await assertKillSwitchOk(order);
  } catch (error) {
    return reply.code(423).send({ error: (error as Error).message });
  }

  try {
    const result = await executePersistedOrder(order, metadata);
    const fresh = await repo.getProposedOrderById(params.id);
    return {
      order: fresh,
      ...result,
    };
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
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

  const metadata = normalizeDecisionMetadata(body, body.actor);
  metadata.aiDecision = metadata.aiDecision ?? "REJECT";

  await repo.markRejected(params.id, body.reason, metadata);
  const fresh = await repo.getProposedOrderById(params.id);
  return { order: fresh };
});

app.post("/execution/cancel-proposed/:id", async (request, reply) => {
  const params = z
    .object({ id: z.coerce.number().int().positive() })
    .parse(request.params ?? {});

  const order = await repo.getProposedOrderById(params.id);
  if (!order) {
    return reply
      .code(404)
      .send({ error: `proposed order id=${params.id} not found` });
  }

  if (order.status !== "SUBMITTED") {
    return reply.code(409).send({
      error: `order id=${params.id} cannot be cancelled (current=${order.status})`,
    });
  }

  if (!order.brokerOrderId) {
    return reply
      .code(400)
      .send({ error: `order id=${params.id} has no brokerOrderId to cancel` });
  }

  try {
    const result = await tws.cancelBrokerOrder(order.brokerOrderId);
    const fresh = await repo.getProposedOrderById(params.id);
    return {
      order: fresh,
      cancel: result,
    };
  } catch (error) {
    const message = (error as Error).message;

    // IB code=10147 means order is no longer active/not found in broker open orders.
    // Treat as terminal from UI perspective and close local SUBMITTED row.
    if (message.includes("code=10147")) {
      await repo.markCancelled(
        params.id,
        `Broker reports order not found (code=10147); marked as CANCELLED locally. Original error: ${message}`,
      );
      const fresh = await repo.getProposedOrderById(params.id);
      return {
        order: fresh,
        cancel: {
          brokerOrderId: order.brokerOrderId,
          status: "NOT_FOUND_ASSUMED_CANCELLED",
        },
      };
    }

    return reply.code(400).send({ error: message });
  }
});

app.post("/execution/execute-ticket", async (request, reply) => {
  const body = executeTicketBodySchema.parse(request.body ?? {});
  const ticket = body.ticket as SignalTicket;
  const activeSubmitted = await repo.findActiveSubmittedByInstrument(
    ticket.instrument,
  );
  if (activeSubmitted) {
    return reply.code(409).send({
      error: buildSubmittedConflictMessage(ticket.instrument, activeSubmitted),
    });
  }

  try {
    await assertKillSwitchOk({
      instrument: ticket.instrument,
      positionEffect: ticket.positionEffect,
    });
  } catch (error) {
    return reply.code(423).send({ error: (error as Error).message });
  }

  if (!body.persist) {
    const validationError = validateExecutableTicket(ticket);
    if (validationError) {
      return reply.code(400).send({ error: validationError });
    }

    try {
      const { accountId } = await ensureBrokerSession();

      const result = await tws.placeSignalOrder(
        ticket,
        accountId,
        config.EXECUTION_DEFAULT_TIF,
      );
      return {
        execution: {
          accountId,
          brokerOrderId: result.brokerOrderId,
          status: result.status,
        },
      };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  }

  const insertedId = await repo.insertProposedFromTicket(ticket, body.strategy);
  const inserted = await repo.getProposedOrderById(insertedId);
  if (!inserted) {
    return reply
      .code(500)
      .send({ error: "failed to read inserted proposed order" });
  }

  try {
    const result = await executePersistedOrder(inserted, {
      decisionSource: "user",
      decisionActor: "user",
    });
    const fresh = await repo.getProposedOrderById(insertedId);

    return {
      order: fresh,
      ...result,
    };
  } catch (error) {
    const fresh = await repo.getProposedOrderById(insertedId);
    return reply
      .code(400)
      .send({ error: (error as Error).message, order: fresh });
  }
});

async function main(): Promise<void> {
  await repo.init();

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

  const address = await app.listen({
    port: config.EXECUTION_PORT,
    host: config.EXECUTION_BIND_HOST,
  });
  app.log.info(`execution-engine listening on ${address}`);

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
      tws.disconnect();
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}
