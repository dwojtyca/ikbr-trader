import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tsxLoader = import.meta.resolve("tsx");

for (const [app, variable] of [
  ["ingestion", "INGESTION_BIND_HOST"],
  ["signal-engine", "SIGNAL_BIND_HOST"],
  ["backtest-engine", "BACKTEST_BIND_HOST"],
]) {
  test(`${app} native listener defaults to loopback and rejects blank overrides`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "pp0-native-bind-"));
    const configUrl = new URL(`../../../apps/${app}/src/config.ts`, import.meta.url).href;
    try {
      for (const [value, expected] of [
        [undefined, "127.0.0.1"],
        ["192.0.2.10", "192.0.2.10"],
        [" 0.0.0.0 ", "0.0.0.0"],
        ["", undefined],
        [" \t ", undefined],
      ]) {
        const script = `try {
          const { config } = await import(${JSON.stringify(configUrl)});
          process.stdout.write(config[${JSON.stringify(variable)}]);
        } catch (error) {
          if (error.issues?.some(issue => issue.path[0] === ${JSON.stringify(variable)})) process.exit(2);
          throw error;
        }`;
        const result = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", script], {
          cwd: temporary,
          // No private environment or .env is loaded by these fixture processes.
          env: { PATH: process.env.PATH, ...(value === undefined ? {} : { [variable]: value }) },
          encoding: "utf8",
          timeout: 15_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, expected === undefined ? 2 : 0, `${variable} for ${JSON.stringify(value)}: ${result.stderr}`);
        assert.equal(result.stdout, expected ?? "");
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
