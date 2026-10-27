import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("production research startup and heartbeat bind the configuration process, not broker ownership", async () => {
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const callbacks: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "observeResearch" && node.initializer)
      callbacks.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(callbacks.length, 1);
  const processId = randomUUID(), brokerOwner = "execution-engine:fixture-host:12345678";
  const identity = { configHash: "a".repeat(64), manifestHash: "b".repeat(64) };
  const observations: Record<string, unknown>[] = [];
  // Evaluate only the actual startup callback: importing index.ts would start broker sockets.
  const compiled = ts.transpileModule(`(${callbacks[0].getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const observe = runInNewContext(compiled, {
    researchStore: { observe: async (value: Record<string, unknown>) => { observations.push(value); } },
    researchIdentity: () => identity, configurationRuntime: { processId },
    EXECUTION_PROCESS_OWNER_ID: brokerOwner, config: { TRADING_ENABLED: "false" },
  }) as () => Promise<void>;
  await observe();
  await observe();
  assert.equal(observations.length, 2);
  for (const observation of observations) {
    assert.equal(observation.processId, processId);
    assert.notEqual(observation.processId, brokerOwner);
    assert.equal(observation.service, "execution-engine");
    assert.equal(observation.configHash, identity.configHash);
    assert.equal(observation.manifestHash, identity.manifestHash);
    assert.equal(observation.tradingEnabled, false);
  }
});
