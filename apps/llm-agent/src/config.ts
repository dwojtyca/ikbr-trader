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
});

const env = schema.parse(process.env);

export const config = {
  ...env,
  llmAgentEnabled: env.LLM_AGENT_ENABLED.toLowerCase() === "true",
  llmAgentFailClosed: env.LLM_AGENT_FAIL_CLOSED.toLowerCase() === "true",
};
