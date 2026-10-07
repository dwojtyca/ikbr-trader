import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { loadAccountingSettings, parseQualification, verifyQualificationArtifacts } from "./config.js";

test("settings require private hash-pinned exact allowlisted Paper endpoint and no client-zero collision", () => {
  const dir = mkdtempSync(realpathSync(tmpdir()) + "/accounting-settings-"); chmodSync(dir, 0o700);
  try {
    const path = dir + "/settings.json", bytes = JSON.stringify({ schemaVersion: 1, sourceKind: "ibkr-tws-seven-day-v1", environment: "paper",
      accountId: "TEST", endpoint: { host: "unused", port: 1 }, sourceClientId: 0, executionTimeZone: "UTC" });
    writeFileSync(path, bytes, { mode: 0o600 });
    const input = { path, sha256: createHash("sha256").update(bytes).digest("hex"), environment: "paper", host: "unused", port: 1,
      allowedAccounts: ["TEST"], timeZone: "UTC", clientIds: [102] };
    assert.ok(loadAccountingSettings(input));
    for (const change of [{ environment: "live" }, { host: "other" }, { port: 2 }, { clientIds: [0] }, { allowedAccounts: [] }, { timeZone: "Europe/Warsaw" }, { sha256: "0".repeat(64) }]) {
      assert.throws(() => loadAccountingSettings({ ...input, ...change }));
    }
    chmodSync(path, 0o644); assert.throws(() => loadAccountingSettings(input), /PRIVATE_FILE/);
    assert.equal(loadAccountingSettings({ ...input, path: undefined, sha256: undefined }), undefined);
  } finally { rmSync(dir, { recursive: true }); }
});
test("qualification rejects arbitrary coverage flags, incomplete kinds, stale evidence and artifact tampering", () => {
  const dir = mkdtempSync(realpathSync(tmpdir()) + "/accounting-evidence-"); chmodSync(dir, 0o700);
  try {
    const now = new Date().toISOString(); const bytes = "operator reviewed settings";
    writeFileSync(dir + "/evidence.txt", bytes, { mode: 0o600 });
    const input = { schemaVersion: 1, sourceKind: "ibkr-tws-seven-day-v1", settingsSha256: "a".repeat(64), inspectionId: randomUUID(),
      operator: "test", observedAt: now, product: "TWS", productVersion: "test-version", productBuild: "test-build", tradeLogDays: 7,
      masterClientId: 0, executionTimeZone: "UTC", confirmations: { exactEndpointAndAccount: true, evidenceBelongsToCurrentHostSession: true,
        noSettingsChangeSinceEvidence: true, pauseAndRequalifyBeforeSettingsChange: true },
      artifacts: ["tws-product-build", "tws-trade-log-seven-days", "tws-master-client-zero", "execution-timezone"].map(kind => ({ kind, relativePath: "evidence.txt", observedAt: now,
        sha256: createHash("sha256").update(bytes).digest("hex") })) };
    const parsed = parseQualification(input, Date.now()); verifyQualificationArtifacts(parsed, dir);
    for (const bad of [{ ...input, coverage: true }, { ...input, product: "Gateway" }, { ...input, observedAt: "2020-01-01T00:00:00Z" }, { ...input, artifacts: [input.artifacts[0], input.artifacts[0], input.artifacts[0], input.artifacts[0]] }]) assert.throws(() => parseQualification(bad, Date.now()));
    writeFileSync(dir + "/evidence.txt", "changed"); assert.throws(() => verifyQualificationArtifacts(parsed, dir), /ARTIFACT_MISMATCH/);
  } finally { rmSync(dir, { recursive: true }); }
});
