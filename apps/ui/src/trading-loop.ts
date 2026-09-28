export const TRADING_LOOP_RUN_ONCE_PATH =
  "/api/signal/runtime/trading-loop/run-once";

export const TRADING_LOOP_OUTCOME_KINDS = [
  "SUBMITTED",
  "DUPLICATE",
  "PENDING",
  "AWAITING_AI",
  "CONFLICT",
  "UNKNOWN",
  "NOT_SUBMITTED",
  "SKIPPED",
  "ERROR",
] as const;

export type TradingLoopOutcomeKind = (typeof TRADING_LOOP_OUTCOME_KINDS)[number];

export type TradingLoopOutcome = {
  kind: TradingLoopOutcomeKind;
  reason?: string;
  message?: string;
  idempotencyKey?: string;
};

export type TradingLoopReport = {
  instrumentId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: TradingLoopOutcome;
};

export type TradingLoopResult = {
  cycleId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  reports: TradingLoopReport[];
};

export function fetchOperatorApi(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("X-Operator-Request", "1");
  return fetch(input, {
    ...init,
    headers,
    credentials: "same-origin",
    redirect: "error",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || isText(value);
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseTradingLoopResult(value: unknown): TradingLoopResult {
  if (
    !isRecord(value) ||
    !isText(value.cycleId) ||
    !isText(value.startedAt) ||
    !isText(value.finishedAt) ||
    !isDuration(value.durationMs) ||
    !Array.isArray(value.reports)
  ) {
    throw new Error("Trading-loop response unavailable: malformed cycle result");
  }

  const reports = value.reports.map((candidate): TradingLoopReport => {
    if (
      !isRecord(candidate) ||
      !isText(candidate.instrumentId) ||
      !isText(candidate.startedAt) ||
      !isText(candidate.finishedAt) ||
      !isDuration(candidate.durationMs) ||
      !isRecord(candidate.outcome) ||
      !TRADING_LOOP_OUTCOME_KINDS.includes(
        candidate.outcome.kind as TradingLoopOutcomeKind,
      ) ||
      !isOptionalText(candidate.outcome.reason) ||
      !isOptionalText(candidate.outcome.message) ||
      !isOptionalText(candidate.outcome.idempotencyKey)
    ) {
      throw new Error(
        "Trading-loop response unavailable: malformed or unsupported instrument result",
      );
    }
    return {
      instrumentId: candidate.instrumentId,
      startedAt: candidate.startedAt,
      finishedAt: candidate.finishedAt,
      durationMs: candidate.durationMs,
      outcome: {
        kind: candidate.outcome.kind as TradingLoopOutcomeKind,
        ...(candidate.outcome.reason !== undefined && {
          reason: candidate.outcome.reason as string,
        }),
        ...(candidate.outcome.message !== undefined && {
          message: candidate.outcome.message as string,
        }),
        ...(candidate.outcome.idempotencyKey !== undefined && {
          idempotencyKey: candidate.outcome.idempotencyKey as string,
        }),
      },
    };
  });

  return {
    cycleId: value.cycleId,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    durationMs: value.durationMs,
    reports,
  };
}

export async function requestTradingLoopRunOnce(): Promise<TradingLoopResult> {
  const response = await fetchOperatorApi(TRADING_LOOP_RUN_ONCE_PATH, {
    method: "POST",
  });
  if (!response.ok) {
    const descriptions: Record<number, string> = {
      401: "Operator authentication required (401)",
      403: "Operator origin or request was rejected (403)",
      404: "Trading-loop endpoint unavailable (404)",
      503: "Trading loop unavailable or Paper guard rejected the request (503)",
    };
    throw new Error(descriptions[response.status] ?? `Request failed (${response.status})`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Trading-loop response unavailable: invalid JSON");
  }
  return parseTradingLoopResult(body);
}
