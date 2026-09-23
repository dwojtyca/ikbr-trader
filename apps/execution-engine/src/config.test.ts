import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";

import { buildExecutionConfig } from "./config.js";

// Long test token (>=32 chars) mimicking `openssl rand -hex 32`.
const VALID_TOKEN = "a".repeat(64);

/**
 * Minimal env object that yields a valid Paper-mode config with
 * TRADING_ENABLED=false. Individual tests spread this and override
 * the fields relevant to the scenario under test.
 */
const paperBase: NodeJS.ProcessEnv = {
  IBKR_ENVIRONMENT: "paper",
  TRADING_ENABLED: "false",
  ALLOWED_PAPER_ACCOUNTS: "DU1234567",
  ALLOWED_LIVE_ACCOUNTS: "",
  EXECUTION_BIND_HOST: "127.0.0.1",
  EXECUTION_ALLOW_MKT: "false",
  EXECUTION_ALLOW_DIRECT_TICKET: "false",
};

describe("execution-engine config (Phase 1 / PR1)", () => {
  describe("happy paths", () => {
    it("parses paper defaults with trading disabled", () => {
      const cfg = buildExecutionConfig({ ...paperBase });
      assert.equal(cfg.IBKR_ENVIRONMENT, "paper");
      assert.equal(cfg.tradingEnabled, false);
      assert.equal(cfg.allowMkt, false);
      assert.equal(cfg.allowDirectTicket, false);
      assert.equal(cfg.EXECUTION_BIND_HOST, "127.0.0.1");
      assert.deepEqual([...cfg.allowedPaperAccounts], ["DU1234567"]);
      assert.deepEqual([...cfg.allowedLiveAccounts], []);
      assert.deepEqual(
        [...cfg.allowedAccountsForEnvironment()],
        ["DU1234567"],
      );
    });

    it("accepts live environment with valid token and non-empty whitelist", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        IBKR_ENVIRONMENT: "live",
        TRADING_ENABLED: "true",
        ALLOWED_LIVE_ACCOUNTS: "U1234567,U7654321",
        EXECUTION_API_TOKEN: VALID_TOKEN,
      });
      assert.equal(cfg.IBKR_ENVIRONMENT, "live");
      assert.equal(cfg.tradingEnabled, true);
      assert.deepEqual(
        [...cfg.allowedLiveAccounts],
        ["U1234567", "U7654321"],
      );
      assert.deepEqual(
        [...cfg.allowedAccountsForEnvironment()],
        ["U1234567", "U7654321"],
      );
    });

    it("accepts paper + TRADING_ENABLED=true when token is valid (dev override)", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        TRADING_ENABLED: "true",
        EXECUTION_API_TOKEN: VALID_TOKEN,
      });
      assert.equal(cfg.tradingEnabled, true);
      assert.equal(cfg.IBKR_ENVIRONMENT, "paper");
    });

    it("parses feature flags when set to exact 'true'", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        EXECUTION_ALLOW_MKT: "true",
        EXECUTION_ALLOW_DIRECT_TICKET: "true",
      });
      assert.equal(cfg.allowMkt, true);
      assert.equal(cfg.allowDirectTicket, true);
    });

    it("trims and dedups CSV whitespace in whitelists", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        ALLOWED_PAPER_ACCOUNTS: " DU1 , DU2 ,,DU3 ",
      });
      assert.deepEqual([...cfg.allowedPaperAccounts], ["DU1", "DU2", "DU3"]);
    });
  });

  describe("live/trading validation", () => {
    it("rejects live without EXECUTION_API_TOKEN", () => {
      assert.throws(
        () =>
          buildExecutionConfig({
            ...paperBase,
            IBKR_ENVIRONMENT: "live",
            ALLOWED_LIVE_ACCOUNTS: "U1234567",
          }),
        (err: unknown) => {
          assert.ok(err instanceof ZodError);
          assert.ok(
            err.issues.some(
              (i) =>
                i.path.includes("EXECUTION_API_TOKEN") &&
                i.message.includes("32 characters"),
            ),
            `Expected EXECUTION_API_TOKEN issue, got: ${JSON.stringify(err.issues)}`,
          );
          return true;
        },
      );
    });

    it("rejects live with too-short EXECUTION_API_TOKEN", () => {
      assert.throws(
        () =>
          buildExecutionConfig({
            ...paperBase,
            IBKR_ENVIRONMENT: "live",
            ALLOWED_LIVE_ACCOUNTS: "U1234567",
            EXECUTION_API_TOKEN: "short-token",
          }),
        (err: unknown) => {
          assert.ok(err instanceof ZodError);
          assert.ok(
            err.issues.some((i) =>
              i.path.includes("EXECUTION_API_TOKEN"),
            ),
          );
          return true;
        },
      );
    });

    it("rejects live with empty ALLOWED_LIVE_ACCOUNTS", () => {
      assert.throws(
        () =>
          buildExecutionConfig({
            ...paperBase,
            IBKR_ENVIRONMENT: "live",
            ALLOWED_LIVE_ACCOUNTS: "",
            EXECUTION_API_TOKEN: VALID_TOKEN,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ZodError);
          assert.ok(
            err.issues.some((i) =>
              i.path.includes("ALLOWED_LIVE_ACCOUNTS"),
            ),
          );
          return true;
        },
      );
    });

    it("rejects paper + TRADING_ENABLED=true without token", () => {
      assert.throws(
        () =>
          buildExecutionConfig({
            ...paperBase,
            TRADING_ENABLED: "true",
          }),
        (err: unknown) => {
          assert.ok(err instanceof ZodError);
          assert.ok(
            err.issues.some((i) =>
              i.path.includes("EXECUTION_API_TOKEN"),
            ),
          );
          return true;
        },
      );
    });

    it("rejects invalid IBKR_ENVIRONMENT value", () => {
      assert.throws(
        () =>
          buildExecutionConfig({
            ...paperBase,
            IBKR_ENVIRONMENT: "prod",
          }),
        (err: unknown) => err instanceof ZodError,
      );
    });
  });

  describe("EXECUTION_READY_RECONCILIATION_MAX_AGE_S", () => {
    it("uses default 900 seconds when unset", () => {
      const cfg = buildExecutionConfig({ ...paperBase });
      assert.equal(cfg.EXECUTION_READY_RECONCILIATION_MAX_AGE_S, 900);
    });

    it("coerces string to number", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        EXECUTION_READY_RECONCILIATION_MAX_AGE_S: "60",
      });
      assert.equal(cfg.EXECUTION_READY_RECONCILIATION_MAX_AGE_S, 60);
    });
  });

  describe("account whitelist parsing", () => {
    it("parses ALLOWED_PAPER_ACCOUNTS as CSV", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        ALLOWED_PAPER_ACCOUNTS: "DU1,DU2,DU3",
      });
      assert.deepEqual([...cfg.allowedPaperAccounts], ["DU1", "DU2", "DU3"]);
    });

    it("parses ALLOWED_LIVE_ACCOUNTS as CSV", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        IBKR_ENVIRONMENT: "live",
        TRADING_ENABLED: "false",
        ALLOWED_LIVE_ACCOUNTS: "U1,U2,U3",
        EXECUTION_API_TOKEN: VALID_TOKEN,
      });
      assert.deepEqual([...cfg.allowedLiveAccounts], ["U1", "U2", "U3"]);
    });

    it("returns empty readonly array when the whitelist env is empty", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        ALLOWED_PAPER_ACCOUNTS: "",
      });
      assert.deepEqual([...cfg.allowedPaperAccounts], []);
    });

    it("allowedAccountsForEnvironment() returns paper list in paper env", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        IBKR_ENVIRONMENT: "paper",
        ALLOWED_PAPER_ACCOUNTS: "DU_A,DU_B",
        ALLOWED_LIVE_ACCOUNTS: "U_X,U_Y",
      });
      assert.deepEqual(
        [...cfg.allowedAccountsForEnvironment()],
        ["DU_A", "DU_B"],
      );
    });

    it("allowedAccountsForEnvironment() returns live list in live env", () => {
      const cfg = buildExecutionConfig({
        ...paperBase,
        IBKR_ENVIRONMENT: "live",
        ALLOWED_PAPER_ACCOUNTS: "DU_A,DU_B",
        ALLOWED_LIVE_ACCOUNTS: "U_X,U_Y",
        EXECUTION_API_TOKEN: VALID_TOKEN,
      });
      assert.deepEqual(
        [...cfg.allowedAccountsForEnvironment()],
        ["U_X", "U_Y"],
      );
    });
  });

  describe("defaults", () => {
    // Empty env should yield a fully-populated Paper-mode config.
    // Ensures no required field is silently missing a default that would
    // later blow up at runtime.
    it("empty env yields paper defaults with trading disabled", () => {
      const cfg = buildExecutionConfig({});
      assert.equal(cfg.IBKR_ENVIRONMENT, "paper");
      assert.equal(cfg.TRADING_ENABLED, "false");
      assert.equal(cfg.tradingEnabled, false);
      assert.equal(cfg.EXECUTION_ALLOW_MKT, "false");
      assert.equal(cfg.allowMkt, false);
      assert.equal(cfg.EXECUTION_ALLOW_DIRECT_TICKET, "false");
      assert.equal(cfg.allowDirectTicket, false);
      assert.equal(cfg.EXECUTION_BIND_HOST, "127.0.0.1");
      assert.equal(cfg.EXECUTION_READY_RECONCILIATION_MAX_AGE_S, 900);
      assert.deepEqual([...cfg.allowedPaperAccounts], []);
      assert.deepEqual([...cfg.allowedLiveAccounts], []);
    });
  });

  describe("strict boolean parsing", () => {
    // Any non-'true'/'false' string must fail the schema. This closes the
    // long-running class of bugs where 'True', 'TRUE', 'yes', '1', ' ' or
    // an empty string silently coerce to `false` and disable a safety
    // check the operator believed to be active.
    const booleanKeys = [
      "TRADING_ENABLED",
      "EXECUTION_ALLOW_MKT",
      "EXECUTION_ALLOW_DIRECT_TICKET",
    ] as const;

    const badValues = [
      "True",
      "TRUE",
      "treu",
      "yes",
      "1",
      "0",
      "",
      " ",
      "on",
      "off",
    ];

    for (const key of booleanKeys) {
      for (const bad of badValues) {
        it(`rejects ${key}='${bad}'`, () => {
          assert.throws(
            () =>
              buildExecutionConfig({
                ...paperBase,
                EXECUTION_API_TOKEN: VALID_TOKEN,
                [key]: bad,
              }),
            (err: unknown) => {
              assert.ok(err instanceof ZodError);
              assert.ok(
                err.issues.some((i) => i.path.includes(key)),
                `Expected issue on ${key}, got: ${JSON.stringify(err.issues)}`,
              );
              return true;
            },
          );
        });
      }

      it(`accepts ${key}='true'`, () => {
        const cfg = buildExecutionConfig({
          ...paperBase,
          EXECUTION_API_TOKEN: VALID_TOKEN,
          [key]: "true",
        });
        // Just ensure it parses; per-flag semantics tested elsewhere.
        assert.equal((cfg as Record<string, unknown>)[key], "true");
      });

      it(`accepts ${key}='false'`, () => {
        const cfg = buildExecutionConfig({
          ...paperBase,
          [key]: "false",
        });
        assert.equal((cfg as Record<string, unknown>)[key], "false");
      });
    }
  });
});

describe("broker execution timestamp timezone declaration", () => {
  it("does not infer UTC when unset or empty", () => {
    assert.equal(buildExecutionConfig(paperBase).EXECUTION_BROKER_TIME_ZONE, undefined);
    assert.equal(buildExecutionConfig({ ...paperBase, EXECUTION_BROKER_TIME_ZONE: "" }).EXECUTION_BROKER_TIME_ZONE, undefined);
  });
  it("accepts an explicit UTC declaration", () => {
    assert.equal(buildExecutionConfig({ ...paperBase, EXECUTION_BROKER_TIME_ZONE: "UTC" }).EXECUTION_BROKER_TIME_ZONE, "UTC");
  });
  it("rejects unsupported timezone assumptions", () => {
    for (const zone of ["America/New_York", "local", "GMT", "utc"])
      assert.throws(() => buildExecutionConfig({ ...paperBase, EXECUTION_BROKER_TIME_ZONE: zone }), ZodError);
  });
});

describe("GPW1 server-owned PLN risk limits", () => {
  it("provides conservative defaults without enabling trading", () => {
    const config = buildExecutionConfig(paperBase);
    assert.equal(config.EXECUTION_AI_MAX_NOTIONAL_PLN, 500);
    assert.equal(config.EXECUTION_AI_MAX_STOP_RISK_PLN, 5);
    assert.equal(config.EXECUTION_AI_FEE_RESERVE_PLN, 30);
    assert.equal(config.tradingEnabled, false);
  });
  for (const key of ["EXECUTION_AI_MAX_NOTIONAL_PLN", "EXECUTION_AI_MAX_STOP_RISK_PLN", "EXECUTION_AI_FEE_RESERVE_PLN"]) {
    for (const value of ["0", "-1", "NaN", "Infinity", "", " "]) {
      it(`rejects ${key}=${JSON.stringify(value)}`, () => {
        assert.throws(() => buildExecutionConfig({ ...paperBase, [key]: value }), ZodError);
      });
    }
  }
});

describe("read-only broker metadata client ID", () => {
  it("defaults to a dedicated ID", () => {
    assert.equal(buildExecutionConfig({}).IB_METADATA_CLIENT_ID, 119);
  });
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "2147483648", ""]) {
    it(`rejects invalid metadata ID ${JSON.stringify(value)}`, () => {
      assert.throws(() => buildExecutionConfig({ IB_METADATA_CLIENT_ID: value }), ZodError);
    });
  }
  for (const key of ["EXECUTION_CLIENT_ID", "INGESTION_CLIENT_ID", "BACKTEST_INGESTION_CLIENT_ID", "IBKR_ES_ACQUISITION_CLIENT_ID"]) {
    it(`rejects collision with ${key}`, () => {
      assert.throws(() => buildExecutionConfig({ IB_METADATA_CLIENT_ID: "119", [key]: "119" }), /must differ/);
    });
  }
  for (const id of ["101", "102", "104"]) {
    it(`rejects collision with default service ID ${id}`, () => {
      assert.throws(() => buildExecutionConfig({ IB_METADATA_CLIENT_ID: id }), /must differ/);
    });
  }
});
