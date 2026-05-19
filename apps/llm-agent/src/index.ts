import { IndicatorSnapshot } from '@ikbr/shared';
import { Pool } from 'pg';
import { config } from './config.js';
import { MarketAuxClient, MarketNewsItem } from './marketaux-client.js';
import { ExecutionApiClient } from './execution-api-client.js';
import { OpenAiDecider } from './openai-decider.js';
import { ClaimedOrder, LlmAgentRepository } from './repository.js';

const pool = new Pool({ connectionString: config.POSTGRES_URL });
const repo = new LlmAgentRepository(pool);
const executionApi = new ExecutionApiClient(config.LLM_AGENT_EXECUTION_BASE_URL, config.LLM_AGENT_HTTP_TIMEOUT_MS);
const marketaux = new MarketAuxClient({
  apiKey: config.LLM_AGENT_MARKETAUX_API_KEY,
  baseUrl: config.LLM_AGENT_MARKETAUX_BASE_URL,
  timeoutMs: config.LLM_AGENT_HTTP_TIMEOUT_MS
});
const decider = new OpenAiDecider({
  apiKey: config.LLM_AGENT_OPENAI_API_KEY,
  baseUrl: config.LLM_AGENT_OPENAI_BASE_URL,
  model: config.LLM_AGENT_MODEL,
  timeoutMs: config.LLM_AGENT_HTTP_TIMEOUT_MS,
  promptVersion: config.LLM_AGENT_PROMPT_VERSION,
  maxOpenNotionalPct: config.MAX_NOTIONAL_PER_TRADE_PCT
});

const workerId = `llm-agent-${process.pid}`;
let inFlight = false;
let timer: NodeJS.Timeout | null = null;

function log(level: 'info' | 'warn' | 'error', message: string, extra?: unknown): void {
  const data = {
    level,
    ts: new Date().toISOString(),
    workerId,
    msg: message,
    ...(extra ? { extra } : {})
  };

  if (level === 'error') {
    console.error(JSON.stringify(data));
  } else if (level === 'warn') {
    console.warn(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data));
  }
}

function shorten(value: string, max = 600): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function composeAiReason(reason: string, news: MarketNewsItem[]): string {
  const headlines = news
    .slice(0, 3)
    .map((item) => item.headline.trim())
    .filter(Boolean);

  if (headlines.length === 0) return reason;
  return `${reason} | headlines: ${headlines.join(' || ')}`;
}

function summarizeOpenPositions(
  positions: Array<{
    symbol: string;
    position: number;
    marketValue?: number;
    averageCost?: number;
    unrealizedPnL?: number;
    realizedPnL?: number;
  }>
): Array<{
  symbol: string;
  position: number;
  marketValue?: number;
  averageCost?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
}> {
  return positions
    .filter((position) => Number.isFinite(position.position) && Math.abs(position.position) > 1e-12)
    .sort((a, b) => Math.abs(b.marketValue ?? 0) - Math.abs(a.marketValue ?? 0))
    .slice(0, 20)
    .map((position) => ({
      symbol: position.symbol,
      position: position.position,
      marketValue: position.marketValue,
      averageCost: position.averageCost,
      unrealizedPnL: position.unrealizedPnL,
      realizedPnL: position.realizedPnL
    }));
}

function buildIndicatorSummary(order: ClaimedOrder): {
  ema20?: number;
  ema50?: number;
  ema200?: number;
  rsi14?: number;
  atr14?: number;
  macdHist?: number;
  bbWidthPct?: number;
  trendFilterValue?: number;
  trendFilterSource?: IndicatorSnapshot['trendFilterSource'];
  secType?: IndicatorSnapshot['secType'];
  directionalRegime?: IndicatorSnapshot['directionalRegime'];
  volatilityRegime?: IndicatorSnapshot['volatilityRegime'];
  regimeScore?: IndicatorSnapshot['regimeScore'];
  regimeConfidence?: IndicatorSnapshot['regimeConfidence'];
  regimeReasons?: IndicatorSnapshot['regimeReasons'];
  timeframeTrendScores?: IndicatorSnapshot['timeframeTrendScores'];
  timeframeTrendVotes?: IndicatorSnapshot['timeframeTrendVotes'];
  strategyProfile?: string;
  timeframes?: IndicatorSnapshot['timeframes'];
} | null {
  const indicators = order.indicators;
  if (!indicators) return null;

  return {
    ema20: indicators.ema20,
    ema50: indicators.ema50,
    ema200: indicators.ema200,
    rsi14: indicators.rsi14,
    atr14: indicators.atr14,
    macdHist: indicators.macdHist,
    bbWidthPct: indicators.bbWidthPct,
    trendFilterValue: indicators.trendFilterValue,
    trendFilterSource: indicators.trendFilterSource,
    secType: indicators.secType,
    directionalRegime: indicators.directionalRegime,
    volatilityRegime: indicators.volatilityRegime,
    regimeScore: indicators.regimeScore,
    regimeConfidence: indicators.regimeConfidence,
    regimeReasons: indicators.regimeReasons,
    timeframeTrendScores: indicators.timeframeTrendScores,
    timeframeTrendVotes: indicators.timeframeTrendVotes,
    strategyProfile: indicators.strategyProfile,
    timeframes: indicators.timeframes
  };
}

async function rejectFailClosed(order: ClaimedOrder, reason: string, options?: {
  aiReason?: string;
  sourceError?: string;
  model?: string;
  llmDecisionId?: number;
  decisionConfidence?: number;
  news?: MarketNewsItem[];
}): Promise<void> {
  const finalReason = shorten(reason);
  const decisionId = await repo.insertDecision({
    proposedOrderId: order.id,
    symbol: order.instrument,
    decision: 'REJECT',
    decisionReason: finalReason,
    model: options?.model,
    promptVersion: config.LLM_AGENT_PROMPT_VERSION,
    decisionConfidence: options?.decisionConfidence,
    newsCount: options?.news?.length ?? 0,
    positionSnapshotJson: null,
    newsSnapshotJson: options?.news ?? [],
    sourceError: options?.sourceError
  });

  await executionApi.rejectProposed(order.id, {
    reason: finalReason,
    actor: 'llm-agent',
    decisionSource: 'llm',
    aiDecision: 'REJECT',
    aiReason: options?.aiReason ?? finalReason,
    aiModel: options?.model ?? config.LLM_AGENT_MODEL,
    aiDecisionConfidence: options?.decisionConfidence,
    llmDecisionId: options?.llmDecisionId ?? decisionId,
    sourceError: options?.sourceError
  });
}

async function processOrder(order: ClaimedOrder): Promise<void> {
  if (order.riskCheckStatus !== 'PASS') {
    await rejectFailClosed(order, `AI reject: riskCheckStatus=${order.riskCheckStatus}`);
    return;
  }

  const inCooldown = await repo.isSymbolInCooldown(order.instrument, config.LLM_AGENT_SYMBOL_COOLDOWN_MS);
  if (inCooldown) {
    const removed = await repo.deleteProposedOrderIfPending(order.id);
    log('info', 'cooldown_active: dropped proposed order without persisting reject', {
      orderId: order.id,
      symbol: order.instrument,
      cooldownMs: config.LLM_AGENT_SYMBOL_COOLDOWN_MS,
      removed
    });
    return;
  }

  let accountSummary;
  try {
    accountSummary = await executionApi.getAccountSummary();
  } catch (error) {
    const message = (error as Error).message;
    if (config.llmAgentFailClosed) {
      await rejectFailClosed(order, `AI reject (fail-closed): account context unavailable`, {
        sourceError: message
      });
      return;
    }
    throw error;
  }

  const currentPositionRaw = accountSummary.positions.find((position) => position.symbol.toUpperCase() === order.instrument.toUpperCase()) ?? null;
  const openPositions = summarizeOpenPositions(accountSummary.positions);
  const indicatorSummary = buildIndicatorSummary(order);
  const currentPosition = currentPositionRaw
    ? {
        symbol: currentPositionRaw.symbol,
        qty: currentPositionRaw.position,
        averageCost: currentPositionRaw.averageCost,
        unrealizedPnL: currentPositionRaw.unrealizedPnL,
        marketValue: currentPositionRaw.marketValue
      }
    : null;

  let news: MarketNewsItem[] = [];
  if (!marketaux.isConfigured()) {
    if (config.llmAgentFailClosed) {
      await rejectFailClosed(order, 'AI reject (fail-closed): LLM_AGENT_MARKETAUX_API_KEY is not configured', {
        sourceError: 'LLM_AGENT_MARKETAUX_API_KEY is missing'
      });
      return;
    }
  } else {
    try {
      news = await marketaux.getNewsForSymbol(order.instrument, config.LLM_AGENT_NEWS_WINDOW_HOURS, config.LLM_AGENT_MAX_NEWS_ITEMS);
    } catch (error) {
      const message = (error as Error).message;
      if (config.llmAgentFailClosed) {
        await rejectFailClosed(order, 'AI reject (fail-closed): failed to fetch market news', {
          sourceError: message
        });
        return;
      }
      log('warn', 'news fetch failed but continuing due fail-open', { orderId: order.id, message });
    }
  }

  if (!decider.isConfigured()) {
    if (config.llmAgentFailClosed) {
      await rejectFailClosed(order, 'AI reject (fail-closed): LLM_AGENT_OPENAI_API_KEY is not configured', {
        sourceError: 'LLM_AGENT_OPENAI_API_KEY is missing'
      });
      return;
    }
    throw new Error('LLM_AGENT_OPENAI_API_KEY is not configured');
  }

  let llmDecisionId: number | null = null;

  try {
    const decision = await decider.decide({
      order,
      indicatorSummary,
      accountSummary: {
        accountId: accountSummary.accountId,
        metrics: accountSummary.metrics,
        totals: accountSummary.totals,
        openPositions
      },
      currentPosition,
      news,
      nowIso: new Date().toISOString()
    });

    const reason = shorten(decision.reason, 700);
    const aiReasonWithHeadlines = shorten(composeAiReason(reason, news), 1400);

    llmDecisionId = await repo.insertDecision({
      proposedOrderId: order.id,
      symbol: order.instrument,
      decision: decision.decision,
      decisionReason: reason,
      model: config.LLM_AGENT_MODEL,
      promptVersion: config.LLM_AGENT_PROMPT_VERSION,
      decisionConfidence: decision.confidence,
      newsCount: news.length,
      positionSnapshotJson: {
        accountId: accountSummary.accountId,
        metrics: accountSummary.metrics,
        totals: accountSummary.totals,
        indicatorSummary,
        currentPosition,
        openPositions
      },
      newsSnapshotJson: news
    });

    if (decision.decision === 'EXECUTE') {
      try {
        await executionApi.executeProposed(order.id, {
          actor: 'llm-agent',
          decisionSource: 'llm',
          aiDecision: 'EXECUTE',
          aiReason: aiReasonWithHeadlines,
          aiModel: config.LLM_AGENT_MODEL,
          aiDecisionConfidence: decision.confidence,
          llmDecisionId
        });
        log('info', 'llm decision EXECUTE applied', {
          orderId: order.id,
          symbol: order.instrument,
          confidence: decision.confidence
        });
      } catch (error) {
        const message = (error as Error).message;
        await repo.updateDecisionError(llmDecisionId, message);

        if (config.llmAgentFailClosed) {
          await executionApi.rejectProposed(order.id, {
            reason: shorten(`AI reject (fail-closed): execution endpoint failed for EXECUTE decision`, 700),
            actor: 'llm-agent',
            decisionSource: 'llm',
            aiDecision: 'REJECT',
            aiReason: shorten(`execution_api_error: ${message}`, 700),
            aiModel: config.LLM_AGENT_MODEL,
            aiDecisionConfidence: decision.confidence,
            llmDecisionId,
            sourceError: message
          });
          log('warn', 'llm execute failed; fail-closed reject applied', { orderId: order.id, symbol: order.instrument, message });
          return;
        }

        throw error;
      }
      return;
    }

    await executionApi.rejectProposed(order.id, {
      reason: shorten(`AI reject: ${reason}`, 700),
      actor: 'llm-agent',
      decisionSource: 'llm',
      aiDecision: 'REJECT',
      aiReason: aiReasonWithHeadlines,
      aiModel: config.LLM_AGENT_MODEL,
      aiDecisionConfidence: decision.confidence,
      llmDecisionId
    });

    log('info', 'llm decision REJECT applied', {
      orderId: order.id,
      symbol: order.instrument,
      confidence: decision.confidence
    });
  } catch (error) {
    const message = (error as Error).message;

    if (config.llmAgentFailClosed) {
      try {
        await rejectFailClosed(order, 'AI reject (fail-closed): llm decision error', {
          sourceError: message,
          aiReason: shorten(message, 700),
          model: config.LLM_AGENT_MODEL,
          llmDecisionId: llmDecisionId ?? undefined,
          news
        });
        log('warn', 'llm decision failed; fail-closed reject applied', { orderId: order.id, symbol: order.instrument, message });
      } catch (rejectError) {
        log('error', 'llm fail-closed reject failed', {
          orderId: order.id,
          symbol: order.instrument,
          message,
          rejectError: (rejectError as Error).message
        });
      }
      return;
    }

    throw error;
  }
}

async function pollOnce(): Promise<void> {
  const claimed = await repo.claimNextProposed(workerId, config.LLM_AGENT_CLAIM_STALE_MS);
  if (!claimed) return;

  try {
    await processOrder(claimed);
  } finally {
    await repo.releaseClaim(claimed.id, workerId);
  }
}

async function tick(): Promise<void> {
  if (!config.llmAgentEnabled) return;
  if (inFlight) return;

  inFlight = true;
  try {
    await pollOnce();
  } catch (error) {
    log('error', 'poll failed', { message: (error as Error).message });
  } finally {
    inFlight = false;
  }
}

async function main(): Promise<void> {
  await repo.init();

  log('info', 'llm-agent started', {
    enabled: config.llmAgentEnabled,
    pollMs: config.LLM_AGENT_POLL_MS,
    model: config.LLM_AGENT_MODEL,
    failClosed: config.llmAgentFailClosed
  });

  if (!config.llmAgentEnabled) {
    log('warn', 'LLM_AGENT_ENABLED=false; worker idle');
    return;
  }

  timer = setInterval(() => {
    void tick();
  }, config.LLM_AGENT_POLL_MS);

  void tick();
}

main().catch((error) => {
  log('error', 'llm-agent fatal error', { message: (error as Error).message });
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    try {
      if (timer) clearInterval(timer);
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}
