import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { accountingCommand } from "./source-cli.js";
test("public CLI normalizes pnpm separator, protects artifacts and never retries or exposes credentials", async () => {
  const original = globalThis.fetch, root = mkdtempSync(join(realpathSync(tmpdir()), "accounting-cli-"));
  const privateDir = join(root, "private"); mkdirSync(privateDir, { mode: 0o700 });
  const calls: Array<{ url: string; init?: RequestInit }> = [], token = "fixture-" + "a".repeat(40), env = { EXECUTION_API_TOKEN: token };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ id: "inspection", configured: true }), { status: 200 }); };
  try {
    const status = await accountingCommand(["--", "status"], env);
    assert.equal(JSON.stringify(status).includes(token), false); assert.equal(calls[0].init?.method, "GET");
    assert.equal(calls[0].init?.redirect, "error"); assert.equal(calls[0].url.includes(token), false);
    const out = join(privateDir, "inspection.json");
    await accountingCommand(["inspect", "--out", out], env); assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).id, "inspection");
    const bytes = Buffer.from("operator observed test fixture"), evidence = join(privateDir, "settings.txt"); writeFileSync(evidence, bytes, { mode: 0o600 });
    const now = new Date().toISOString(), input = { schemaVersion: 1, sourceKind: "ibkr-tws-seven-day-v1", settingsSha256: "a".repeat(64), inspectionId: randomUUID(),
      operator: "test", observedAt: now, product: "TWS", productVersion: "fixture", productBuild: "fixture", tradeLogDays: 7, masterClientId: 0, executionTimeZone: "UTC",
      confirmations: { exactEndpointAndAccount: true, evidenceBelongsToCurrentHostSession: true, noSettingsChangeSinceEvidence: true, pauseAndRequalifyBeforeSettingsChange: true },
      artifacts: ["tws-product-build", "tws-trade-log-seven-days", "tws-master-client-zero", "execution-timezone"].map(kind => ({ kind, relativePath: "settings.txt", sha256: createHash("sha256").update(bytes).digest("hex"), observedAt: now })) };
    const path = join(privateDir, "qualification.json"); writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
    await accountingCommand(["--", "qualify", "--input", path, "--evidence-dir", privateDir], env);
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), input);
    await accountingCommand(["invalidate", "--reason", "operator changed settings"], env);
    const recovered = join(privateDir, "recovery.json");
    await accountingCommand(["recover-clock", "--out", recovered], env);
    assert.equal(calls.at(-1)?.url.endsWith("/recover-clock"), true); assert.equal(statSync(recovered).mode & 0o777, 0o600);
    const before = calls.length;
    await assert.rejects(accountingCommand(["recover-clock", "--out", recovered], env), /PRIVATE_FILE_EXISTS/);
    for (const args of [["--", "--", "status"], ["status", "--extra", "x"], ["inspect"]]) await assert.rejects(accountingCommand(args, env), /CLI_ARGUMENT_INVALID/);
    await assert.rejects(accountingCommand(["status"], {}), /CLI_AUTH_REQUIRED/);
    await assert.rejects(accountingCommand(["status"], { ...env, EXECUTION_ACCOUNTING_API_URL: "http://remote.invalid" }), /CLI_ENDPOINT_INVALID/);
    writeFileSync(evidence, "tampered", { mode: 0o600 });
    await assert.rejects(accountingCommand(["qualify", "--input", path, "--evidence-dir", privateDir], env), /ARTIFACT_MISMATCH/); assert.equal(calls.length, before);
    globalThis.fetch = async () => { calls.push({ url: "failed" }); return new Response("untrusted secret text", { status: 409 }); };
    await assert.rejects(accountingCommand(["status"], env), /ACCOUNTING_CLI_HTTP_409/); assert.equal(calls.length, before + 1);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});
