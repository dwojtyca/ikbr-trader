import type { Candle, SecType } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategyDirection,
  StrategySignal,
} from "./strategy.types.js";

interface RangeReversalParams {
  rsiLongMax: number;
  rsiShortMin: number;
  rangeWidthMinPct: number;
  rangeWidthMaxPct: number;
  edgeDistanceAtr: number;
  edgeDistancePct: number;
  rejectionCloseLocationMin: number;
  rejectionBodyMin: number;
  wickMin: number;
  volumeMultiplier: number;
  stopAtrMult: number;
  structureStopAtrMult: number;
  minRewardRisk: number;
  highVolMinRewardRisk: number;
  plannedRewardMinPct: number;
  sessionUtcStartHour: number;
  sessionUtcEndHour: number;
}

interface Candidate {
  side: "BUY" | "SELL";
  direction: StrategyDirection;
  confidenceScore: number;
  entryReason: string;
  stopLoss: number;
  takeProfit: number;
  metadata: Record<string, unknown>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function paramsForSecType(_secType: SecType): RangeReversalParams {
  return {
    // Stage 3: stricter entry filters to cut over-trading and improve win quality.
    rsiLongMax: 32,
    rsiShortMin: 68,
    rangeWidthMinPct: 1.0,
    rangeWidthMaxPct: 5,
    edgeDistanceAtr: 0.25,
    edgeDistancePct: 0.12,
    rejectionCloseLocationMin: 0.58,
    rejectionBodyMin: 0.08,
    wickMin: 0.18,
    volumeMultiplier: 1.1,
    // Stage 6: looser stop to reduce noise wicks killing valid reversals.
    stopAtrMult: 1.6,
    structureStopAtrMult: 2.5,
    // Stage 1 R:R fix: net edge requires reward >> risk to overcome ~2x commissions
    // and ~33% historical win rate. Previous values (0.9 / 1.1) yielded negative EV.
    minRewardRisk: 1.6,
    highVolMinRewardRisk: 2.0,
    // Reject setups whose planned reward is too small to overcome round-trip commissions.
    plannedRewardMinPct: 0.4,
    sessionUtcStartHour: 8,
    sessionUtcEndHour: 20,
  };
}

function utcHour(ts: Date | string): number {
  return new Date(ts).getUTCHours();
}

function isWithinUtcSession(
  ts: Date | string,
  startHour: number,
  endHour: number,
): boolean {
  const hour = utcHour(ts);
  return hour >= startHour && hour <= endHour;
}

function averageVolume(
  candles: Candle[],
  lookback: number,
): number | undefined {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return undefined;
  return slice.reduce((sum, candle) => sum + candle.volume, 0) / slice.length;
}

function localLow(candles: Candle[], lookback: number): number | undefined {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return undefined;
  return Math.min(...slice.map((candle) => candle.low));
}

function localHigh(candles: Candle[], lookback: number): number | undefined {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return undefined;
  return Math.max(...slice.map((candle) => candle.high));
}

function candleQuality(candle: Candle): {
  closeLocationPct: number;
  bodyPct: number;
  lowerWickPct: number;
  upperWickPct: number;
  bullishBody: boolean;
  bearishBody: boolean;
} {
  const range = candle.high - candle.low;
  if (!Number.isFinite(range) || range <= 0) {
    return {
      closeLocationPct: 0.5,
      bodyPct: 0,
      lowerWickPct: 0,
      upperWickPct: 0,
      bullishBody: false,
      bearishBody: false,
    };
  }

  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  return {
    closeLocationPct: (candle.close - candle.low) / range,
    bodyPct: Math.abs(candle.close - candle.open) / range,
    lowerWickPct: (bodyLow - candle.low) / range,
    upperWickPct: (candle.high - bodyHigh) / range,
    bullishBody: candle.close > candle.open,
    bearishBody: candle.close < candle.open,
  };
}

export class RangeReversalStrategy implements Strategy {
  readonly id = "range_reversal_v1";
  readonly secTypes: readonly SecType[] = ["STK", "IND", "ETF", "CMDTY", "FUT"];
  readonly supportedDirections = ["LONG", "SHORT"] as const;
  readonly allowedDirectionalRegimes = ["range"] as const;
  readonly allowedVolatilityRegimes = [
    "normal_volatility",
    "high_volatility",
  ] as const;
  readonly requiredTimeframes = ["1m", "1h", "4h"] as const;
  private lastRejectionReason: string | undefined;

  getLastRejectionReason(): string | undefined {
    return this.lastRejectionReason;
  }

  generateSignal(context: StrategyContext): StrategySignal | null {
    this.lastRejectionReason = undefined;

    if (!this.secTypes.includes(context.secType))
      return this.reject("sec_type_not_supported");
    if (context.directionalRegime !== "range")
      return this.reject("directional_regime_not_range");
    if (context.volatilityRegime === "low_volatility")
      return this.reject("volatility_regime_low_volatility");

    const params = paramsForSecType(context.secType);
    if (
      !isWithinUtcSession(
        context.latestCandle.ts,
        params.sessionUtcStartHour,
        params.sessionUtcEndHour,
      )
    ) {
      return this.reject("outside_strategy_session");
    }

    const { indicators, latestCandle } = context;
    const close = latestCandle.close;
    const atr14 = indicators.atr14;
    const rsi14 = indicators.rsi14;
    const bbUpper = indicators.bbUpper;
    const bbMiddle = indicators.bbMiddle;
    const bbLower = indicators.bbLower;
    const dcUpper20 = indicators.dcUpper20;
    const dcLower20 = indicators.dcLower20;

    if (
      atr14 === undefined ||
      rsi14 === undefined ||
      bbUpper === undefined ||
      bbMiddle === undefined ||
      bbLower === undefined ||
      dcUpper20 === undefined ||
      dcLower20 === undefined
    ) {
      return this.reject("missing_required_indicators");
    }
    if (atr14 <= 0 || close <= 0) return this.reject("invalid_price_or_atr");

    const rangeWidthPct = ((dcUpper20 - dcLower20) / close) * 100;
    if (rangeWidthPct < params.rangeWidthMinPct)
      return this.reject("range_too_narrow");
    if (rangeWidthPct > params.rangeWidthMaxPct)
      return this.reject("range_too_wide");

    const candles1m = context.candlesByTimeframe["1m"] ?? [];
    const previousAverageVolume = averageVolume(candles1m.slice(0, -1), 20);
    if (previousAverageVolume === undefined || previousAverageVolume <= 0)
      return this.reject("volume_baseline_unavailable");
    if (latestCandle.volume < previousAverageVolume * params.volumeMultiplier)
      return this.reject("volume_not_confirmed");

    const quality = candleQuality(latestCandle);
    const minRewardRisk =
      context.volatilityRegime === "high_volatility"
        ? params.highVolMinRewardRisk
        : params.minRewardRisk;

    const longCandidate = this.buildLongCandidate({
      context,
      params,
      close,
      atr14,
      rsi14,
      bbLower,
      bbMiddle,
      dcLower20,
      dcUpper20,
      rangeWidthPct,
      previousAverageVolume,
      quality,
      minRewardRisk,
    });
    const shortCandidate = this.buildShortCandidate({
      context,
      params,
      close,
      atr14,
      rsi14,
      bbUpper,
      bbMiddle,
      dcLower20,
      dcUpper20,
      rangeWidthPct,
      previousAverageVolume,
      quality,
      minRewardRisk,
    });

    const candidates = [longCandidate, shortCandidate].filter(
      (candidate): candidate is Candidate => candidate !== null,
    );
    if (candidates.length === 0) {
      return this.reject("no_range_reversal_setup");
    }
    candidates.sort((a, b) => b.confidenceScore - a.confidenceScore);
    const candidate = candidates[0];

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: candidate.side,
      direction: candidate.direction,
      confidenceScore: candidate.confidenceScore,
      entryReason: candidate.entryReason,
      invalidationLevel: candidate.stopLoss,
      suggestedEntry: close,
      stopLoss: candidate.stopLoss,
      takeProfit: candidate.takeProfit,
      metadata: candidate.metadata,
      generatedFromCandleTs: latestCandle.ts,
    };
  }

  private buildLongCandidate(input: {
    context: StrategyContext;
    params: RangeReversalParams;
    close: number;
    atr14: number;
    rsi14: number;
    bbLower: number;
    bbMiddle: number;
    dcLower20: number;
    dcUpper20: number;
    rangeWidthPct: number;
    previousAverageVolume: number;
    quality: ReturnType<typeof candleQuality>;
    minRewardRisk: number;
  }): Candidate | null {
    const {
      context,
      params,
      close,
      atr14,
      rsi14,
      bbLower,
      bbMiddle,
      dcLower20,
      dcUpper20,
      rangeWidthPct,
      previousAverageVolume,
      quality,
      minRewardRisk,
    } = input;
    const latest = context.latestCandle;
    // Stage 3: require the latest candle to actually pierce the lower band/Donchian edge.
    if (latest.low > bbLower && latest.low > dcLower20) return null;
    // Stage 6: require close to recover BACK above the lower band (not just wicked through).
    if (latest.close < bbLower) return null;
    const edgeDistance = Math.min(
      Math.abs(close - bbLower),
      Math.abs(close - dcLower20),
    );
    const edgeThreshold = Math.max(
      atr14 * params.edgeDistanceAtr,
      close * (params.edgeDistancePct / 100),
    );
    if (edgeDistance > edgeThreshold) return null;
    if (rsi14 > params.rsiLongMax) return null;
    // Stage 6: RSI must already be turning up from the oversold zone
    // (avoid catching a falling knife where momentum is still down).
    if (
      context.indicators.rsi14Prev !== undefined &&
      rsi14 <= context.indicators.rsi14Prev
    )
      return null;
    if (!quality.bullishBody) return null;
    if (quality.closeLocationPct < params.rejectionCloseLocationMin)
      return null;
    if (quality.bodyPct < params.rejectionBodyMin) return null;
    if (quality.lowerWickPct < params.wickMin) return null;
    if (
      context.indicators.cmf20 !== undefined &&
      context.indicators.cmf20 < -0.2
    )
      return null;
    if (context.indicators.mfi14 !== undefined && context.indicators.mfi14 < 18)
      return null;
    // Stage 4: do not buy reversals against a 1h downtrend.
    const tf1hLong = context.indicators.timeframes?.["1h"];
    if (tf1hLong?.trend === "bearish") return null;
    // Stage 6: also reject longs against a 4h downtrend.
    const tf4hLong = context.indicators.timeframes?.["4h"];
    if (tf4hLong?.trend === "bearish") return null;

    const candles1m = context.candlesByTimeframe["1m"] ?? [];
    const swingLow = localLow(candles1m, 20);
    const atrStop = close - atr14 * params.stopAtrMult;
    const structureStop =
      swingLow !== undefined && swingLow < close
        ? Math.max(swingLow, close - atr14 * params.structureStopAtrMult)
        : undefined;
    const stopLoss = Math.min(atrStop, structureStop ?? atrStop);
    if (!Number.isFinite(stopLoss) || stopLoss >= close) return null;

    const takeProfit = Math.min(
      bbMiddle,
      close + (dcUpper20 - dcLower20) * 0.5,
    );
    if (!Number.isFinite(takeProfit) || takeProfit <= close) return null;
    const riskPerShare = close - stopLoss;
    const rewardPerShare = takeProfit - close;
    const rewardRisk = rewardPerShare / riskPerShare;
    if (rewardRisk < minRewardRisk) return null;
    const rewardPct = (rewardPerShare / close) * 100;
    if (rewardPct < params.plannedRewardMinPct) return null;

    const edgeScore = clamp(1 - edgeDistance / edgeThreshold, 0, 1) * 0.1;
    const rsiScore = clamp((params.rsiLongMax - rsi14) / 18, 0, 1) * 0.08;
    const rejectionScore =
      clamp(
        quality.closeLocationPct - params.rejectionCloseLocationMin,
        0,
        0.35,
      ) *
        0.18 +
      clamp(quality.lowerWickPct - params.wickMin, 0, 0.45) * 0.12;
    const confidenceScore = clamp(
      0.58 + edgeScore + rsiScore + rejectionScore,
      0,
      0.84,
    );

    return {
      side: "BUY",
      direction: "LONG",
      confidenceScore,
      entryReason: `Range reversal long: close=${close.toFixed(2)}, lowerEdge=${Math.min(bbLower, dcLower20).toFixed(2)}, RSI14=${rsi14.toFixed(1)}, rangeWidth=${rangeWidthPct.toFixed(2)}%`,
      stopLoss,
      takeProfit,
      metadata: {
        direction: "long",
        atr14,
        rsi14,
        bbLower,
        bbMiddle,
        dcLower20,
        dcUpper20,
        edgeDistance,
        edgeThreshold,
        rangeWidthPct,
        rewardRisk,
        minRewardRisk,
        stopAtrMult: params.stopAtrMult,
        structureStopAtrMult: params.structureStopAtrMult,
        previousAverageVolume,
        latestVolume: latest.volume,
        closeLocationPct: quality.closeLocationPct,
        bodyPct: quality.bodyPct,
        lowerWickPct: quality.lowerWickPct,
        directionalRegime: context.indicators.directionalRegime,
        volatilityRegime: context.indicators.volatilityRegime,
        regimeScore: context.indicators.regimeScore,
        regimeConfidence: context.indicators.regimeConfidence,
        swingLow,
      },
    };
  }

  private buildShortCandidate(input: {
    context: StrategyContext;
    params: RangeReversalParams;
    close: number;
    atr14: number;
    rsi14: number;
    bbUpper: number;
    bbMiddle: number;
    dcLower20: number;
    dcUpper20: number;
    rangeWidthPct: number;
    previousAverageVolume: number;
    quality: ReturnType<typeof candleQuality>;
    minRewardRisk: number;
  }): Candidate | null {
    const {
      context,
      params,
      close,
      atr14,
      rsi14,
      bbUpper,
      bbMiddle,
      dcLower20,
      dcUpper20,
      rangeWidthPct,
      previousAverageVolume,
      quality,
      minRewardRisk,
    } = input;
    const latest = context.latestCandle;
    // Stage 3: require the latest candle to actually pierce the upper band/Donchian edge.
    if (latest.high < bbUpper && latest.high < dcUpper20) return null;
    // Stage 6: require close to recover BACK below the upper band (not just wicked through).
    if (latest.close > bbUpper) return null;
    const edgeDistance = Math.min(
      Math.abs(close - bbUpper),
      Math.abs(close - dcUpper20),
    );
    const edgeThreshold = Math.max(
      atr14 * params.edgeDistanceAtr,
      close * (params.edgeDistancePct / 100),
    );
    if (edgeDistance > edgeThreshold) return null;
    if (rsi14 < params.rsiShortMin) return null;
    // Stage 6: RSI must already be turning down from the overbought zone.
    if (
      context.indicators.rsi14Prev !== undefined &&
      rsi14 >= context.indicators.rsi14Prev
    )
      return null;
    if (!quality.bearishBody) return null;
    if (1 - quality.closeLocationPct < params.rejectionCloseLocationMin)
      return null;
    if (quality.bodyPct < params.rejectionBodyMin) return null;
    if (quality.upperWickPct < params.wickMin) return null;
    if (
      context.indicators.cmf20 !== undefined &&
      context.indicators.cmf20 > 0.2
    )
      return null;
    if (context.indicators.mfi14 !== undefined && context.indicators.mfi14 > 82)
      return null;
    // Stage 4: do not short reversals against a 1h uptrend.
    const tf1hShort = context.indicators.timeframes?.["1h"];
    if (tf1hShort?.trend === "bullish") return null;
    // Stage 6: also reject shorts against a 4h uptrend.
    const tf4hShort = context.indicators.timeframes?.["4h"];
    if (tf4hShort?.trend === "bullish") return null;

    const candles1m = context.candlesByTimeframe["1m"] ?? [];
    const swingHigh = localHigh(candles1m, 20);
    const atrStop = close + atr14 * params.stopAtrMult;
    const structureStop =
      swingHigh !== undefined && swingHigh > close
        ? Math.min(swingHigh, close + atr14 * params.structureStopAtrMult)
        : undefined;
    const stopLoss = Math.max(atrStop, structureStop ?? atrStop);
    if (!Number.isFinite(stopLoss) || stopLoss <= close) return null;

    const takeProfit = Math.max(
      bbMiddle,
      close - (dcUpper20 - dcLower20) * 0.5,
    );
    if (!Number.isFinite(takeProfit) || takeProfit >= close) return null;
    const riskPerShare = stopLoss - close;
    const rewardPerShare = close - takeProfit;
    const rewardRisk = rewardPerShare / riskPerShare;
    if (rewardRisk < minRewardRisk) return null;
    const rewardPct = (rewardPerShare / close) * 100;
    if (rewardPct < params.plannedRewardMinPct) return null;

    const edgeScore = clamp(1 - edgeDistance / edgeThreshold, 0, 1) * 0.1;
    const rsiScore = clamp((rsi14 - params.rsiShortMin) / 18, 0, 1) * 0.08;
    const rejectionScore =
      clamp(
        1 - quality.closeLocationPct - params.rejectionCloseLocationMin,
        0,
        0.35,
      ) *
        0.18 +
      clamp(quality.upperWickPct - params.wickMin, 0, 0.45) * 0.12;
    const confidenceScore = clamp(
      0.58 + edgeScore + rsiScore + rejectionScore,
      0,
      0.84,
    );

    return {
      side: "SELL",
      direction: "SHORT",
      confidenceScore,
      entryReason: `Range reversal short: close=${close.toFixed(2)}, upperEdge=${Math.max(bbUpper, dcUpper20).toFixed(2)}, RSI14=${rsi14.toFixed(1)}, rangeWidth=${rangeWidthPct.toFixed(2)}%`,
      stopLoss,
      takeProfit,
      metadata: {
        direction: "short",
        atr14,
        rsi14,
        bbUpper,
        bbMiddle,
        dcLower20,
        dcUpper20,
        edgeDistance,
        edgeThreshold,
        rangeWidthPct,
        rewardRisk,
        minRewardRisk,
        stopAtrMult: params.stopAtrMult,
        structureStopAtrMult: params.structureStopAtrMult,
        previousAverageVolume,
        latestVolume: latest.volume,
        closeLocationPct: quality.closeLocationPct,
        bodyPct: quality.bodyPct,
        upperWickPct: quality.upperWickPct,
        directionalRegime: context.indicators.directionalRegime,
        volatilityRegime: context.indicators.volatilityRegime,
        regimeScore: context.indicators.regimeScore,
        regimeConfidence: context.indicators.regimeConfidence,
        swingHigh,
      },
    };
  }

  private reject(reason: string): null {
    this.lastRejectionReason = reason;
    return null;
  }
}
