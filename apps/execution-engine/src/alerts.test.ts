import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldForwardToTelegram } from "./alerts.js";

describe("execution-engine alerts — Telegram routing", () => {
  it("CRITICAL bypasses ALERT_MIN_SEVERITY=error", () => {
    // The direct_ticket_used alert (severity=CRITICAL) MUST reach
    // Telegram even if the operator raised the filter to `error`.
    assert.equal(shouldForwardToTelegram("CRITICAL", "error"), true);
  });

  it("CRITICAL bypasses ALERT_MIN_SEVERITY=info", () => {
    assert.equal(shouldForwardToTelegram("CRITICAL", "info"), true);
  });

  it("CRITICAL bypasses ALERT_MIN_SEVERITY=warn (default)", () => {
    assert.equal(shouldForwardToTelegram("CRITICAL", "warn"), true);
  });

  it("warn is filtered when ALERT_MIN_SEVERITY=error", () => {
    assert.equal(shouldForwardToTelegram("warn", "error"), false);
  });

  it("error passes when ALERT_MIN_SEVERITY=warn", () => {
    assert.equal(shouldForwardToTelegram("error", "warn"), true);
  });

  it("info is filtered when ALERT_MIN_SEVERITY=warn", () => {
    assert.equal(shouldForwardToTelegram("info", "warn"), false);
  });

  it("info passes when ALERT_MIN_SEVERITY=info", () => {
    assert.equal(shouldForwardToTelegram("info", "info"), true);
  });
});
