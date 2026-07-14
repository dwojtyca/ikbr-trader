import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateReadiness } from "./readiness.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");

const baseInputs = {
  now: NOW,
  environment: "paper" as const,
  tradingEnabled: true,
  brokerSocketUp: true,
  activeAccountId: "DU1234567",
  accountAllowedByEnvironment: true,
  auditWriteAvailable: true,
  lastReconciliationAt: new Date(NOW.getTime() - 60_000), // 60s ago
  reconciliationMaxAgeSeconds: 900,
  // PR14 round-7 blocker — broker-driven snapshot refresher
  // health. Happy-path baseline treats the account as healthy;
  // dedicated tests below vary this field.
  positionSnapshotHealth: { kind: "healthy" as const },
};

describe("execution-engine readiness", () => {
  describe("happy paths", () => {
    it("returns 200 ready:true when every check passes", () => {
      const result = evaluateReadiness(baseInputs);
      assert.equal(result.statusCode, 200);
      assert.equal(result.body.ready, true);
      assert.equal(result.body.reasons.length, 0);
      assert.equal(result.body.checks.brokerSocket, true);
      assert.equal(result.body.checks.accountMatchesEnvironment, true);
      assert.equal(result.body.checks.reconciliationFresh, true);
      assert.equal(result.body.checks.auditWriteAvailable, true);
      assert.equal(result.body.reconciliation.ageSeconds, 60);
      assert.equal(result.body.reconciliation.maxAgeSeconds, 900);
    });

    it("returns 200 with tradingEnabled=false in LIVE (decision D7)", () => {
      // Administratively disabled trading in live is NOT a readiness
      // failure. The system is up, just paused by policy. The response
      // body advertises tradingEnabled=false so UI can distinguish.
      const result = evaluateReadiness({
        ...baseInputs,
        environment: "live",
        tradingEnabled: false,
        activeAccountId: "U1234567",
      });
      assert.equal(result.statusCode, 200);
      assert.equal(result.body.ready, true);
      assert.equal(result.body.tradingEnabled, false);
      assert.equal(result.body.environment, "live");
    });
  });

  describe("failure modes", () => {
    it("broker socket down → 503 broker_socket_down", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        brokerSocketUp: false,
      });
      assert.equal(result.statusCode, 503);
      assert.equal(result.body.ready, false);
      assert.ok(result.body.reasons.includes("broker_socket_down"));
    });

    it("no active account → 503 no_active_account (bootstrap not run)", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        activeAccountId: null,
        accountAllowedByEnvironment: false,
      });
      assert.equal(result.statusCode, 503);
      assert.ok(result.body.reasons.includes("no_active_account"));
      assert.equal(result.body.account, null);
    });

    it("account mismatch (paper) → 503 account_not_allowed_for_paper", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        accountAllowedByEnvironment: false,
      });
      assert.equal(result.statusCode, 503);
      assert.ok(
        result.body.reasons.includes("account_not_allowed_for_paper"),
      );
    });

    it("account mismatch (live) → 503 account_not_allowed_for_live", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        environment: "live",
        activeAccountId: "U9999999",
        accountAllowedByEnvironment: false,
      });
      assert.equal(result.statusCode, 503);
      assert.ok(
        result.body.reasons.includes("account_not_allowed_for_live"),
      );
    });

    it("audit write unavailable → 503 audit_write_unavailable", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        auditWriteAvailable: false,
      });
      assert.equal(result.statusCode, 503);
      assert.ok(result.body.reasons.includes("audit_write_unavailable"));
    });

    it("no reconciliation yet → 503 no_reconciliation_yet", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        lastReconciliationAt: null,
      });
      assert.equal(result.statusCode, 503);
      assert.ok(result.body.reasons.includes("no_reconciliation_yet"));
      assert.equal(result.body.reconciliation.ageSeconds, null);
      assert.equal(result.body.reconciliation.lastRanAt, null);
    });

    it("reconciliation older than max → 503 reconciliation_stale", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        lastReconciliationAt: new Date(NOW.getTime() - 901_000),
      });
      assert.equal(result.statusCode, 503);
      assert.ok(result.body.reasons.includes("reconciliation_stale"));
      assert.equal(result.body.reconciliation.ageSeconds, 901);
    });

    it("multiple failures accumulate all reasons", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        brokerSocketUp: false,
        auditWriteAvailable: false,
        lastReconciliationAt: null,
      });
      assert.equal(result.statusCode, 503);
      assert.ok(result.body.reasons.includes("broker_socket_down"));
      assert.ok(result.body.reasons.includes("audit_write_unavailable"));
      assert.ok(result.body.reasons.includes("no_reconciliation_yet"));
    });
  });

  describe("edge cases", () => {
    it("reconciliation exactly at max age still counts as fresh", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        lastReconciliationAt: new Date(NOW.getTime() - 900_000),
      });
      assert.equal(result.statusCode, 200);
      assert.equal(result.body.checks.reconciliationFresh, true);
      assert.equal(result.body.reconciliation.ageSeconds, 900);
    });

    it("reports ageSeconds=0 when reconciliation is in the future (clock skew)", () => {
      // Negative age (future timestamp) should clamp to 0 rather than
      // report a nonsensical negative number. Still counts as fresh.
      const result = evaluateReadiness({
        ...baseInputs,
        lastReconciliationAt: new Date(NOW.getTime() + 10_000),
      });
      assert.equal(result.body.reconciliation.ageSeconds, 0);
      assert.equal(result.body.checks.reconciliationFresh, true);
    });
  });

  describe("position snapshot health (round-7 blocker)", () => {
    it("never synced → 503 position_snapshot_never_synced", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        positionSnapshotHealth: { kind: "never" },
      });
      assert.equal(result.statusCode, 503);
      assert.ok(result.body.reasons.includes("position_snapshot_never_synced"));
      assert.equal(result.body.checks.positionSnapshotHealthy, false);
    });

    it("undefined input with active account → 503 position_snapshot_never_synced", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        positionSnapshotHealth: undefined,
      });
      assert.equal(result.statusCode, 503);
      assert.ok(result.body.reasons.includes("position_snapshot_never_synced"));
    });

    it("refresh in flight → 503 position_snapshot_refresh_in_flight", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        positionSnapshotHealth: { kind: "in_flight" },
      });
      assert.equal(result.statusCode, 503);
      assert.ok(
        result.body.reasons.includes("position_snapshot_refresh_in_flight"),
      );
    });

    it("refresh failed → 503 position_snapshot_refresh_failed", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        positionSnapshotHealth: { kind: "failed", error: "boom" },
      });
      assert.equal(result.statusCode, 503);
      assert.ok(
        result.body.reasons.includes("position_snapshot_refresh_failed"),
      );
    });

    it("no active account → snapshot health is not required (already covered by no_active_account)", () => {
      const result = evaluateReadiness({
        ...baseInputs,
        activeAccountId: null,
        positionSnapshotHealth: undefined,
      });
      assert.equal(result.statusCode, 503);
      // Bootstrap-pending state: only the account reason fires;
      // snapshot health is trivially healthy in that case.
      assert.ok(result.body.reasons.includes("no_active_account"));
      assert.equal(
        result.body.reasons.includes("position_snapshot_never_synced"),
        false,
      );
    });
  });
});
