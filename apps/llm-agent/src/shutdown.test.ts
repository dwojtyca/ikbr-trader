import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { whileProcessActive } from "./shutdown.js";

test("shutdown fence rejects work after an awaited entry/startup authorization returns", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = whileProcessActive(controller.signal, () => held);
  controller.abort(); release(); await assert.rejects(pending, /SHUTTING_DOWN/);
  let called = false;
  await assert.rejects(whileProcessActive(controller.signal, async () => { called = true; }), /SHUTTING_DOWN/);
  assert.equal(called, false);
});

for (const mode of ["SIGINT", "SIGTERM", "main-failure", "exception", "rejection", "stuck"] as const) {
  test(`terminal ${mode} uses bounded abort/drain/close ordering`, { timeout: 5000 }, async () => {
    const source = `
      import { installShutdown } from ${JSON.stringify(new URL("./shutdown.ts", import.meta.url).href)};
      const controller = new AbortController();
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      controller.signal.addEventListener('abort', () => { console.log('abort'); setTimeout(() => { console.log('cleaned'); release(); }, 25); });
      const shutdown = installShutdown({ controller, stop: () => console.log('stop'),
        drain: async () => { console.log('drain'); ${mode === "stuck" ? "await new Promise(() => {});" : "await pending;"} },
        close: async () => console.log('close'), report: () => {}, deadlineMs: 150 });
      console.log('ready');
      setInterval(() => {}, 1000);
      ${mode === "main-failure" ? "void shutdown(true);" : mode === "exception" ? "setTimeout(() => { throw new Error('fatal'); }, 0);" : mode === "rejection" ? "void Promise.reject(new Error('fatal'));" : mode === "stuck" ? "void shutdown();" : ""}
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "", signalled = false;
    child.stderr.on("data", bytes => { error += bytes.toString(); });
    child.stdout.on("data", bytes => {
      output += bytes.toString();
      if (!signalled && output.includes("ready") && (mode === "SIGINT" || mode === "SIGTERM")) { signalled = true; child.kill(mode); }
    });
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null, error);
    assert.equal(code, mode === "SIGINT" || mode === "SIGTERM" ? 0 : 1, error);
    assert.deepEqual(output.trim().split("\n"), mode === "stuck"
      ? ["ready", "abort", "stop", "drain", "cleaned"] : ["ready", "abort", "stop", "drain", "cleaned", "close"]);
  });
}
