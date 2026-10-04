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
  assertEntryAllowed: () => configurationRuntime.assertEntryAllowed(),
  repository: new ResearchBoundReviewRepository(pool, research), execution: executionApi,
  researchDecider, model: research?.manifest.model.model ?? config.LLM_AGENT_MODEL,
  promptVersion: research?.manifest.model.promptVersion ?? config.LLM_AGENT_PROMPT_VERSION,
});
let researchHeartbeat: NodeJS.Timeout | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
const refreshAccountId = researchBudgetAccountId(process.env, research?.manifest.refreshEnabled ?? false);
const refreshScheduler = research && refreshAccountId ? new ResearchRefreshScheduler({ manifest: research.manifest,
  manifestHash: research.hash, accountId: refreshAccountId, store: researchStore }) : null;

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
  if (!config.llmAgentEnabled) return;
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
  await configurationRuntime.initialize();
  configurationRuntime.startHeartbeat();
  await repo.init();
  if (research && tradingConfiguration.loaded.mode === "bundle") {
    await researchStore.registerManifest({ manifest: research.manifest, configuration: tradingConfiguration.loaded.configuration,
      tradingEnabled: process.env.TRADING_ENABLED === "true", adopt: process.env.RESEARCH_ADOPT_MANIFEST === "true" });
    const observe = () => researchStore.observe({ configHash: research.manifest.configHash, manifestHash: research.hash,
      service: "llm-agent", processId: configurationRuntime.processId, tradingEnabled: process.env.TRADING_ENABLED === "true" });
    await observe();
    researchHeartbeat = setInterval(() => { void observe().catch(() => log("error", "research heartbeat unavailable")); }, 10000);
    researchHeartbeat.unref();
  }
  if (refreshScheduler) {
    const refresh = () => void refreshScheduler.tick().catch(error => log("error", "research refresh failed", { message: (error as Error).message }));
    refreshTimer = setInterval(refresh, 60_000);
    refreshTimer.unref();
    refresh();
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
    void tick();
  }, config.LLM_AGENT_POLL_MS);

  void tick();
}

main().catch((error) => {
  log("error", "llm-agent fatal error", { message: (error as Error).message });
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    configurationRuntime.stopHeartbeat();
    try {
      if (timer) clearInterval(timer);
      if (researchHeartbeat) clearInterval(researchHeartbeat);
      if (refreshTimer) clearInterval(refreshTimer);
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}
