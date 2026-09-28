import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const composeSource = readFileSync(fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url)), "utf8");
const publishedServices = ["postgres", "redis", "ingestion", "signal-engine", "execution-engine", "backtest-engine", "ui"];

type ComposeService = { ports?: Array<{ host_ip: string; target: number; published: string }>; environment?: Record<string, string>; command?: string[] };

for (const binding of [undefined, "192.0.2.10"]) {
  test(`Compose host publishing uses ${binding ?? "default loopback"} without changing internal connectivity`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "pp0-compose-bindings-"));
    try {
      const emptyEnv = join(temporary, "empty.env");
      const composeFile = join(temporary, "compose.yml");
      writeFileSync(emptyEnv, "");
      // Fixtures must never resolve the operator's private .env file.
      writeFileSync(composeFile, composeSource.replaceAll("      - .env", `      - ${emptyEnv}`));
      const output = execFileSync("docker", ["compose", "--env-file", emptyEnv, "-f", composeFile, "config", "--format", "json"], {
        env: { PATH: process.env.PATH, COMPOSE_PROJECT_NAME: "pp0-bindings-test", ...(binding ? { HOST_BIND_ADDRESS: binding } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
      const config = JSON.parse(output.toString()) as { services: Record<string, ComposeService> };
      for (const name of publishedServices) {
        const ports = config.services[name].ports;
        assert.equal(ports?.length, 1, name);
        assert.equal(ports![0].host_ip, binding ?? "127.0.0.1", name);
        assert.equal(Number(ports![0].published), ports![0].target, name);
      }
      assert.equal(config.services.ui.environment?.UI_HOST, "0.0.0.0");
      assert.equal(config.services.ingestion.environment?.INGESTION_BIND_HOST, "0.0.0.0");
      assert.equal(config.services["signal-engine"].environment?.SIGNAL_BIND_HOST, "0.0.0.0");
      assert.equal(config.services["backtest-engine"].environment?.BACKTEST_BIND_HOST, "0.0.0.0");
      assert.equal(config.services["execution-engine"].environment?.EXECUTION_BIND_HOST, "0.0.0.0");
      assert.equal(config.services.ui.environment?.UI_PUBLIC_ORIGIN, "http://127.0.0.1:5173");
      assert.equal(config.services.ui.environment?.UI_EXECUTION_PROXY_TARGET, "http://execution-engine:3103");
      assert.equal(config.services.ui.environment?.UI_OPERATOR_PASSWORD, "");
      assert.equal(config.services.ingestion.environment?.EXECUTION_API_TOKEN, "");
      assert.equal(config.services["backtest-engine"].environment?.EXECUTION_API_TOKEN, "");
      assert.equal(config.services["execution-engine"].environment?.TRADING_ENABLED, "false");
      assert.equal(config.services["signal-engine"].environment?.EXECUTION_RUNTIME_ENABLED, "false");
      assert.equal(config.services["signal-engine"].environment?.TRADING_LOOP_ENABLED, "false");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
