/**
 * PR15.1 — child-process launcher tests.
 * The documented machine-readable command is
 *   node --import tsx tools/paper-verify-stack/src/index.ts --json
 * because `pnpm run` prepends its own script banner to stdout.
 * We assert:
 *   - stdout is a single well-formed JSON document,
 *   - stderr never contains the Bearer token,
 *   - exit codes are propagated (0/10/20/30/40).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "index.ts");

function launch(
  args: readonly string[],
  env: Record<string, string>,
): { stdout: string; stderr: string; code: number } {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", ENTRY, ...args],
    {
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  );
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  };
}

const TOKEN = "test-token-DO-NOT-LEAK-abcdefghijklmnop-1234567890";

describe("launcher — machine-readable JSON", () => {
  it("--json stdout parses via JSON.parse without stripping any prefix (CONFIG_ERROR path, deterministic)", () => {
    // No token → CONFIG_ERROR before any HTTP request. Deterministic.
    const r = launch(["--json"], {
      PAPER_VERIFY_EXECUTION_TOKEN: "",
      EXECUTION_API_TOKEN: "",
      PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "registered",
      PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "disabled",
    });
    assert.equal(r.code, 10, `stderr=${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.overall, "CONFIG_ERROR");
    assert.equal(parsed.reason, "execution_token_missing");
  });

  it("stderr never contains the Bearer token (invalid URL path)", () => {
    const r = launch(["--json"], {
      PAPER_VERIFY_EXECUTION_TOKEN: TOKEN,
      PAPER_VERIFY_INGESTION_URL: "http://user:pass@127.0.0.1:3101",
      PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "registered",
      PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "disabled",
    });
    assert.equal(r.code, 10, `stderr=${r.stderr}`);
    assert.equal(
      r.stderr.includes(TOKEN),
      false,
      `token leaked to stderr: ${r.stderr}`,
    );
    assert.equal(
      r.stdout.includes(TOKEN),
      false,
      `token leaked to stdout: ${r.stdout}`,
    );
  });

  it("propagates exit code for an invalid expected-state combination", () => {
    const r = launch(["--json"], {
      PAPER_VERIFY_EXECUTION_TOKEN: TOKEN,
      PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "absent",
      PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "enabled",
    });
    assert.equal(r.code, 10);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.overall, "CONFIG_ERROR");
    assert.equal(parsed.reason, "trading_loop_requires_execution_runtime");
  });
});
