/**
 * PR15 — signal-engine trading-loop fail-closed reconciliation
 * reader.
 *
 * Polls `GET /execution/reconciliation/latest` on the
 * execution-engine and returns a strict outcome that the trading
 * loop uses to SKIP an instrument BEFORE it does any market-data
 * or pipeline work.
 *
 * The execution-engine remains the authoritative enforcement
 * point (`insertProposedFromTicket` /
 * `tryStartSubmissionWithExposureGuard` run the same gate under
 * the PR14 submission transaction). This reader is a fast
 * pre-check so the loop stops burning CPU / market-data quota
 * when it knows the write will be refused.
 *
 * Fail-closed:
 *   * transport error / non-2xx → `unavailable`
 *   * malformed body → `unavailable`
 *   * `run.status ∈ {RUNNING,FAILED,ABANDONED}` → `unavailable`
 *   * `run.session_id !== ours` → `unavailable`
 *   * `stale=true` → `stale`
 *   * `exposureComplete=false` → `unavailable`
 *   * active hold matching the given instrument identity →
 *     `hold`
 *   * otherwise → `pass`
 */

import { z } from "zod";

export type ReconciliationSkipOutcome =
  | { readonly kind: "pass" }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
    }
  | { readonly kind: "stale" }
  | {
      readonly kind: "hold";
      readonly reason: string;
      readonly identityKey: string;
    };

const holdSchema = z.object({
  id: z.number().int().nonnegative(),
  active: z.boolean().optional(),
  identityKey: z.string().min(1),
  reason: z.string().min(1),
  severity: z.string().min(1),
  instrument: z.string().min(1),
  conId: z.string().nullable().optional(),
});

const runSchema = z.object({
  id: z.number().int().nonnegative(),
  accountId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum([
    "RUNNING",
    "CLEAN",
    "MISMATCH",
    "FAILED",
    "INCOMPLETE",
    "ABANDONED",
  ]),
  completedAt: z.union([z.string(), z.date()]).nullable().optional(),
  startedAt: z.union([z.string(), z.date()]),
  sourceCoverage: z.record(z.unknown()).optional(),
});

const latestSchema = z.object({
  accountId: z.string().nullable(),
  sessionId: z.string(),
  run: runSchema.nullable(),
  stale: z.boolean().nullable(),
  maxAgeSeconds: z.number().int().nonnegative().optional(),
});

const holdsSchema = z.object({
  accountId: z.string().nullable(),
  holds: z.array(holdSchema),
});

export interface ReconciliationReaderConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class ReconciliationReader {
  #cfg: ReconciliationReaderConfig;
  constructor(cfg: ReconciliationReaderConfig) {
    this.#cfg = cfg;
  }

  async checkInstrument(input: {
    readonly instrument: string;
    readonly conId?: string | null;
    /**
     * Full symbol-fallback identity fields; when neither `conId`
     * nor a COMPLETE fallback tuple is provided we fail-closed
     * with `unavailable` — we never build an identity key from
     * missing pieces.
     */
    readonly secType?: string | null;
    readonly exchange?: string | null;
    readonly currency?: string | null;
  }): Promise<ReconciliationSkipOutcome> {
    const [latest, holds] = await Promise.all([
      this.#fetchJson<z.infer<typeof latestSchema>>(
        "/execution/reconciliation/latest",
        latestSchema,
      ),
      this.#fetchJson<z.infer<typeof holdsSchema>>(
        "/execution/reconciliation/holds?active=true",
        holdsSchema,
      ),
    ]);

    if (latest.kind === "error" || holds.kind === "error") {
      return {
        kind: "unavailable",
        reason:
          latest.kind === "error" ? latest.reason : (holds as { reason: string }).reason,
      };
    }

    const run = latest.value.run;
    if (!run) {
      return {
        kind: "unavailable",
        reason: "reconciliation_never_ran_in_session",
      };
    }
    // Signal-engine does not know the execution-engine's session id.
    // The server exposes both the currently-active `latest.sessionId`
    // AND the run's `sessionId` — they must agree, else the latest
    // run is from a foreign session.
    if (run.sessionId !== latest.value.sessionId) {
      return { kind: "unavailable", reason: "reconciliation_wrong_session" };
    }
    if (run.status === "RUNNING")
      return { kind: "unavailable", reason: "reconciliation_running" };
    if (run.status === "FAILED")
      return { kind: "unavailable", reason: "reconciliation_failed" };
    if (run.status === "ABANDONED")
      return { kind: "unavailable", reason: "reconciliation_abandoned" };
    if (!exposureCompleteFromCoverage(run.sourceCoverage ?? {})) {
      return {
        kind: "unavailable",
        reason: "reconciliation_incomplete_exposure",
      };
    }
    if (latest.value.stale) return { kind: "stale" };

    const accountId = latest.value.accountId;
    if (!accountId) {
      return { kind: "unavailable", reason: "no_active_account" };
    }
    const identityKey = deriveIdentityKey(accountId, input);
    if (!identityKey) {
      return { kind: "unavailable", reason: "identity_incomplete" };
    }
    const hold = holds.value.holds.find(
      (h) => h.active !== false && h.identityKey === identityKey,
    );
    if (hold) {
      return { kind: "hold", reason: hold.reason, identityKey: hold.identityKey };
    }
    return { kind: "pass" };
  }

  async #fetchJson<T>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<
    | { readonly kind: "ok"; readonly value: T }
    | { readonly kind: "error"; readonly reason: string }
  > {
    const fetchImpl = this.#cfg.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.#cfg.timeoutMs ?? 5_000,
    );
    try {
      const res = await fetchImpl(this.#cfg.baseUrl + path, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#cfg.bearerToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        return { kind: "error", reason: `http_${res.status}` };
      }
      const json = (await res.json()) as unknown;
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return { kind: "error", reason: "malformed_body" };
      }
      return { kind: "ok", value: parsed.data };
    } catch (err) {
      return {
        kind: "error",
        reason: (err as Error).name === "AbortError" ? "timeout" : "transport",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function exposureCompleteFromCoverage(
  raw: Record<string, unknown>,
): boolean {
  const positions = source(raw.positions);
  const openOrders = source(raw.openOrders);
  const executions = executionsSource(raw.executions);
  const session = source(raw.session);
  return (
    positions.available &&
    positions.boundedWindow &&
    openOrders.available &&
    openOrders.boundedWindow &&
    executions.available &&
    executions.exposureWindowComplete &&
    session.available
  );
}

function source(raw: unknown): { available: boolean; boundedWindow: boolean } {
  if (!raw || typeof raw !== "object") {
    return { available: false, boundedWindow: false };
  }
  const r = raw as Record<string, unknown>;
  return {
    available: r.available === true,
    boundedWindow: r.boundedWindow === true,
  };
}
function executionsSource(raw: unknown): {
  available: boolean;
  exposureWindowComplete: boolean;
} {
  if (!raw || typeof raw !== "object") {
    return { available: false, exposureWindowComplete: false };
  }
  const r = raw as Record<string, unknown>;
  const window = (r.window as Record<string, unknown>) ?? {};
  return {
    available: r.available === true,
    exposureWindowComplete: window.exposureWindowComplete === true,
  };
}

function deriveIdentityKey(
  accountId: string,
  input: {
    readonly instrument: string;
    readonly conId?: string | null;
    readonly secType?: string | null;
    readonly exchange?: string | null;
    readonly currency?: string | null;
  },
): string | null {
  if (input.conId) return `conid:${accountId}|${input.conId}`;
  // Fallback requires the FULL trusted tuple — no partial keys.
  if (
    !input.secType?.trim() ||
    !input.exchange?.trim() ||
    !input.currency?.trim() ||
    !input.instrument?.trim()
  ) {
    return null;
  }
  return (
    "sym:" +
    accountId +
    "|" +
    input.instrument.toLowerCase() +
    "|" +
    input.secType.toLowerCase() +
    "|" +
    input.exchange.toLowerCase() +
    "|" +
    input.currency.toLowerCase()
  );
}
