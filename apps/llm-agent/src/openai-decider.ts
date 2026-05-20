import { z } from "zod";
import { IndicatorSnapshot } from "@ikbr/shared";
import { ClaimedOrder } from "./repository.js";
import { MarketNewsItem } from "./marketaux-client.js";

const decisionSchema = z.object({
  decision: z.enum(["EXECUTE", "REJECT"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(3),
  riskFlags: z.array(z.string()).optional(),
});

export interface DecisionContext {
  order: ClaimedOrder;
  indicatorSummary: {
    ema20?: number;
    ema50?: number;
    ema200?: number;
    rsi14?: number;
    atr14?: number;
    macdHist?: number;
    bbWidthPct?: number;
    trendFilterValue?: number;
    trendFilterSource?: IndicatorSnapshot["trendFilterSource"];
    secType?: IndicatorSnapshot["secType"];
    directionalRegime?: IndicatorSnapshot["directionalRegime"];
    volatilityRegime?: IndicatorSnapshot["volatilityRegime"];
    regimeScore?: IndicatorSnapshot["regimeScore"];
    regimeConfidence?: IndicatorSnapshot["regimeConfidence"];
    regimeReasons?: IndicatorSnapshot["regimeReasons"];
    timeframeTrendScores?: IndicatorSnapshot["timeframeTrendScores"];
    timeframeTrendVotes?: IndicatorSnapshot["timeframeTrendVotes"];
    strategyProfile?: string;
    timeframes?: IndicatorSnapshot["timeframes"];
  } | null;
  accountSummary: {
    accountId: string;
    metrics?: {
      netLiquidation?: number;
      totalCashValue?: number;
      buyingPower?: number;
      availableFunds?: number;
      excessLiquidity?: number;
      equityWithLoanValue?: number;
    };
    totals: {
      positionsCount: number;
      grossExposure: number;
      netExposure: number;
      unrealizedPnL: number;
      realizedPnL: number;
    };
    openPositions: Array<{
      symbol: string;
      position: number;
      marketValue?: number;
      averageCost?: number;
      unrealizedPnL?: number;
      realizedPnL?: number;
    }>;
  };
  currentPosition: {
    symbol: string;
    qty: number;
    averageCost?: number;
    unrealizedPnL?: number;
    marketValue?: number;
  } | null;
  news: MarketNewsItem[];
  nowIso: string;
}

export interface LlmDecision {
  decision: "EXECUTE" | "REJECT";
  confidence: number;
  reason: string;
  riskFlags: string[];
}

interface OpenAiDeciderOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  promptVersion: string;
  maxOpenNotionalPct: number;
}

export class OpenAiDecider {
  constructor(private readonly options: OpenAiDeciderOptions) {}

  isConfigured(): boolean {
    return Boolean(this.options.apiKey);
  }

  async decide(context: DecisionContext): Promise<LlmDecision> {
    if (!this.options.apiKey) {
      throw new Error("LLM_AGENT_OPENAI_API_KEY is not configured");
    }

    const systemPrompt = [
      "You are an autonomous trade execution gatekeeper for a paper/live IBKR bot.",
      "Goal: choose EXECUTE or REJECT for a proposed order.",
      "Rules:",
      "- Be conservative around unclear market/news context.",
      "- Always evaluate the order against the current open positions across the whole account, not only the same symbol.",
      "- Reject trades that obviously duplicate existing exposure, create unhealthy concentration, or conflict with current portfolio positioning unless there is a strong justification.",
      "- For OPEN_OR_ADD trades, reject orders that would create a single-name concentration that is too large for the account, even if buying power technically allows it.",
      "- For OPEN_OR_ADD trades, be cautious when the proposed side would materially increase same-direction exposure (for example, more long exposure when the account is already heavily long).",
      "- When judging order size or concentration, use account metrics such as netLiquidation, availableFunds, buyingPower, and equityWithLoanValue as the primary scale of the account.",
      "- Do not reject a trade only because its notional is much larger than current grossExposure; a mostly-cash account can still support a first position if the order is reasonable relative to account size and available funds.",
      `- The risk engine has already enforced sizing limits; OPEN_OR_ADD trades up to roughly ${this.options.maxOpenNotionalPct}% of netLiquidation are expected and should not be rejected on notional size alone. Only reject for notional reasons if the order materially exceeds this budget or creates extreme single-name dominance beyond it.`,
      "- If the order closes or reduces an existing position, that can be a positive factor.",
      "- Treat indicatorSummary as a compact technical snapshot from the signal engine.",
      "- indicatorSummary.directionalRegime classifies trend direction; indicatorSummary.volatilityRegime classifies volatility separately.",
      "- indicatorSummary.regimeScore, regimeConfidence, timeframeTrendScores, timeframeTrendVotes, and regimeReasons explain how strongly the signal engine classified the market context.",
      "- indicatorSummary.timeframes contains compact 5m/1h/4h/12h/1d/1w confirmation snapshots; use higher timeframe alignment as stronger evidence than the latest 1m candle alone.",
      "- For new longs, 4h/1d/1w bullish or neutral alignment is supportive; bearish higher timeframes should lower conviction unless the strategy is explicitly mean-reversion.",
      "- For new shorts, 4h/1d/1w bearish or neutral alignment is supportive; bullish higher timeframes should lower conviction unless the strategy is explicitly mean-reversion.",
      "- Global technical heuristics: for longs, ema20 > ema50 and ema50 >= ema200 is supportive; for shorts, ema20 < ema50 and ema50 <= ema200 is supportive.",
      "- Global technical heuristics: a positive macdHist supports longs; a negative macdHist supports shorts. A contradictory MACD reading weakens conviction.",
      "- Global technical heuristics: RSI above 70 should make you more cautious about opening new longs; RSI below 30 should make you more cautious about opening new shorts.",
      "- If positionEffect is CLOSE_OR_REDUCE, be more permissive than for OPEN_OR_ADD because reducing risk is usually beneficial.",
      "- Global technical heuristics: high bbWidthPct or large atr14 implies elevated volatility; require stronger confirmation and cleaner news before approving new OPEN_OR_ADD trades.",
      "- If indicatorSummary directionalRegime or strategyProfile conflicts with the proposed side, lower conviction.",
      "- When indicatorSummary.directionalRegime is bull_trend: prioritize long trend-following alignment, allow strong continuation entries, and distrust mean-reversion arguments against the dominant bullish EMA structure.",
      "- When indicatorSummary.directionalRegime is bear_trend: prioritize short trend-following alignment, be skeptical of new longs, and distrust bullish continuation arguments against the dominant bearish EMA structure.",
      "- When indicatorSummary.directionalRegime is range: be skeptical of breakout continuation, prefer mean-reversion logic, and treat stretched RSI or price extremes as stronger reversal evidence than EMA alignment alone.",
      "- When indicatorSummary.volatilityRegime is high_volatility: raise the bar for OPEN_OR_ADD trades, require cleaner agreement between side, momentum, and news, and be quicker to reject marginal setups.",
      "- When indicatorSummary.volatilityRegime is low_volatility: treat price as compressed or consolidating; require a clear catalyst, breakout, or volume expansion before approving momentum entries.",
      "- When strategyProfile suggests range behavior, do not overvalue trend continuation signals; when strategyProfile suggests trend or breakout behavior, do not overvalue contrarian RSI alone.",
      "- If risk of immediate adverse move seems elevated, REJECT.",
      "- If signal quality, position context, and recent news are supportive, EXECUTE.",
      "- Return strict JSON only with keys: decision, confidence, reason, riskFlags.",
      "- confidence must be a number between 0 and 1.",
      "- reason must be concise, one sentence.",
    ].join("\n");

    const userPayload = {
      promptVersion: this.options.promptVersion,
      now: context.nowIso,
      order: {
        id: context.order.id,
        instrument: context.order.instrument,
        side: context.order.side,
        positionEffect: context.order.positionEffect,
        orderType: context.order.orderType,
        quantity: context.order.quantity,
        entry: context.order.entry,
        stop: context.order.stop,
        takeProfit: context.order.takeProfit,
        strategy: context.order.strategy,
        confidence: context.order.confidence,
        reason: context.order.reason,
      },
      indicatorSummary: context.indicatorSummary,
      account: context.accountSummary,
      currentPosition: context.currentPosition,
      news: context.news,
    };

    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs,
    );

    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.options.model,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: JSON.stringify(userPayload) },
            ],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error(
            `OpenAI request timed out after ${this.options.timeoutMs}ms`,
          );
        }
        throw error;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `OpenAI error: ${response.status} ${response.statusText}: ${text}`,
        );
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = payload.choices?.[0]?.message?.content;
      if (!content || typeof content !== "string") {
        throw new Error("OpenAI response does not contain message.content");
      }

      const parsed = this.parseJson(content);
      const normalized = decisionSchema.parse(parsed);

      return {
        decision: normalized.decision,
        confidence: normalized.confidence,
        reason: normalized.reason.trim(),
        riskFlags: normalized.riskFlags ?? [],
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseJson(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Cannot parse JSON from OpenAI response");
      return JSON.parse(match[0]);
    }
  }
}
