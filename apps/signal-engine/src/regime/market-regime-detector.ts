import type {
  SecType,
  CandleTimeframe,
  DirectionalRegime,
  IndicatorSnapshot,
  RegimeAnalysis,
  TimeframeIndicatorSnapshot,
  TimeframeTrendVotes,
  VolatilityRegime,
} from "@ikbr/shared";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(denominator) || denominator === 0) return fallback;
  return numerator / denominator;
}

function sign(value: number | undefined, deadZone = 0): -1 | 0 | 1 {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    Math.abs(value) <= deadZone
  )
    return 0;
  return value > 0 ? 1 : -1;
}

interface RegimeThresholds {
  directionalScore: number;
  strongDirectionalScore: number;
  atrHigh: number;
  bbHigh: number;
  atrLow: number;
  bbLow: number;
}

interface TimeframeScore {
  timeframe: CandleTimeframe;
  score: number;
  vote: keyof TimeframeTrendVotes;
  reasons: string[];
}

interface VolatilitySample {
  timeframe: CandleTimeframe;
  weight: number;
  atrPct?: number;
  bbWidthPct?: number;
}

const TIMEFRAME_WEIGHTS: Record<CandleTimeframe, number> = {
  "1m": 0.45,
  "5m": 0.75,
  "1h": 1.5,
  "4h": 2,
  "12h": 1.25,
  "1d": 2.25,
  "1w": 1.25,
};

const VOLATILITY_TIMEFRAME_WEIGHTS: Partial<Record<CandleTimeframe, number>> = {
  "1m": 0.25,
  "1h": 0.25,
  "4h": 0.3,
  "1d": 0.2,
};

const THRESHOLDS: Record<string, RegimeThresholds> = {
  STK: {
    directionalScore: 4.5,
    strongDirectionalScore: 6.25,
    atrHigh: 0.012,
    bbHigh: 0.055,
    atrLow: 0.0025,
    bbLow: 0.012,
  },
  CMDTY: {
    directionalScore: 4,
    strongDirectionalScore: 5.5,
    atrHigh: 0.016,
    bbHigh: 0.06,
    atrLow: 0.003,
    bbLow: 0.014,
  },
  FUT: {
    directionalScore: 4,
    strongDirectionalScore: 5.5,
    atrHigh: 0.016,
    bbHigh: 0.06,
    atrLow: 0.003,
    bbLow: 0.014,
  },
  IND: {
    directionalScore: 3.8,
    strongDirectionalScore: 5.25,
    atrHigh: 0.01,
    bbHigh: 0.045,
    atrLow: 0.0018,
    bbLow: 0.01,
  },
};

function thresholdsForSecType(secType: SecType): RegimeThresholds {
  return THRESHOLDS[secType.toUpperCase()] ?? THRESHOLDS.STK;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function trendVote(score: number, weight: number): keyof TimeframeTrendVotes {
  if (score >= weight * 0.45) return "bullish";
  if (score <= -weight * 0.45) return "bearish";
  return "neutral";
}

function scoreTimeframe(
  timeframe: CandleTimeframe,
  snapshot: TimeframeIndicatorSnapshot | undefined,
): TimeframeScore | undefined {
  if (!snapshot) return undefined;

  const weight = TIMEFRAME_WEIGHTS[timeframe];
  let score = 0;
  const reasons: string[] = [];

  if (snapshot.trend === "bullish") {
    score += weight;
    reasons.push(`${timeframe}: bullish trend`);
  } else if (snapshot.trend === "bearish") {
    score -= weight;
    reasons.push(`${timeframe}: bearish trend`);
  }

  if (snapshot.close !== undefined && snapshot.ema50 !== undefined) {
    const contribution = weight * 0.35;
    if (snapshot.close > snapshot.ema50) {
      score += contribution;
      reasons.push(`${timeframe}: close above EMA50`);
    } else if (snapshot.close < snapshot.ema50) {
      score -= contribution;
      reasons.push(`${timeframe}: close below EMA50`);
    }
  }

  if (snapshot.ema20 !== undefined && snapshot.ema50 !== undefined) {
    const contribution = weight * 0.25;
    if (snapshot.ema20 > snapshot.ema50) {
      score += contribution;
      reasons.push(`${timeframe}: EMA20 above EMA50`);
    } else if (snapshot.ema20 < snapshot.ema50) {
      score -= contribution;
      reasons.push(`${timeframe}: EMA20 below EMA50`);
    }
  }

  if (snapshot.close !== undefined && snapshot.ema200 !== undefined) {
    const contribution = weight * 0.25;
    if (snapshot.close > snapshot.ema200) {
      score += contribution;
      reasons.push(`${timeframe}: close above EMA200`);
    } else if (snapshot.close < snapshot.ema200) {
      score -= contribution;
      reasons.push(`${timeframe}: close below EMA200`);
    }
  }

  const macdSign = sign(snapshot.macdHist);
  if (macdSign !== 0) {
    score += macdSign * weight * 0.2;
    reasons.push(
      `${timeframe}: MACD histogram ${macdSign > 0 ? "positive" : "negative"}`,
    );
  }

  const returnSign = sign(snapshot.return20Pct, 0.15);
  if (returnSign !== 0) {
    score += returnSign * weight * 0.25;
    reasons.push(
      `${timeframe}: return20 ${returnSign > 0 ? "positive" : "negative"}`,
    );
  }

  return {
    timeframe,
    score,
    vote: trendVote(score, weight),
    reasons,
  };
}

function currentTimeframeSnapshot(
  price: number,
  indicators: IndicatorSnapshot,
): TimeframeIndicatorSnapshot {
  let trend: TimeframeIndicatorSnapshot["trend"] = "neutral";
  if (
    indicators.ema20 !== undefined &&
    indicators.ema50 !== undefined &&
    price > indicators.ema50 &&
    indicators.ema20 > indicators.ema50
  ) {
    trend = "bullish";
  }
  if (
    indicators.ema20 !== undefined &&
    indicators.ema50 !== undefined &&
    price < indicators.ema50 &&
    indicators.ema20 < indicators.ema50
  ) {
    trend = "bearish";
  }

  return {
    close: price,
    ema20: indicators.ema20,
    ema50: indicators.ema50,
    ema200: indicators.ema200,
    rsi14: indicators.rsi14,
    atr14: indicators.atr14,
    macdHist: indicators.macdHist,
    bbWidthPct: indicators.bbWidthPct,
    trend,
    return20Pct: indicators.return20mPct,
    return48Pct: indicators.return60mPct,
  };
}

function volatilityRegime(
  secType: SecType,
  price: number,
  indicators: IndicatorSnapshot,
  reasons: string[],
): VolatilityRegime {
  const thresholds = thresholdsForSecType(secType);
  const samples = volatilitySamples(price, indicators);

  if (samples.length === 0) {
    reasons.push("volatility normal: no volatility samples");
    return "normal_volatility";
  }

  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const weightedAtr = weightedAverage(samples, (sample) => sample.atrPct);
  const weightedBb = weightedAverage(samples, (sample) => sample.bbWidthPct);
  const highWeight = samples
    .filter((sample) => isHighVolatilitySample(sample, thresholds))
    .reduce((sum, sample) => sum + sample.weight, 0);
  const lowWeight = samples
    .filter((sample) => isLowVolatilitySample(sample, thresholds))
    .reduce((sum, sample) => sum + sample.weight, 0);
  const highShare = totalWeight > 0 ? highWeight / totalWeight : 0;
  const lowShare = totalWeight > 0 ? lowWeight / totalWeight : 0;
  const sampleSummary = samples
    .map((sample) => {
      const atr = sample.atrPct === undefined ? "n/a" : round(sample.atrPct);
      const bb =
        sample.bbWidthPct === undefined ? "n/a" : round(sample.bbWidthPct);
      return `${sample.timeframe}:atr=${atr},bb=${bb}`;
    })
    .join("|");

  if (
    highShare >= 0.4 ||
    (weightedAtr ?? 0) >= thresholds.atrHigh * 0.85 ||
    (weightedBb ?? 0) >= thresholds.bbHigh * 0.85
  ) {
    reasons.push(
      `volatility high: atrPct=${round(weightedAtr ?? 0)}, bbWidthPct=${round(weightedBb ?? 0)}, highShare=${round(highShare)}, samples=${sampleSummary}`,
    );
    return "high_volatility";
  }

  if (
    lowShare >= 0.55 &&
    (weightedAtr ?? Number.POSITIVE_INFINITY) <= thresholds.atrLow * 1.25 &&
    (weightedBb ?? Number.POSITIVE_INFINITY) <= thresholds.bbLow * 1.25
  ) {
    reasons.push(
      `volatility low: atrPct=${round(weightedAtr ?? 0)}, bbWidthPct=${round(weightedBb ?? 0)}, lowShare=${round(lowShare)}, samples=${sampleSummary}`,
    );
    return "low_volatility";
  }

  reasons.push(
    `volatility normal: atrPct=${round(weightedAtr ?? 0)}, bbWidthPct=${round(weightedBb ?? 0)}, highShare=${round(highShare)}, lowShare=${round(lowShare)}, samples=${sampleSummary}`,
  );
  return "normal_volatility";
}

function volatilitySamples(
  price: number,
  indicators: IndicatorSnapshot,
): VolatilitySample[] {
  const current = currentTimeframeSnapshot(price, indicators);
  const snapshots: Array<
    [CandleTimeframe, TimeframeIndicatorSnapshot | undefined]
  > = [
    ["1m", current],
    ["1h", indicators.timeframes?.["1h"]],
    ["4h", indicators.timeframes?.["4h"]],
    ["1d", indicators.timeframes?.["1d"]],
  ];

  return snapshots.flatMap(([timeframe, snapshot]) => {
    if (!snapshot) return [];
    const weight = VOLATILITY_TIMEFRAME_WEIGHTS[timeframe];
    if (weight === undefined) return [];
    const close = snapshot.close ?? (timeframe === "1m" ? price : undefined);
    const atrPct =
      close !== undefined && snapshot.atr14 !== undefined
        ? safeDiv(snapshot.atr14, close, Number.NaN)
        : Number.NaN;
    const bbWidthPct = snapshot.bbWidthPct;
    const hasAtr = Number.isFinite(atrPct);
    const hasBb = bbWidthPct !== undefined && Number.isFinite(bbWidthPct);
    if (!hasAtr && !hasBb) return [];
    return [
      {
        timeframe,
        weight,
        atrPct: hasAtr ? atrPct : undefined,
        bbWidthPct: hasBb ? bbWidthPct : undefined,
      },
    ];
  });
}

function weightedAverage(
  samples: VolatilitySample[],
  selector: (sample: VolatilitySample) => number | undefined,
): number | undefined {
  let weightedSum = 0;
  let weightSum = 0;
  for (const sample of samples) {
    const value = selector(sample);
    if (value === undefined || !Number.isFinite(value)) continue;
    weightedSum += value * sample.weight;
    weightSum += sample.weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : undefined;
}

function isHighVolatilitySample(
  sample: VolatilitySample,
  thresholds: RegimeThresholds,
): boolean {
  return (
    (sample.atrPct !== undefined && sample.atrPct >= thresholds.atrHigh) ||
    (sample.bbWidthPct !== undefined && sample.bbWidthPct >= thresholds.bbHigh)
  );
}

function isLowVolatilitySample(
  sample: VolatilitySample,
  thresholds: RegimeThresholds,
): boolean {
  const atrLow =
    sample.atrPct !== undefined && sample.atrPct <= thresholds.atrLow;
  const bbLow =
    sample.bbWidthPct !== undefined &&
    sample.bbWidthPct > 0 &&
    sample.bbWidthPct <= thresholds.bbLow;
  return atrLow && bbLow;
}

export class MarketRegimeDetector {
  detectDetailed(
    secType: SecType,
    price: number,
    indicators: IndicatorSnapshot,
  ): RegimeAnalysis {
    const thresholds = thresholdsForSecType(secType);
    const reasons: string[] = [];
    const timeframeScores: TimeframeScore[] = [
      scoreTimeframe("1m", currentTimeframeSnapshot(price, indicators)),
      scoreTimeframe("5m", indicators.timeframes?.["5m"]),
      scoreTimeframe("1h", indicators.timeframes?.["1h"]),
      scoreTimeframe("4h", indicators.timeframes?.["4h"]),
      scoreTimeframe("12h", indicators.timeframes?.["12h"]),
      scoreTimeframe("1d", indicators.timeframes?.["1d"]),
      scoreTimeframe("1w", indicators.timeframes?.["1w"]),
    ].filter((score): score is TimeframeScore => score !== undefined);

    const score = timeframeScores.reduce((sum, item) => sum + item.score, 0);
    const timeframeTrendScores: Partial<Record<CandleTimeframe, number>> = {};
    const timeframeTrendVotes: TimeframeTrendVotes = {
      bullish: 0,
      bearish: 0,
      neutral: 0,
    };
    for (const item of timeframeScores) {
      timeframeTrendScores[item.timeframe] = round(item.score);
      timeframeTrendVotes[item.vote] += 1;
    }

    const majorVotes = timeframeScores.filter(
      (item) =>
        item.timeframe === "1h" ||
        item.timeframe === "4h" ||
        item.timeframe === "1d" ||
        item.timeframe === "1w",
    );
    const majorBullish = majorVotes.filter(
      (item) => item.vote === "bullish",
    ).length;
    const majorBearish = majorVotes.filter(
      (item) => item.vote === "bearish",
    ).length;

    let directionalRegime: DirectionalRegime = "range";
    if (score >= thresholds.directionalScore && majorBullish >= 2) {
      directionalRegime = "bull_trend";
      reasons.push(
        `direction bull_trend: score=${round(score)}, majorBullish=${majorBullish}`,
      );
    } else if (score <= -thresholds.directionalScore && majorBearish >= 2) {
      directionalRegime = "bear_trend";
      reasons.push(
        `direction bear_trend: score=${round(score)}, majorBearish=${majorBearish}`,
      );
    } else {
      reasons.push(
        `direction range: score=${round(score)}, majorBullish=${majorBullish}, majorBearish=${majorBearish}`,
      );
    }

    const volRegime = volatilityRegime(secType, price, indicators, reasons);
    const maxScore = timeframeScores.reduce(
      (sum, item) => sum + TIMEFRAME_WEIGHTS[item.timeframe] * 2.3,
      0,
    );
    const directionalConfidence =
      maxScore > 0 ? clamp(Math.abs(score) / maxScore, 0, 1) : 0;
    const confirmationConfidence =
      majorVotes.length > 0
        ? clamp(Math.max(majorBullish, majorBearish) / majorVotes.length, 0, 1)
        : 0;
    const confidence = clamp(
      directionalConfidence * 0.65 + confirmationConfidence * 0.35,
      0,
      1,
    );

    const strongestTimeframes = [...timeframeScores]
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 3);
    for (const item of strongestTimeframes) {
      reasons.push(
        `${item.timeframe} score=${round(item.score)} vote=${item.vote}`,
      );
    }

    return {
      directionalRegime,
      volatilityRegime: volRegime,
      score: round(score),
      confidence: round(confidence),
      reasons: reasons.slice(0, 12),
      timeframeTrendScores,
      timeframeTrendVotes,
    };
  }
}
