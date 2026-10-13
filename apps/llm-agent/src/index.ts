import { ResearchBoundReviewRepository } from "./research-review-repository.js";
import { ResearchOpenAiDecider } from "./research-decision.js";
import { ResearchStore, loadResearchManifest } from "@ikbr/shared/instrument-research";
import { BoundReviewWorker } from "./bound-review-worker.js";
import { Pool } from "pg";
import { config, tradingConfiguration } from "./config.js";
import { createTradingConfigurationRuntime, TradingConfigurationStore } from "@ikbr/shared/trading-config";
import { ExecutionApiClient } from "./execution-api-client.js";
import { LlmAgentRepository } from "./repository.js";
import { ResearchRefreshScheduler, researchBudgetAccountId } from "./research-refresh.js";
import { loadWshRuntimeConfiguration } from "./research-wsh-transport.js";

import { assertProcessActive, installShutdown, whileProcessActive } from "./shutdown.js";

const shutdownController = new AbortController();
const signal = shutdownController.signal;
const active = new Set<Promise<unknown>>();
function track<T>(promise: Promise<T>): Promise<T> {
  active.add(promise);
  void promise.finally(() => active.delete(promise)).catch(() => undefined);
  return promise;
}
const pool = new Pool({ connectionString: config.POSTGRES_URL });
const configurationStore = new TradingConfigurationStore(pool);
const configurationRuntime = createTradingConfigurationRuntime({
  service: "llm-agent", loaded: tradingConfiguration.loaded, store: configurationStore,
  legacyAuthority: tradingConfiguration.authority, tradingEnabled: process.env.TRADING_ENABLED === "true",
});
const repo = new LlmAgentRepository(pool);
const executionApi = new ExecutionApiClient(
  config.LLM_AGENT_EXECUTION_BASE_URL,
  config.LLM_AGENT_HTTP_TIMEOUT_MS,
  config.EXECUTION_API_TOKEN ?? "",
);
const research = loadResearchManifest(process.env, tradingConfiguration.loaded);
const researchStore = new ResearchStore(pool);
const researchDecider = new ResearchOpenAiDecider({ apiKey: config.LLM_AGENT_OPENAI_API_KEY, baseUrl: config.LLM_AGENT_OPENAI_BASE_URL });
const boundWorker = new BoundReviewWorker({
  assertEntryAllowed: () => whileProcessActive(signal, () => configurationRuntime.assertEntryAllowed()),
  repository: new ResearchBoundReviewRepository(pool, research), execution: executionApi,
  researchDecider, model: research?.manifest.model.model ?? config.LLM_AGENT_MODEL,
  promptVersion: research?.manifest.model.promptVersion ?? config.LLM_AGENT_PROMPT_VERSION,
});
let researchHeartbeat: NodeJS.Timeout | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let repairTimer: NodeJS.Timeout | undefined;
const refreshAccountId = researchBudgetAccountId(process.env, research?.manifest.refreshEnabled ?? false);
const wshRuntime = loadWshRuntimeConfiguration(process.env);
const refreshScheduler = research && refreshAccountId ? new ResearchRefreshScheduler({ manifest: research.manifest,
  manifestHash: research.hash, accountId: refreshAccountId, store: researchStore, marketauxApiKey: config.LLM_AGENT_MARKETAUX_API_KEY,
  marketauxOnDemand: config.RESEARCH_MARKETAUX_ON_DEMAND,
  signal, secrets: [config.LLM_AGENT_OPENAI_API_KEY, config.LLM_AGENT_MARKETAUX_API_KEY, config.EXECUTION_API_TOKEN].filter((value): value is string => !!value),
  wsh: { runtime: wshRuntime } }) : null;

const workerId = `llm-agent-${process.pid}`;
let inFlight = false;
let timer: NodeJS.Timeout | null = null;

function log(
  level: "info" | "warn" | "error",
  message: string,
  extra?: unknown,
): void {
  const data = {
    level,
    ts: new Date().toISOString(),
    workerId,
    msg: message,
    ...(extra ? { extra } : {}),
  };

  if (level === "error") {
    console.error(JSON.stringify(data));
  } else if (level === "warn") {
    console.warn(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data));
  }
}

async function pollOnce(): Promise<void> {
  await boundWorker.pollOnce();
}

async function tick(): Promise<void> {
  if (signal.aborted || !config.llmAgentEnabled) return;
  if (inFlight) return;

  inFlight = true;
  try {
    await pollOnce();
  } catch (error) {
    log("error", "poll failed", { message: (error as Error).message });
  } finally {
    inFlight = false;
  }
}

async function main(): Promise<void> {
  await whileProcessActive(signal, () => configurationRuntime.initialize());
  configurationRuntime.startHeartbeat();
  await whileProcessActive(signal, () => repo.init());
  if (research && tradingConfiguration.loaded.mode === "bundle") {
    await researchStore.registerManifest({ manifest: research.manifest, configuration: tradingConfiguration.loaded.configuration,
      tradingEnabled: process.env.TRADING_ENABLED === "true", adopt: process.env.RESEARCH_ADOPT_MANIFEST === "true" });
    assertProcessActive(signal);
    const observe = () => whileProcessActive(signal, () => researchStore.observe({ configHash: research.manifest.configHash, manifestHash: research.hash,
      service: "llm-agent", processId: configurationRuntime.processId, tradingEnabled: process.env.TRADING_ENABLED === "true" }));
    await observe();
    researchHeartbeat = setInterval(() => { void track(observe()).catch(() => log("error", "research heartbeat unavailable")); }, 10000);
    researchHeartbeat.unref();
  }
  assertProcessActive(signal);
  if (refreshScheduler) {
    const refresh = () => void refreshScheduler.tick().catch(error => log("error", "research refresh failed", { message: (error as Error).message }));
    refreshTimer = setInterval(refresh, 60_000);
    refreshTimer.unref();
    refresh();
    const repair = () => void refreshScheduler.tickRepairs().catch(() => log("error", "research repair unavailable"));
    repairTimer = setInterval(repair, 2000);
    repairTimer.unref();
    repair();
  }

  log("info", "trading configuration loaded", configurationRuntime.diagnostics());

  log("info", "llm-agent started", {
    enabled: config.llmAgentEnabled,
    pollMs: config.LLM_AGENT_POLL_MS,
    model: config.LLM_AGENT_MODEL,
    failClosed: config.llmAgentFailClosed,
  });

  if (!config.llmAgentEnabled) {
    log("warn", "LLM_AGENT_ENABLED=false; worker idle");
    return;
  }

  timer = setInterval(() => {
    void track(tick());
  }, config.LLM_AGENT_POLL_MS);

  void track(tick());
}

const shutdown = installShutdown({
  controller: shutdownController,
  stop: () => {
    configurationRuntime.stopHeartbeat();
    if (timer) clearInterval(timer);
    if (researchHeartbeat) clearInterval(researchHeartbeat);
    if (refreshTimer) clearInterval(refreshTimer);
    if (repairTimer) clearInterval(repairTimer);
    refreshScheduler?.stop();
  },
  drain: async () => { await refreshScheduler?.drain(); await Promise.allSettled([...active]); },
  close: () => pool.end(),
  report: fatal => log(fatal ? "error" : "info", fatal ? "llm-agent fatal shutdown" : "llm-agent shutdown"),
});
void track(main()).catch(() => { void shutdown(true); });
