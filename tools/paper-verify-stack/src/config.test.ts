import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.js";

const T = { PAPER_VERIFY_EXECUTION_TOKEN: "tok-abcdefghijklmnopqrstuv-1234" };

describe("config parser", () => {
  it("returns defaults for env with token", () => {
    const r = parseConfig({ ...T });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.config.ingestionUrl, "http://127.0.0.1:3101");
    assert.equal(r.config.runtimeExpected, "registered");
    assert.equal(r.config.executionRuntimeExpected, "absent");
    assert.equal(r.config.tradingLoopExpected, "absent");
    assert.equal(r.config.includeAccountSummary, false);
    assert.equal(r.config.executionToken, T.PAPER_VERIFY_EXECUTION_TOKEN);
  });

  it("empty token → CONFIG_ERROR / execution_token_missing", () => {
    const r = parseConfig({});
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "execution_token_missing");
  });

  it("rejects non-loopback URLs unless explicitly allowed", () => {
    const bad = parseConfig({
      ...T,
      PAPER_VERIFY_INGESTION_URL: "http://ingestion.internal:3101",
    });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.match(bad.reason, /url_not_loopback:ingestion/);
    const ok = parseConfig({
      ...T,
      PAPER_VERIFY_INGESTION_URL: "http://ingestion.internal:3101",
      PAPER_VERIFY_ALLOW_NON_LOOPBACK: "true",
    });
    assert.equal(ok.ok, true);
  });

  it("rejects URLs carrying credentials", () => {
    const r = parseConfig({
      ...T,
      PAPER_VERIFY_INGESTION_URL: "http://user:pass@127.0.0.1:3101",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /url_carries_credentials:ingestion/);
  });

  it("rejects execution runtime registered without runtime registered", () => {
    const r = parseConfig({
      ...T,
      PAPER_VERIFY_RUNTIME_EXPECTED_STATE: "absent",
      PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "registered",
      PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "disabled",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "execution_runtime_requires_runtime");
  });

  it("rejects trading-loop enabled without execution runtime", () => {
    const r = parseConfig({
      ...T,
      PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "absent",
      PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "enabled",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "trading_loop_requires_execution_runtime");
  });

  it("rejects trading-loop absent when execution runtime registered", () => {
    const r = parseConfig({
      ...T,
      PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "registered",
      PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "absent",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(
      r.reason,
      "trading_loop_endpoints_always_registered_with_execution_runtime",
    );
  });

  it("accepts the four allowed combinations", () => {
    const combos: Array<{
      runtime: "registered" | "absent";
      exec: "registered" | "absent";
      loop: "enabled" | "disabled" | "absent";
    }> = [
      { runtime: "absent", exec: "absent", loop: "absent" },
      { runtime: "registered", exec: "absent", loop: "absent" },
      { runtime: "registered", exec: "registered", loop: "enabled" },
      { runtime: "registered", exec: "registered", loop: "disabled" },
    ];
    for (const c of combos) {
      const r = parseConfig({
        ...T,
        PAPER_VERIFY_RUNTIME_EXPECTED_STATE: c.runtime,
        PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: c.exec,
        PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: c.loop,
      });
      assert.equal(r.ok, true, `combo ${JSON.stringify(c)} should be ok`);
    }
  });

  it("prefers PAPER_VERIFY_EXECUTION_TOKEN over EXECUTION_API_TOKEN", () => {
    const r = parseConfig({
      PAPER_VERIFY_EXECUTION_TOKEN: "prefer-me",
      EXECUTION_API_TOKEN: "fallback",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.config.executionToken, "prefer-me");
  });

  it("falls back to EXECUTION_API_TOKEN when PAPER_VERIFY_EXECUTION_TOKEN empty", () => {
    const r = parseConfig({
      PAPER_VERIFY_EXECUTION_TOKEN: "",
      EXECUTION_API_TOKEN: "fallback",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.config.executionToken, "fallback");
  });

  it("--json flag is captured", () => {
    const r = parseConfig({ ...T }, ["--json"]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.config.json, true);
  });
});
