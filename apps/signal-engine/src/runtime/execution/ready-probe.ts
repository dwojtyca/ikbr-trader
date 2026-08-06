/**
 * Execution Runtime — HTTP-backed `/ready` probe for the paper guard.
 *
 * Wraps a single GET on `execution-engine`'s public `/ready`
 * endpoint. `/ready` is a public path (no Bearer required per
 * `apps/execution-engine/src/index.ts`), so no auth token is sent.
 *
 * Errors NEVER throw — they map to `{ kind: "error", message }` so
 * `PaperGuard.check()` can fail-closed without leaking a raw
 * exception.
 */

import type { ReadyProbe } from "./paper-guard.js";

export interface HttpReadyProbeOptions {
  readonly engineUrl: string;
  readonly requestTimeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class HttpReadyProbe implements ReadyProbe {
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpReadyProbeOptions) {
    this.#url = options.engineUrl.replace(/\/$/, "");
    this.#timeoutMs = options.requestTimeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async probeReady(): ReturnType<ReadyProbe["probeReady"]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#url}/ready`, {
        method: "GET",
        signal: controller.signal,
      });
      // /ready returns 200 when ready and 503 when not. Both bodies
      // carry the full `ReadinessResponse`; we parse either way and
      // let the guard decide.
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object") {
        return { kind: "error", message: "/ready returned no JSON body" };
      }
      const body = parsed as {
        ready?: unknown;
        environment?: unknown;
        tradingEnabled?: unknown;
        checks?: { accountMatchesEnvironment?: unknown };
      };
      const environment = body.environment;
      if (environment !== "paper" && environment !== "live") {
        return {
          kind: "error",
          message: `/ready returned unexpected environment=${String(environment)}`,
        };
      }
      return {
        kind: "ok",
        ready: body.ready === true,
        environment,
        accountMatchesEnvironment:
          body.checks?.accountMatchesEnvironment === true,
        // PR15.3 Finding 1 — surface the administrative write switch
        // (`TRADING_ENABLED`) from execution-engine so `PaperGuard`
        // fails-closed BEFORE the submitter contacts the write path.
        // The switch does NOT block risk-reducing endpoints (cancel
        // + reconciliation) — those retain a separate audited path.
        // Only literal `true` opens the gate here; any other shape
        // (missing, null, string) becomes `undefined` and the guard
        // treats it as unknown.
        tradingEnabled:
          body.tradingEnabled === true
            ? true
            : body.tradingEnabled === false
              ? false
              : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        message: /aborted/i.test(message)
          ? `execution-engine /ready timed out after ${this.#timeoutMs}ms`
          : `execution-engine /ready failed: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
