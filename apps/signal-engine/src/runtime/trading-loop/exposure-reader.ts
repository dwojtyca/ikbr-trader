/**
 * Trading Loop — exposure reader (port + HTTP implementation).
 *
 * The loop MUST NOT open a new position while there is any live
 * exposure for the same instrument. Execution-engine is the single
 * source of truth per AGENTS.md ("IBKR is the source of truth for
 * positions, orders, executions"). We NEVER trust in-process
 * memory to answer "is there an active order for X".
 *
 * Two execution-engine endpoints are queried per instrument:
 *
 *   GET /execution/orders?instrument=<brokerSymbol>
 *   GET /execution/account/summary
 *
 * Every response is validated with a Zod schema at the boundary —
 * a malformed / missing / partially-typed response is treated as a
 * hard failure, NEVER silently coerced into "no exposure". This is
 * fail-closed: any doubt → `TradingExposureReadError` → the loop
 * surfaces `EXPOSURE_READ_FAILED` and skips the instrument.
 *
 * Local classification derives four independent exposure flags:
 *
 *   - `hasActiveOrder`         : any row with status = SUBMITTED
 *   - `hasAmbiguousSubmission` : PROPOSED with `executionAttemptedAt`
 *                                OR `brokerOrderId` set (the ambiguous
 *                                crash window from EXECUTION_RUNTIME.md)
 *   - `hasPendingProposal`     : PROPOSED with NO markers set — a
 *                                safe-to-resume orphan that must NOT
 *                                be duplicated with a new client order
 *                                id (reconciliation in PR15 owns it)
 *   - `hasOpenPosition`        : positions[].symbol matches AND
 *                                |position| > 0
 *
 * Any of the four flags true → loop reports `EXPOSURE_BLOCKED`.
 */

import { z } from "zod";

import type {
  TradingExposure,
  TradingExposureReader,
} from "./types.js";

export class TradingExposureReadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`exposure read failed [${code}]: ${message}`);
    this.name = "TradingExposureReadError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Boundary schemas — every field the classifier touches must be
// validated. Every other field is dropped (no `.passthrough()`)
// so a schema change on the execution-engine side surfaces here
// as a validation failure rather than silently propagating an
// unexpected shape.
// ---------------------------------------------------------------------------

const proposedOrderStatusSchema = z.enum([
  "PROPOSED",
  "REJECTED",
  "SUBMITTED",
  "FILLED",
  "CANCELLED",
  "SUPERSEDED",
  "EXPIRED",
]);

/**
 * Timestamp-shaped field. Execution-engine serialises `Date` values
 * to ISO strings over JSON, but tests may pass raw `Date`s to
 * `classifyExposure`; accept both. The classifier only cares
 * whether the field is set — its exact instant is unused.
 */
const timestampSchema = z.union([
  z.string().datetime({ offset: true }),
  z.date(),
]);

const proposedOrderRowSchema = z.object({
  instrument: z.string().min(1),
  status: proposedOrderStatusSchema,
  executionAttemptedAt: timestampSchema.nullable().optional(),
  brokerOrderId: z.string().min(1).nullable().optional(),
});

const ordersResponseSchema = z.array(proposedOrderRowSchema);

const accountPositionSchema = z.object({
  symbol: z.string().min(1),
  position: z
    .number()
    .refine((n) => Number.isFinite(n), { message: "position must be finite" }),
});

/**
 * `positions` is REQUIRED — we refuse to accept "field missing" as
 * "no positions". A disconnected/stale/partial snapshot from
 * execution-engine MUST surface as a hard read failure, not as an
 * implicit "empty position book".
 *
 * PR14 round-4 blocker (item 5): freshness fields are also
 * validated. `source` must be `"live"` or `"cache"`, `retrievedAt`
 * must parse as a timestamp, and the caller is expected to
 * cross-check age against a configured maximum.
 */
const accountSummarySchema = z.object({
  positions: z.array(accountPositionSchema),
  source: z.enum(["live", "cache"]),
  retrievedAt: z.string().datetime({ offset: true }),
  accounts: z.array(z.string()).optional(),
});

type ValidatedOrder = z.infer<typeof proposedOrderRowSchema>;
type ValidatedSummary = z.infer<typeof accountSummarySchema>;

export interface HttpTradingExposureReaderOptions {
  readonly engineUrl: string;
  readonly bearerToken: string;
  readonly requestTimeoutMs: number;
  /**
   * PR14 round-4 blocker (item 5). Maximum tolerated age (ms) of
   * the account-summary snapshot. `readExposure` refuses if
   * `retrievedAt` is older than this — the pre-check never trusts
   * a stale cache reading. Defaults to 60_000 ms.
   */
  readonly summaryMaxAgeMs?: number;
  /**
   * Injectable so tests can stub the network without hoisting a
   * global mock. Signature matches the standard `fetch`.
   */
  readonly fetch?: typeof fetch;
}

export class HttpTradingExposureReader implements TradingExposureReader {
  readonly #baseUrl: string;
  readonly #bearerToken: string;
  readonly #timeoutMs: number;
  readonly #summaryMaxAgeMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpTradingExposureReaderOptions) {
    if (!options?.engineUrl) {
      throw new Error("HttpTradingExposureReader: engineUrl is required");
    }
    if (options.requestTimeoutMs <= 0) {
      throw new Error(
        "HttpTradingExposureReader: requestTimeoutMs must be > 0",
      );
    }
    this.#baseUrl = options.engineUrl.replace(/\/+$/, "");
    this.#bearerToken = options.bearerToken;
    this.#timeoutMs = options.requestTimeoutMs;
    this.#summaryMaxAgeMs = options.summaryMaxAgeMs ?? 60_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async readExposure(input: {
    readonly instrumentId: string;
    readonly brokerSymbol: string;
  }): Promise<TradingExposure> {
    if (!input.brokerSymbol) {
      throw new TradingExposureReadError(
        "invalid_input",
        `brokerSymbol required for exposure read (instrumentId=${input.instrumentId})`,
      );
    }
    const [orders, summary] = await Promise.all([
      this.#fetchOrders(input.brokerSymbol),
      this.#fetchAccountSummary(),
    ]);
    // Round-4 freshness enforcement: refuse a stale summary. The
    // authoritative open-position guard in execution-engine will
    // also refuse (via its persisted snapshot), but this local
    // check surfaces the failure BEFORE the pipeline runs.
    const retrievedAtMs = Date.parse(summary.retrievedAt);
    if (!Number.isFinite(retrievedAtMs)) {
      throw new TradingExposureReadError(
        "malformed_summary",
        `retrievedAt could not be parsed: ${summary.retrievedAt}`,
      );
    }
    const ageMs = Date.now() - retrievedAtMs;
    if (ageMs > this.#summaryMaxAgeMs) {
      throw new TradingExposureReadError(
        "stale_summary",
        `account/summary is ${ageMs}ms old, max allowed ${this.#summaryMaxAgeMs}ms`,
      );
    }
    return classifyExposure(orders, summary, input.brokerSymbol);
  }

  async probeReady(): Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  > {
    // Lightweight ping — hits BOTH read endpoints used by
    // `readExposure` (round-3 blocker fix). Small payloads
    // (`limit=1` on orders); `account/summary` has no size knob
    // but is bounded by broker positions count. Only response
    // SHAPE is validated, contents are ignored.
    const ordersUrl = `${this.#baseUrl}/execution/orders?limit=1`;
    const summaryUrl = `${this.#baseUrl}/execution/account/summary`;
    const [ordersResult, summaryResult] = await Promise.all([
      this.#probeEndpoint(ordersUrl, ordersResponseSchema),
      this.#probeEndpoint(summaryUrl, accountSummarySchema),
    ]);
    if (ordersResult.ok && summaryResult.ok) {
      return { ok: true };
    }
    const parts: string[] = [];
    if (!ordersResult.ok) parts.push(`orders: ${ordersResult.message}`);
    if (!summaryResult.ok) parts.push(`account_summary: ${summaryResult.message}`);
    return { ok: false, message: parts.join("; ") };
  }

  async #probeEndpoint(
    url: string,
    schema: { safeParse: (input: unknown) => { success: boolean; error?: { message: string } } },
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  > {
    try {
      const body = await this.#getJson(url);
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: `malformed: ${parsed.error?.message ?? "schema"}` };
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof TradingExposureReadError) {
        return { ok: false, message: `${error.code}: ${error.message}` };
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #fetchOrders(brokerSymbol: string): Promise<readonly ValidatedOrder[]> {
    const url = `${this.#baseUrl}/execution/orders?instrument=${encodeURIComponent(brokerSymbol)}&limit=200`;
    const body = await this.#getJson(url);
    const parsed = ordersResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new TradingExposureReadError(
        "malformed_orders",
        `${url}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async #fetchAccountSummary(): Promise<ValidatedSummary> {
    const url = `${this.#baseUrl}/execution/account/summary`;
    const body = await this.#getJson(url);
    const parsed = accountSummarySchema.safeParse(body);
    if (!parsed.success) {
      throw new TradingExposureReadError(
        "malformed_summary",
        `${url}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async #getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(this.#bearerToken
            ? { authorization: `Bearer ${this.#bearerToken}` }
            : {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new TradingExposureReadError(
          "timeout",
          `${url} did not respond within ${this.#timeoutMs}ms`,
        );
      }
      throw new TradingExposureReadError(
        "network_error",
        `${url}: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new TradingExposureReadError(
        "http_error",
        `${url} returned ${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new TradingExposureReadError(
        "invalid_json",
        `${url}: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * Pure classifier — exported for direct unit testing without
 * spinning up the HTTP layer. Applied AFTER a successful,
 * SCHEMA-VALIDATED read of both endpoints.
 */
export function classifyExposure(
  orders: readonly ValidatedOrder[],
  summary: ValidatedSummary,
  brokerSymbol: string,
): TradingExposure {
  let hasActiveOrder = false;
  let hasAmbiguousSubmission = false;
  let hasPendingProposal = false;
  for (const order of orders) {
    // execution-engine returns rows keyed on the ticket's
    // `instrument` field, which mirrors the broker symbol.
    // Defensive symbol filter guards against a future endpoint
    // change that returns a broader set.
    if (order.instrument !== brokerSymbol) continue;
    switch (order.status) {
      case "SUBMITTED":
        hasActiveOrder = true;
        break;
      case "PROPOSED": {
        const hasMarker =
          (order.executionAttemptedAt !== undefined &&
            order.executionAttemptedAt !== null) ||
          (order.brokerOrderId !== undefined &&
            order.brokerOrderId !== null);
        if (hasMarker) {
          hasAmbiguousSubmission = true;
        } else {
          hasPendingProposal = true;
        }
        break;
      }
      // FILLED / REJECTED / CANCELLED / SUPERSEDED / EXPIRED are
      // terminal — do NOT block a new entry on their own. Any
      // implied open position they left behind is caught below
      // via the account summary.
      default:
        break;
    }
  }
  let hasOpenPosition = false;
  let positionSide: "LONG" | "SHORT" | undefined;
  let quantity: number | undefined;
  for (const pos of summary.positions) {
    if (pos.symbol !== brokerSymbol) continue;
    if (pos.position !== 0) {
      hasOpenPosition = true;
      positionSide = pos.position > 0 ? "LONG" : "SHORT";
      quantity = Math.abs(pos.position);
      break;
    }
  }
  return {
    hasOpenPosition,
    hasActiveOrder,
    hasAmbiguousSubmission,
    hasPendingProposal,
    ...(positionSide !== undefined ? { positionSide } : {}),
    ...(quantity !== undefined ? { quantity } : {}),
  };
}
