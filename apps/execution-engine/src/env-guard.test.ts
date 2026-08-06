import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EnvironmentGuardError,
  assertActiveAccountAllowed,
  assertEnvironmentAllowsWrite,
  assertTradingEnabled,
  whitelistForEnvironment,
} from "./env-guard.js";

const paperBase = {
  environment: "paper" as const,
  // PR15.3 r6 hostile-review — `TRADING_ENABLED` is an
  // administrative write switch that blocks operations that create or
  // expand broker exposure (e.g. `execute-ticket`,
  // `execute-proposed/:id`, `bootstrap`,
  // `refresh-position-snapshot`). A closed exempt-routes list
  // (`write-guard-exemptions.ts` — `cancel-proposed/:id` plus the
  // reconciliation operator surface) stays reachable while writes
  // are administratively paused, gated by bearer + audit + account
  // allowlist + known-account requirement. `paperBase` therefore
  // represents an OPERATIONAL paper deploy (writes allowed);
  // `paper_trading_disabled` is exercised via
  // `{ ...paperBase, tradingEnabled: false }` below.
  tradingEnabled: true,
  allowedPaperAccounts: ["DU1234567"],
  allowedLiveAccounts: [] as readonly string[],
};

const liveBase = {
  environment: "live" as const,
  tradingEnabled: true,
  allowedPaperAccounts: [] as readonly string[],
  allowedLiveAccounts: ["U1234567", "U7654321"],
};

describe("execution-engine env-guard", () => {
  describe("assertEnvironmentAllowsWrite — happy paths", () => {
    it("paper + trading enabled + whitelisted account → allows", () => {
      assert.doesNotThrow(() =>
        assertEnvironmentAllowsWrite(paperBase, "DU1234567"),
      );
    });

    it("paper + trading enabled + null account → allows (bootstrap not yet done)", () => {
      // The account whitelist is enforced later by ensureBrokerSession
      // when it actually resolves the managed account. The pre-check
      // still fires the trading-enabled gate; whitelist is deferred.
      assert.doesNotThrow(() =>
        assertEnvironmentAllowsWrite(paperBase, null),
      );
    });

    it("live + trading enabled + whitelisted account → allows", () => {
      assert.doesNotThrow(() =>
        assertEnvironmentAllowsWrite(liveBase, "U1234567"),
      );
    });

    it("live + trading enabled + null account → allows (bootstrap phase)", () => {
      assert.doesNotThrow(() =>
        assertEnvironmentAllowsWrite(liveBase, null),
      );
    });
  });

  describe("assertEnvironmentAllowsWrite — denials", () => {
    it("live + TRADING_ENABLED=false → 423 live_trading_disabled", () => {
      try {
        assertEnvironmentAllowsWrite(
          { ...liveBase, tradingEnabled: false },
          "U1234567",
        );
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.statusCode, 423);
        assert.equal(err.reason, "live_trading_disabled");
        assert.match(err.message, /TRADING_ENABLED=false/);
      }
    });

    it("live + TRADING_ENABLED=false fires BEFORE account check", () => {
      // Precedence test: even a whitelisted account cannot force the
      // guard through when trading is administratively disabled.
      try {
        assertEnvironmentAllowsWrite(
          { ...liveBase, tradingEnabled: false },
          "U1234567", // in whitelist, still rejected
        );
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "live_trading_disabled");
      }
    });

    it("PR15.3 — paper + TRADING_ENABLED=false → 423 paper_trading_disabled", () => {
      // Finding 1 regression test: before PR15.3 the Paper branch did
      // NOT consult `tradingEnabled` and a Paper `execute-ticket` would
      // reach the broker even with the administrative switch off. Now
      // both environments MUST reject on `TRADING_ENABLED=false`.
      try {
        assertEnvironmentAllowsWrite(
          { ...paperBase, tradingEnabled: false },
          "DU1234567", // whitelisted paper account
        );
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.statusCode, 423);
        assert.equal(err.reason, "paper_trading_disabled");
        assert.match(err.message, /TRADING_ENABLED=false/);
        // PR15.3 r5 — the message MUST NOT claim the switch blocks
        // every mutating request; the closed exempt-routes list keeps
        // risk-reducing paths available. The updated message
        // references the exempt list explicitly.
        assert.match(err.message, /cancel-proposed/);
        assert.match(err.message, /account-allowlist/);
        assert.doesNotMatch(err.message, /master kill switch/i);
      }
    });

    it("PR15.3 — paper + TRADING_ENABLED=false fires BEFORE account check", () => {
      // Even with a whitelisted paper account, the kill switch must
      // win. Symmetric to the live precedence test above.
      try {
        assertEnvironmentAllowsWrite(
          { ...paperBase, tradingEnabled: false },
          "DU1234567",
        );
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "paper_trading_disabled");
      }
    });

    it("PR15.3 — paper + TRADING_ENABLED=false + null account → still 423 paper_trading_disabled", () => {
      // Bootstrap-phase null account MUST NOT bypass the kill switch.
      try {
        assertEnvironmentAllowsWrite(
          { ...paperBase, tradingEnabled: false },
          null,
        );
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "paper_trading_disabled");
      }
    });

    it("live + trading enabled + account NOT whitelisted → 423 account_not_allowed_for_live", () => {
      try {
        assertEnvironmentAllowsWrite(liveBase, "U9999999");
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.statusCode, 423);
        assert.equal(err.reason, "account_not_allowed_for_live");
        assert.match(err.message, /U9999999/);
      }
    });

    it("paper + trading enabled + account NOT whitelisted → 423 account_not_allowed_for_paper", () => {
      try {
        assertEnvironmentAllowsWrite(paperBase, "DU9999999");
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.statusCode, 423);
        assert.equal(err.reason, "account_not_allowed_for_paper");
      }
    });

    it("paper + account belongs to LIVE whitelist → still rejected", () => {
      // Cross-list contamination check: a live account ID accidentally
      // routed to paper env must NOT pass just because it exists in
      // some whitelist.
      try {
        assertEnvironmentAllowsWrite(
          {
            ...paperBase,
            allowedLiveAccounts: ["U1234567"],
          },
          "U1234567",
        );
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "account_not_allowed_for_paper");
      }
    });

    it("live + account belongs to PAPER whitelist → still rejected", () => {
      try {
        assertEnvironmentAllowsWrite(
          {
            ...liveBase,
            allowedPaperAccounts: ["DU1234567"],
          },
          "DU1234567",
        );
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "account_not_allowed_for_live");
      }
    });
  });

  describe("assertEnvironmentAllowsWrite — port irrelevance (ADR-001 §3.2)", () => {
    it("does not look at any port field — accepts any config with valid env+account", () => {
      // The guard has NO port input. Passing a paper account through
      // paper environment MUST succeed regardless of what socket port
      // the process might be talking to (paper-4002 or live-4001).
      // Regression test: never re-introduce port-based inference.
      assert.doesNotThrow(() =>
        assertEnvironmentAllowsWrite(paperBase, "DU1234567"),
      );
      assert.doesNotThrow(() =>
        assertEnvironmentAllowsWrite(liveBase, "U1234567"),
      );
    });
  });

  describe("whitelistForEnvironment", () => {
    it("returns paper whitelist in paper env", () => {
      assert.deepEqual(
        [...whitelistForEnvironment(paperBase)],
        ["DU1234567"],
      );
    });

    it("returns live whitelist in live env", () => {
      assert.deepEqual(
        [...whitelistForEnvironment(liveBase)],
        ["U1234567", "U7654321"],
      );
    });
  });

  describe("EnvironmentGuardError", () => {
    it("carries statusCode=423 and preserves reason", () => {
      const err = new EnvironmentGuardError("live_trading_disabled", "x");
      assert.equal(err.statusCode, 423);
      assert.equal(err.reason, "live_trading_disabled");
      assert.equal(err.name, "EnvironmentGuardError");
    });
  });

  // PR15.3 r4 hostile-review Finding 1 — the composite check was
  // decomposed into two helpers so the closed exempt-routes list can
  // bypass ONLY `assertTradingEnabled` while still running
  // `assertActiveAccountAllowed`.
  describe("assertTradingEnabled — pure administrative write switch", () => {
    it("paper + tradingEnabled=true → allows", () => {
      assert.doesNotThrow(() => assertTradingEnabled(paperBase));
    });
    it("live + tradingEnabled=true → allows", () => {
      assert.doesNotThrow(() => assertTradingEnabled(liveBase));
    });
    it("paper + tradingEnabled=false → paper_trading_disabled", () => {
      try {
        assertTradingEnabled({ ...paperBase, tradingEnabled: false });
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "paper_trading_disabled");
      }
    });
    it("live + tradingEnabled=false → live_trading_disabled", () => {
      try {
        assertTradingEnabled({ ...liveBase, tradingEnabled: false });
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "live_trading_disabled");
      }
    });
    it("does NOT consult the account allowlist or activeAccountId", () => {
      // Signature is `(cfg)` — the account is deliberately not an
      // input. A regression that adds an account param here would
      // couple the switch check with whitelist verification and
      // undermine the exempt-routes bypass semantics.
      assert.doesNotThrow(() =>
        assertTradingEnabled({
          ...paperBase,
          allowedPaperAccounts: [],
          allowedLiveAccounts: [],
        }),
      );
    });
  });

  describe("assertActiveAccountAllowed — environment + whitelist (r4)", () => {
    it("paper + whitelisted account → allows (requireKnownAccount default false)", () => {
      assert.doesNotThrow(() =>
        assertActiveAccountAllowed(paperBase, "DU1234567"),
      );
    });
    it("paper + null account (bootstrap) → allows by default", () => {
      assert.doesNotThrow(() =>
        assertActiveAccountAllowed(paperBase, null),
      );
    });
    it("paper + null account + requireKnownAccount=true → no_active_account_for_exempt_route", () => {
      try {
        assertActiveAccountAllowed(paperBase, null, {
          requireKnownAccount: true,
        });
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "no_active_account_for_exempt_route");
        assert.match(err.message, /No active broker account resolved/);
      }
    });
    it("paper + wrong account → account_not_allowed_for_paper", () => {
      try {
        assertActiveAccountAllowed(paperBase, "DU9999999");
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "account_not_allowed_for_paper");
      }
    });
    it("live + wrong account → account_not_allowed_for_live (even under requireKnownAccount)", () => {
      try {
        assertActiveAccountAllowed(liveBase, "U9999999", {
          requireKnownAccount: true,
        });
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "account_not_allowed_for_live");
      }
    });
    it("does NOT consult `tradingEnabled` (kill switch stays orthogonal)", () => {
      // A cfg with tradingEnabled=false MUST still allow a whitelisted
      // account — that is the invariant the exempt-routes list relies
      // on to let cancel-proposed reach its handler while writes are
      // administratively paused.
      assert.doesNotThrow(() =>
        assertActiveAccountAllowed(
          { ...paperBase, tradingEnabled: false },
          "DU1234567",
        ),
      );
    });
  });

  describe("assertEnvironmentAllowsWrite — composed behaviour (r4)", () => {
    it("still throws paper_trading_disabled BEFORE the account check", () => {
      try {
        assertEnvironmentAllowsWrite(
          { ...paperBase, tradingEnabled: false },
          "DU9999999", // wrong account, but switch check fires first
        );
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "paper_trading_disabled");
      }
    });
    it("throws account_not_allowed_for_paper when switch is on but account is wrong", () => {
      try {
        assertEnvironmentAllowsWrite(paperBase, "DU9999999");
        assert.fail("expected throw");
      } catch (err) {
        assert.ok(err instanceof EnvironmentGuardError);
        assert.equal(err.reason, "account_not_allowed_for_paper");
      }
    });
    it("bootstrap-phase null account → still allowed (delegates to ensureBrokerSession)", () => {
      // Regression: r4 must NOT tighten the normal write path to
      // require a known account, only the exempt-routes path.
      assert.doesNotThrow(() =>
        assertEnvironmentAllowsWrite(paperBase, null),
      );
    });
  });
});
