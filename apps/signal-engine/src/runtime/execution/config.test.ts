import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildExecutionRuntimeConfig,
  executionRuntimeSchema,
} from "./config.js";

describe("executionRuntimeSchema", () => {
  it("defaults EXECUTION_RUNTIME_ENABLED to 'false' (write path OFF by default)", () => {
    const parsed = executionRuntimeSchema.parse({});
    assert.equal(parsed.EXECUTION_RUNTIME_ENABLED, "false");
    assert.equal(parsed.EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT, "paper");
    assert.equal(parsed.EXECUTION_RUNTIME_REQUEST_TIMEOUT_MS, 5000);
  });

  it('rejects EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT="live" (Live impossible via env)', () => {
    assert.throws(
      () =>
        executionRuntimeSchema.parse({
          EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT: "live",
        }),
      (err) => (err as Error).message.includes("Invalid literal"),
    );
  });

  it("rejects any non-paper value (paper, anything, else)", () => {
    for (const bad of ["PAPER", "Paper", "prod", "live", "sandbox", ""]) {
      assert.throws(() =>
        executionRuntimeSchema.parse({
          EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT: bad,
        }),
      );
    }
  });

  it("rejects timeout < 1000 ms", () => {
    assert.throws(() =>
      executionRuntimeSchema.parse({
        EXECUTION_RUNTIME_REQUEST_TIMEOUT_MS: "500",
      }),
    );
  });
});

describe("buildExecutionRuntimeConfig", () => {
  it("falls back to the provided base URL when EXECUTION_RUNTIME_ENGINE_URL is unset", () => {
    const env = executionRuntimeSchema.parse({});
    const config = buildExecutionRuntimeConfig({
      env,
      fallbackEngineUrl: "http://execution-engine:3103",
    });
    assert.equal(config.engineUrl, "http://execution-engine:3103");
    assert.equal(config.enabled, false);
    assert.equal(config.expectedEnvironment, "paper");
  });

  it("EXECUTION_RUNTIME_ENGINE_URL wins over the fallback when set", () => {
    const env = executionRuntimeSchema.parse({
      EXECUTION_RUNTIME_ENGINE_URL: "http://custom:9999",
    });
    const config = buildExecutionRuntimeConfig({
      env,
      fallbackEngineUrl: "http://execution-engine:3103",
    });
    assert.equal(config.engineUrl, "http://custom:9999");
  });

  it("enabled=true only when EXECUTION_RUNTIME_ENABLED is literally 'true'", () => {
    for (const value of ["TRUE", "True", "true"]) {
      const env = executionRuntimeSchema.parse({
        EXECUTION_RUNTIME_ENABLED: value,
      });
      const config = buildExecutionRuntimeConfig({
        env,
        fallbackEngineUrl: "http://x",
      });
      assert.equal(config.enabled, true, `case-insensitive: ${value}`);
    }
    for (const value of ["yes", "1", "on", "", " ", "TRUE "]) {
      const env = executionRuntimeSchema.parse({
        EXECUTION_RUNTIME_ENABLED: value,
      });
      const config = buildExecutionRuntimeConfig({
        env,
        fallbackEngineUrl: "http://x",
      });
      assert.equal(
        config.enabled,
        false,
        `${JSON.stringify(value)} MUST NOT enable writes`,
      );
    }
  });
});
