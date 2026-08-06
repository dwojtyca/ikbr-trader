/**
 * Execution Runtime — paper-only guard.
 *
 * Before every submission the runtime calls execution-engine's
 * `/ready` and verifies that:
 *
 *   1. execution-engine reports `environment === "paper"` — this
 *      matches the runtime's `EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT`
 *      literal.
 *   2. execution-engine reports `ready === true`.
 *   3. the account, if known, matches the paper whitelist
 *      (`accountMatchesEnvironment === true`).
 *   4. PR15.3 Finding 1 — execution-engine reports
 *      `tradingEnabled === true`. The authoritative kill-switch
 *      block lives inside `assertEnvironmentAllowsWrite` on the
 *      write path; this early-signal check keeps the trading-loop
 *      from spending pipeline cycles / snapshot reads / audit
 *      writes on a request the server would refuse with 423 anyway.
 *
 * Any negative signal → the guard REFUSES; the runtime reports
 * `NOT_SUBMITTED / PAPER_GUARD_FAILED` and NEVER dispatches the
 * ticket. A future live PR must replace this guard, not weaken it.
 *
 * The guard is deliberately network-side (an extra HTTP call per
 * submission) rather than trusting local config alone — the
 * execution-engine's env is the authoritative source, and it can be
 * changed independently of the runtime.
 */

export interface PaperGuardResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface ReadyProbe {
  probeReady(): Promise<
    | {
        readonly kind: "ok";
        readonly ready: boolean;
        readonly environment: "paper" | "live";
        readonly accountMatchesEnvironment: boolean;
        /**
         * PR15.3 Finding 1 — mirror of `ReadinessResponse.tradingEnabled`.
         * Optional so pre-existing test doubles that predate the
         * hostile-review fix keep compiling; `PaperGuard` treats
         * `undefined` as "unknown" and fails-closed.
         */
        readonly tradingEnabled?: boolean;
      }
    | {
        readonly kind: "error";
        readonly message: string;
      }
  >;
}

export interface PaperGuardOptions {
  readonly probe: ReadyProbe;
  readonly expectedEnvironment: "paper";
}

export class PaperGuard {
  readonly #probe: ReadyProbe;
  readonly #expected: "paper";

  constructor(options: PaperGuardOptions) {
    if (!options?.probe || typeof options.probe.probeReady !== "function") {
      throw new Error("PaperGuard: probe with probeReady() is required");
    }
    if (options.expectedEnvironment !== "paper") {
      // Defensive re-check on top of the config-level literal —
      // this is the last chance to catch a misconfigured runtime
      // before an order is submitted.
      throw new Error(
        `PaperGuard: expectedEnvironment must be "paper", got "${String(
          options.expectedEnvironment,
        )}"`,
      );
    }
    this.#probe = options.probe;
    this.#expected = options.expectedEnvironment;
  }

  async check(): Promise<PaperGuardResult> {
    const result = await this.#probe.probeReady();
    if (result.kind === "error") {
      return {
        ok: false,
        reason: `execution-engine /ready probe failed: ${result.message}`,
      };
    }
    if (result.environment !== this.#expected) {
      return {
        ok: false,
        reason: `execution-engine reports environment="${result.environment}", expected "${this.#expected}"`,
      };
    }
    if (!result.ready) {
      return {
        ok: false,
        reason: "execution-engine /ready is not ready",
      };
    }
    if (!result.accountMatchesEnvironment) {
      return {
        ok: false,
        reason:
          "execution-engine active account does not match the paper whitelist",
      };
    }
    // PR15.3 Finding 1 — kill-switch cross-check. `undefined` is
    // treated as "unknown" and fails-closed so a probe implementation
    // that predates this field cannot silently strip the check.
    if (result.tradingEnabled !== true) {
      return {
        ok: false,
        reason:
          result.tradingEnabled === false
            ? "execution-engine reports tradingEnabled=false (TRADING_ENABLED=false — administrative kill switch)"
            : "execution-engine /ready did not report tradingEnabled — refusing to submit",
      };
    }
    return { ok: true };
  }
}
