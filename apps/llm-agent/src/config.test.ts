import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("Marketaux on-demand flag defaults false and accepts only exact true or false", () => {
  for (const value of [undefined, "true", "false", "TRUE", "False", "1", "", " true "]) {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LLM_AGENT_ENABLED: "false" };
    if (value !== undefined) env.RESEARCH_MARKETAUX_ON_DEMAND = value;
    const code = `import { config } from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)}; console.log(JSON.stringify(config.RESEARCH_MARKETAUX_ON_DEMAND));`;
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], { env, cwd: tmpdir(), encoding: "utf8" });
    if (value === undefined || value === "true" || value === "false") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), value === "true" ? "true" : "false");
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /RESEARCH_MARKETAUX_ON_DEMAND/);
    }
  }
});
