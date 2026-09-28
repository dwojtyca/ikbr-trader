import { createAaplIdentityResolver } from "./aapl-identity.js";
import { BoundReviewRepository } from "./bound-review-repository.js";
import { BoundReviewWorker } from "./bound-review-worker.js";
import { createLegacyReviewWorker } from "./legacy-review-worker.js";
import { Pool } from "pg";
import { config, tradingConfiguration } from "./config.js";
import { createTradingConfigurationRuntime, TradingConfigurationStore } from "@ikbr/shared/trading-config";
import { MarketAuxClient } from "./marketaux-client.js";
import { ExecutionApiClient } from "./execution-api-client.js";
import { OpenAiDecider } from "./openai-decider.js";
import { LlmAgentRepository } from "./repository.js";

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
const marketaux = new MarketAuxClient({
  apiKey: config.LLM_AGENT_MARKETAUX_API_KEY,
  baseUrl: config.LLM_AGENT_MARKETAUX_BASE_URL,
  timeoutMs: config.LLM_AGENT_HTTP_TIMEOUT_MS,
});
const decider = new OpenAiDecider({
  apiKey: config.LLM_AGENT_OPENAI_API_KEY,
  baseUrl: config.LLM_AGENT_OPENAI_BASE_URL,
  model: config.LLM_AGENT_MODEL,
  timeoutMs: config.LLM_AGENT_HTTP_TIMEOUT_MS,
  promptVersion: config.LLM_AGENT_PROMPT_VERSION,
  maxOpenNotionalPct: config.MAX_NOTIONAL_PER_TRADE_PCT,
});

const boundWorker = new BoundReviewWorker({
  assertEntryAllowed: () => configurationRuntime.assertEntryAllowed(),
  repository: new BoundReviewRepository(pool, { effectiveConfigHash: tradingConfiguration.loaded.mode === "bundle" ? tradingConfiguration.loaded.effectiveHash : undefined }), execution: executionApi,
  resolveAaplIdentity: createAaplIdentityResolver({ pool, env: process.env }),
  news: marketaux, decider, model: config.LLM_AGENT_MODEL,
  promptVersion: config.LLM_AGENT_PROMPT_VERSION,
  newsWindowHours: config.LLM_AGENT_NEWS_WINDOW_HOURS,
  maxNewsItems: config.LLM_AGENT_MAX_NEWS_ITEMS,
});

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

const legacyWorker = createLegacyReviewWorker({
  repo, executionApi, marketaux, decider, config, workerId, log,
  assertEntryAllowed: () => configurationRuntime.assertEntryAllowed(),
});

async function pollOnce(): Promise<void> {
  if (await boundWorker.pollOnce()) return;
  await legacyWorker.pollOnce();
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
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}
