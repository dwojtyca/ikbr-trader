import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalTrimmedString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const schema = z.object({
  LOG_LEVEL: z.string().default("info"),
  POSTGRES_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/ikbr_trader"),
  LLM_AGENT_EXECUTION_BASE_URL: z.string().default("http://localhost:3103"),
  LLM_AGENT_ENABLED: z.string().default("true"),
  LLM_AGENT_POLL_MS: z.coerce.number().int().min(200).default(1500),
  LLM_AGENT_CLAIM_STALE_MS: z.coerce.number().int().min(1000).default(120000),
  LLM_AGENT_SYMBOL_COOLDOWN_MS: z.coerce.number().int().min(0).default(300000),
  LLM_AGENT_NEWS_WINDOW_HOURS: z.coerce.number().min(1).max(168).default(24),
  LLM_AGENT_FAIL_CLOSED: z.string().default("true"),
  LLM_AGENT_MODEL: z.string().default("gpt-5-mini"),
  LLM_AGENT_PROMPT_VERSION: z.string().default("llm_agent_v1"),
  LLM_AGENT_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  LLM_AGENT_MAX_NEWS_ITEMS: z.coerce.number().int().min(0).max(50).default(12),
  LLM_AGENT_OPENAI_API_KEY: optionalTrimmedString,
  LLM_AGENT_OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  LLM_AGENT_MARKETAUX_API_KEY: optionalTrimmedString,
  LLM_AGENT_MARKETAUX_BASE_URL: z
    .string()
    .default("https://api.marketaux.com/v1/news/all"),
  MAX_NOTIONAL_PER_TRADE_PCT: z.coerce.number().min(0).max(1000).default(100),
  // Phase 1 / PR1 (schema-only): Bearer token for the execution-engine API.
  // ADR-001: in Phase 1 the shared EXECUTION_API_TOKEN value is used by
  // every internal client. Per-client tokens are deferred until the
  // execution-engine supports multi-token auth.
  // The HTTP client attaches this header starting in PR2.
  EXECUTION_API_TOKEN: optionalTrimmedString,
});

const env = schema.parse(process.env);

const llmAgentEnabled = env.LLM_AGENT_ENABLED.toLowerCase() === "true";
if (llmAgentEnabled && !env.EXECUTION_API_TOKEN) {
  // PR1: schema-only warning (no throw). Turns into a hard error in PR2
  // once the execution-engine actually requires Bearer.
  // eslint-disable-next-line no-console
  console.warn(
    "[llm-agent config] EXECUTION_API_TOKEN is empty; " +
      "execution-engine will start requiring it from PR2. " +
      "Set it in .env before merging PR2.",
  );
}

export const config = {
  ...env,
  llmAgentEnabled,
  llmAgentFailClosed: env.LLM_AGENT_FAIL_CLOSED.toLowerCase() === "true",
};
