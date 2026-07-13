import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EnvironmentGuardError,
  assertEnvironmentAllowsWrite,
  whitelistForEnvironment,
} from "./env-guard.js";

const paperBase = {
  environment: "paper" as const,
  tradingEnabled: false,
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
    it("paper + whitelisted account → allows", () => {
      assert.doesNotThrow(() =>
        assertEnvironmentAllowsWrite(paperBase, "DU1234567"),
      );
    });

    it("paper + null account → allows (bootstrap not yet done)", () => {
      // The account whitelist is enforced later by ensureBrokerSession
      // when it actually resolves the managed account. The pre-check
      // only fails on structural policy (live_trading_disabled).
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

    it("paper + account NOT whitelisted → 423 account_not_allowed_for_paper", () => {
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
});
