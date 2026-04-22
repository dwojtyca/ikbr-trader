import { AssetClass, IndicatorSnapshot, MarketRegime, ProposedOrder, RiskLimits, Side } from '@ikbr/shared';
import { lastAtr, lastBollinger, lastDonchian, lastEma, lastMacd, lastObvSlope, lastRsi } from './indicators.js';
import { ExposureSnapshot, SignalRepository } from './repository.js';
import { inferAssetClass, pickStrategyProfile, StrategyProfile } from './strategy-profiles.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(denominator) || denominator === 0) return fallback;
  return numerator / denominator;
}

interface SignalEngineOptions {
  minCandles: number;
  maxSpreadBps: number;
  minVolume1m: number;
  volumeFilterMode: 'strict' | 'off';
  atrStopMult: number;
  atrTpMult: number;
  minConfidence: number;
  lmtEntryMode: 'touch' | 'last' | 'mid';
  lmtEntryBufferBps: number;
  minStopBpsByAssetClass: Record<AssetClass, number>;
  maxMarketStateAgeMs: number;
  assetClassBySymbol: Record<string, AssetClass>;
  executionBaseUrl: string;
  riskLimits: RiskLimits;
}

interface DecisionScore {
  side: Side;
  score: number;
  buyScore: number;
  sellScore: number;
}

interface EntryPriceSelection {
  entry: number;
  source: 'touch' | 'last' | 'mid' | 'fallback_last';
}

export class SignalEngine {
  constructor(
    private readonly repo: SignalRepository,
    private readonly options: SignalEngineOptions
  ) {}

  async runForSymbol(symbol: string, exposureSnapshot?: ExposureSnapshot, generatedFromCandleTs?: Date): Promise<ProposedOrder> {
    const candles = await this.repo.getRecentCandles(symbol, '1m', this.options.minCandles + 80);
    const candles1h = await this.repo.getRecentCandles(symbol, '1h', 160);

    if (candles.length < this.options.minCandles) {
      return this.rejectedOrder(symbol, undefined, 'Insufficient candles for indicators', undefined, 'HOLD', 'adaptive_profile_v1', generatedFromCandleTs);
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);
    const latest = candles[candles.length - 1];
    const assetClass = this.resolveAssetClass(symbol);

    const trendFrom1h = lastEma(candles1h.map((c) => c.close), 50);
    const trendFrom1m = lastEma(closes, 200);
    const trendFilterValue = trendFrom1h ?? trendFrom1m;

    const macdSnapshot = lastMacd(closes);
    const bbSnapshot = lastBollinger(closes, 20);
    const donchianSnapshot = lastDonchian(closes, 20);
    const obvSlope = lastObvSlope(closes, volumes, 8);

    const indicators: IndicatorSnapshot = {
      ema20: lastEma(closes, 20),
      ema50: lastEma(closes, 50),
      ema200: lastEma(closes, 200),
      rsi14: lastRsi(closes, 14),
      atr14: lastAtr(highs, lows, closes, 14),
      macdLine: macdSnapshot.macdLine,
      macdSignal: macdSnapshot.signalLine,
      macdHist: macdSnapshot.histogram,
      macdHistPrev: macdSnapshot.previousHistogram,
      bbUpper: bbSnapshot.upper,
      bbMiddle: bbSnapshot.middle,
      bbLower: bbSnapshot.lower,
      bbWidthPct: bbSnapshot.widthPct,
      dcUpper20: donchianSnapshot.upper,
      dcLower20: donchianSnapshot.lower,
      obvSlope,
      trendFilterValue,
      trendFilterSource: trendFrom1h !== undefined ? 'EMA50_1h' : 'EMA200_1m',
      assetClass
    };

    if (
      indicators.ema20 === undefined ||
      indicators.ema50 === undefined ||
      indicators.ema200 === undefined ||
      indicators.rsi14 === undefined ||
      indicators.atr14 === undefined ||
      indicators.macdLine === undefined ||
      indicators.macdSignal === undefined ||
      indicators.macdHist === undefined ||
      indicators.bbUpper === undefined ||
      indicators.bbMiddle === undefined ||
      indicators.bbLower === undefined ||
      indicators.dcUpper20 === undefined ||
      indicators.dcLower20 === undefined ||
      indicators.trendFilterValue === undefined
    ) {
      return this.rejectedOrder(symbol, latest.conid, 'Indicator values are not available', indicators, 'HOLD', 'adaptive_profile_v1', generatedFromCandleTs);
    }

    const regime = this.detectRegime(assetClass, latest.close, indicators);
    const profile = pickStrategyProfile(assetClass, regime);

    indicators.regime = regime;
    indicators.strategyProfile = profile.id;

    const applyVolumeFilter = profile.requireVolume && this.options.volumeFilterMode === 'strict';

    if (applyVolumeFilter && volumes[volumes.length - 1] < this.options.minVolume1m) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Liquidity filter rejected signal for profile ${profile.id}: low 1m volume`,
        indicators,
        'HOLD',
        profile.id,
        generatedFromCandleTs
      );
    }

    const marketState = await this.repo.getMarketState(latest.conid);
    if (!marketState) {
      return this.rejectedOrder(symbol, latest.conid, 'No market state in Redis for conid', indicators, 'HOLD', profile.id, generatedFromCandleTs);
    }

    const marketStateTs = new Date(marketState.ts);
    if (
      this.options.maxMarketStateAgeMs > 0 &&
      !Number.isNaN(marketStateTs.getTime()) &&
      Date.now() - marketStateTs.getTime() > this.options.maxMarketStateAgeMs
    ) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Execution feasibility rejected: stale market state age ${Date.now() - marketStateTs.getTime()}ms`,
        indicators,
        'HOLD',
        profile.id,
        generatedFromCandleTs
      );
    }

    const spread =
      marketState.spread ??
      (marketState.ask !== undefined && marketState.bid !== undefined ? marketState.ask - marketState.bid : undefined);
    const spreadBps = spread ? Math.abs(safeDiv(spread, latest.close) * 10000) : 0;
    const spreadLimitBps = this.options.maxSpreadBps * profile.spreadFactor;

    if (spreadBps > spreadLimitBps) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Spread filter rejected signal (${spreadBps.toFixed(2)} bps > ${spreadLimitBps.toFixed(2)} bps)`,
        indicators,
        'HOLD',
        profile.id,
        generatedFromCandleTs
      );
    }

    const decision = this.scoreDecision(profile, latest.close, indicators);
    if (decision.side === 'HOLD') {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `No edge for ${profile.id}: buyScore=${decision.buyScore.toFixed(2)}, sellScore=${decision.sellScore.toFixed(2)}`,
        indicators,
        'HOLD',
        profile.id,
        generatedFromCandleTs
      );
    }

    const stopMult = this.options.atrStopMult * profile.atrStopMultFactor;
    const tpMult = this.options.atrTpMult * profile.atrTpMultFactor;
    const entrySelection = this.selectEntryPrice(decision.side, latest.close, marketState);
    const entry = entrySelection.entry;
    let stop = decision.side === 'BUY'
      ? entry - indicators.atr14 * stopMult
      : entry + indicators.atr14 * stopMult;
    let takeProfit = decision.side === 'BUY'
      ? entry + indicators.atr14 * tpMult
      : entry - indicators.atr14 * tpMult;

    const rawRiskPerUnit = Math.abs(entry - stop);
    const rawRewardPerUnit = Math.abs(takeProfit - entry);
    const rr = rawRiskPerUnit > 0 ? safeDiv(rawRewardPerUnit, rawRiskPerUnit, 2) : 2;
    const minStopBps = Math.max(0, this.options.minStopBpsByAssetClass[assetClass] ?? 0);
    const minRiskPerUnit = entry * (minStopBps / 10000);

    if (minRiskPerUnit > rawRiskPerUnit) {
      const widenedRisk = minRiskPerUnit;
      stop = decision.side === 'BUY' ? entry - widenedRisk : entry + widenedRisk;
      takeProfit = decision.side === 'BUY' ? entry + widenedRisk * rr : entry - widenedRisk * rr;
    }

    const riskPerUnit = Math.abs(entry - stop);
    if (riskPerUnit <= 0) {
      return this.rejectedOrder(symbol, latest.conid, 'Risk per unit is zero', indicators, decision.side, profile.id, generatedFromCandleTs);
    }

    const riskSnapshot = exposureSnapshot ?? (await this.repo.getExposureSnapshot(this.options.executionBaseUrl));
    const effectiveAccountEquity =
      riskSnapshot.accountEquity && Number.isFinite(riskSnapshot.accountEquity) && riskSnapshot.accountEquity > 0
        ? riskSnapshot.accountEquity
        : this.options.riskLimits.accountEquity;
    const maxRiskCash = (effectiveAccountEquity * this.options.riskLimits.maxRiskPerTradePct) / 100;
    const riskBasedQuantity = Math.floor((maxRiskCash / riskPerUnit) * profile.quantityFactor);

    if (riskBasedQuantity < 1) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        'Sizing rejected: quantity below 1 share/contract',
        indicators,
        decision.side,
        profile.id,
        generatedFromCandleTs
      );
    }

    const exposure = riskSnapshot.exposure;
    const openPositions = riskSnapshot.openPositions;
    const existingPositionQty = riskSnapshot.positionsBySymbol[symbol.toUpperCase()] ?? 0;
    const hasOpenPosition = Math.abs(existingPositionQty) > 1e-12;
    const closesOrReducesPosition =
      (decision.side === 'BUY' && existingPositionQty < -1e-12) ||
      (decision.side === 'SELL' && existingPositionQty > 1e-12);

    const maxExposure = (effectiveAccountEquity * this.options.riskLimits.maxExposurePct) / 100;
    const maxNotionalPerTradePct = this.options.riskLimits.maxNotionalPerTradePct ?? this.options.riskLimits.maxExposurePct;
    const maxNotionalPerTrade = (effectiveAccountEquity * maxNotionalPerTradePct) / 100;
    const availableExposure = Math.max(0, maxExposure - exposure);

    if (!hasOpenPosition && openPositions >= this.options.riskLimits.maxOpenPositions) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        'Risk check failed: max open positions reached',
        indicators,
        decision.side,
        profile.id,
        generatedFromCandleTs
      );
    }

    let quantity: number;
    let signalMode: 'OPEN_OR_ADD' | 'CLOSE_OR_REDUCE' = 'OPEN_OR_ADD';

    if (closesOrReducesPosition) {
      signalMode = 'CLOSE_OR_REDUCE';
      const closeQty = Math.floor(Math.abs(existingPositionQty));
      if (closeQty < 1) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Sizing rejected: no closeable quantity for open position=${existingPositionQty.toFixed(4)}`,
          indicators,
          decision.side,
          profile.id,
          generatedFromCandleTs
        );
      }
      quantity = closeQty;
    } else {
      if (availableExposure <= 0) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Risk check failed: max exposure exceeded (current=${exposure.toFixed(2)}, available=${availableExposure.toFixed(2)}, limit=${maxExposure.toFixed(2)}, source=${riskSnapshot.source})`,
          indicators,
          decision.side,
          profile.id,
          generatedFromCandleTs
        );
      }

      const quantityCapByExposure = Math.floor(availableExposure / entry);
      const quantityCapByNotional = Math.floor(maxNotionalPerTrade / entry);
      quantity = Math.min(riskBasedQuantity, quantityCapByExposure, quantityCapByNotional);

      if (quantity < 1) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Sizing rejected by notional caps (riskQty=${riskBasedQuantity}, capExposureQty=${quantityCapByExposure}, capTradeQty=${quantityCapByNotional}, available=${availableExposure.toFixed(2)}, maxTradeNotional=${maxNotionalPerTrade.toFixed(2)})`,
          indicators,
          decision.side,
          profile.id,
          generatedFromCandleTs
        );
      }

      const newNotional = quantity * entry;
      if (exposure + newNotional > maxExposure) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Risk check failed: max exposure exceeded (current=${exposure.toFixed(2)}, new=${newNotional.toFixed(2)}, post=${(exposure + newNotional).toFixed(2)}, limit=${maxExposure.toFixed(2)}, source=${riskSnapshot.source})`,
          indicators,
          decision.side,
          profile.id,
          generatedFromCandleTs
        );
      }
    }

    const protectWithBracket = signalMode === 'OPEN_OR_ADD';
    const spreadScore = clamp(1 - safeDiv(spreadBps, spreadLimitBps, 0), 0, 1);
    const confidence = clamp(decision.score * (0.85 + 0.15 * spreadScore), 0, 1);
    const minConfidence = clamp(this.options.minConfidence * profile.minConfidenceMultiplier, 0, 0.95);

    if (confidence < minConfidence) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Confidence too low (${confidence.toFixed(2)} < ${minConfidence.toFixed(2)}) for ${profile.id}`,
        indicators,
        decision.side,
        profile.id,
        generatedFromCandleTs
      );
    }

    return {
      instrument: symbol,
      conid: latest.conid,
      side: decision.side,
      positionEffect: signalMode,
      orderType: 'LMT',
      quantity,
      entry,
      stop: protectWithBracket ? stop : undefined,
      takeProfit: protectWithBracket ? takeProfit : undefined,
      reason: `Signal ${decision.side}: profile=${profile.id}, assetClass=${assetClass}, regime=${regime}, mode=${signalMode}, position=${existingPositionQty.toFixed(4)}, entrySource=${entrySelection.source}, buy=${decision.buyScore.toFixed(2)}, sell=${decision.sellScore.toFixed(2)}`,
      confidence,
      timestamp: new Date().toISOString(),
      riskCheckStatus: 'PASS',
      status: 'PROPOSED',
      strategy: profile.id,
      indicators,
      generatedFromCandleTs
    };
  }

  private resolveAssetClass(symbol: string): AssetClass {
    const overridden = this.options.assetClassBySymbol[symbol.toUpperCase()];
    if (overridden) return overridden;
    return inferAssetClass(symbol);
  }

  private selectEntryPrice(
    side: 'BUY' | 'SELL',
    latestClose: number,
    marketState: { bid?: number; ask?: number; lastPrice: number }
  ): EntryPriceSelection {
    const mode = this.options.lmtEntryMode;
    const bid = Number.isFinite(marketState.bid) ? Number(marketState.bid) : undefined;
    const ask = Number.isFinite(marketState.ask) ? Number(marketState.ask) : undefined;
    const last = Number.isFinite(marketState.lastPrice) && marketState.lastPrice > 0 ? marketState.lastPrice : latestClose;
    const bufferMultiplier = this.options.lmtEntryBufferBps / 10000;

    const applyBuffer = (price: number): number => {
      if (!(bufferMultiplier > 0)) return price;
      return side === 'BUY'
        ? price * (1 + bufferMultiplier)
        : price * (1 - bufferMultiplier);
    };

    if (mode === 'last') {
      return { entry: applyBuffer(last), source: 'last' };
    }

    if (mode === 'mid' && bid !== undefined && ask !== undefined) {
      return { entry: applyBuffer((bid + ask) / 2), source: 'mid' };
    }

    if (side === 'BUY' && ask !== undefined) {
      return { entry: applyBuffer(ask), source: 'touch' };
    }

    if (side === 'SELL' && bid !== undefined) {
      return { entry: applyBuffer(bid), source: 'touch' };
    }

    return { entry: applyBuffer(last), source: 'fallback_last' };
  }

  private detectRegime(assetClass: AssetClass, price: number, indicators: IndicatorSnapshot): MarketRegime {
    const atrPct = safeDiv(indicators.atr14!, price, 0);
    const bbWidthPct = indicators.bbWidthPct ?? 0;
    const trendBps = Math.abs(safeDiv(indicators.ema50! - indicators.ema200!, price, 0) * 10000);
    const macdMagnitude = Math.abs(indicators.macdHist ?? 0);

    const thresholds = {
      stock: { atrHigh: 0.012, bbHigh: 0.05, trendBps: 22 },
      commodity: { atrHigh: 0.018, bbHigh: 0.06, trendBps: 18 },
      index: { atrHigh: 0.01, bbHigh: 0.045, trendBps: 16 }
    }[assetClass];

    if (atrPct >= thresholds.atrHigh || bbWidthPct >= thresholds.bbHigh) {
      return 'high_volatility';
    }

    const macdThreshold = Math.max(indicators.atr14! * 0.025, price * 0.0004);
    if (trendBps >= thresholds.trendBps && macdMagnitude >= macdThreshold) {
      return 'trend';
    }

    return 'range';
  }

  private scoreDecision(profile: StrategyProfile, price: number, indicators: IndicatorSnapshot): DecisionScore {
    const scored = profile.style === 'trend'
      ? this.scoreTrend(price, indicators)
      : profile.style === 'range'
        ? this.scoreRange(price, indicators)
        : this.scoreBreakout(price, indicators);
    const adjusted = this.applyContextAdjustments(profile, price, indicators, scored);

    const edge = profile.decisionEdge;
    if (adjusted.buyScore >= profile.entryScore && adjusted.buyScore > adjusted.sellScore + edge) {
      return { side: 'BUY', score: adjusted.buyScore, buyScore: adjusted.buyScore, sellScore: adjusted.sellScore };
    }
    if (adjusted.sellScore >= profile.entryScore && adjusted.sellScore > adjusted.buyScore + edge) {
      return { side: 'SELL', score: adjusted.sellScore, buyScore: adjusted.buyScore, sellScore: adjusted.sellScore };
    }

    return {
      side: 'HOLD',
      score: Math.max(adjusted.buyScore, adjusted.sellScore),
      buyScore: adjusted.buyScore,
      sellScore: adjusted.sellScore
    };
  }

  private scoreTrend(price: number, indicators: IndicatorSnapshot): { buyScore: number; sellScore: number } {
    const trendGap = safeDiv(indicators.ema20! - indicators.ema50!, price, 0);
    const trendBull = clamp(trendGap * 2200, 0, 1);
    const trendBear = clamp(-trendGap * 2200, 0, 1);

    const macroBull = price > indicators.trendFilterValue! ? 1 : 0;
    const macroBear = price < indicators.trendFilterValue! ? 1 : 0;

    const rsiBull = clamp((indicators.rsi14! - 50) / 22, 0, 1);
    const rsiBear = clamp((50 - indicators.rsi14!) / 22, 0, 1);

    const macdNorm = Math.max(Math.abs(indicators.macdSignal!), indicators.atr14! * 0.05, 0.001);
    const macdBull = clamp(safeDiv(indicators.macdHist!, macdNorm, 0), 0, 1);
    const macdBear = clamp(safeDiv(-indicators.macdHist!, macdNorm, 0), 0, 1);

    const volumeBias = indicators.obvSlope !== undefined ? clamp(indicators.obvSlope * 24 + 0.5, 0, 1) : 0.5;
    const volumeBull = volumeBias;
    const volumeBear = 1 - volumeBias;

    const buyScore = clamp(
      0.28 * trendBull +
      0.22 * macroBull +
      0.22 * rsiBull +
      0.18 * macdBull +
      0.1 * volumeBull,
      0,
      1
    );
    const sellScore = clamp(
      0.28 * trendBear +
      0.22 * macroBear +
      0.22 * rsiBear +
      0.18 * macdBear +
      0.1 * volumeBear,
      0,
      1
    );

    return { buyScore, sellScore };
  }

  private scoreRange(price: number, indicators: IndicatorSnapshot): { buyScore: number; sellScore: number } {
    const halfBand = Math.max((indicators.bbUpper! - indicators.bbLower!) / 2, price * 0.002);
    const nearLower = clamp(safeDiv(indicators.bbMiddle! - price, halfBand, 0), 0, 1);
    const nearUpper = clamp(safeDiv(price - indicators.bbMiddle!, halfBand, 0), 0, 1);

    const weakTrend = 1 - clamp(Math.abs(safeDiv(indicators.ema20! - indicators.ema50!, price, 0)) * 3200, 0, 1);
    const rsiBuy = clamp((41 - indicators.rsi14!) / 14, 0, 1);
    const rsiSell = clamp((indicators.rsi14! - 59) / 14, 0, 1);

    const macdReversalDenom = Math.max(Math.abs(indicators.macdHistPrev ?? 0), indicators.atr14! * 0.035, price * 0.0006, 0.001);
    const macdImproving = indicators.macdHistPrev !== undefined
      ? clamp(safeDiv(indicators.macdHist! - indicators.macdHistPrev, macdReversalDenom, 0), 0, 1)
      : 0;
    const macdWeakening = indicators.macdHistPrev !== undefined
      ? clamp(safeDiv(indicators.macdHistPrev - indicators.macdHist!, macdReversalDenom, 0), 0, 1)
      : 0;
    const buyMomentumReset = 0.55 * macdImproving + 0.45 * (indicators.macdHist! <= 0 ? 1 : 0.2);
    const sellMomentumReset = 0.55 * macdWeakening + 0.45 * (indicators.macdHist! >= 0 ? 1 : 0.2);

    const buyScore = clamp(
      0.34 * nearLower +
      0.24 * rsiBuy +
      0.24 * buyMomentumReset +
      0.18 * weakTrend,
      0,
      1
    );
    const sellScore = clamp(
      0.34 * nearUpper +
      0.24 * rsiSell +
      0.24 * sellMomentumReset +
      0.18 * weakTrend,
      0,
      1
    );

    return { buyScore, sellScore };
  }

  private scoreBreakout(price: number, indicators: IndicatorSnapshot): { buyScore: number; sellScore: number } {
    const channel = Math.max(indicators.dcUpper20! - indicators.dcLower20!, price * 0.002);
    const breakoutUp = price >= indicators.dcUpper20!
      ? 1
      : clamp(safeDiv(price - indicators.dcLower20!, channel, 0), 0, 1);
    const breakoutDown = price <= indicators.dcLower20!
      ? 1
      : clamp(safeDiv(indicators.dcUpper20! - price, channel, 0), 0, 1);

    const trendBull = indicators.ema20! > indicators.ema50! ? 1 : 0;
    const trendBear = indicators.ema20! < indicators.ema50! ? 1 : 0;

    const macdBull = indicators.macdHist! > 0 ? 1 : 0;
    const macdBear = indicators.macdHist! < 0 ? 1 : 0;

    const atrPct = safeDiv(indicators.atr14!, price, 0);
    const volActivation = clamp(safeDiv(atrPct, 0.01, 0), 0, 1);

    const buyScore = clamp(
      0.45 * breakoutUp +
      0.2 * trendBull +
      0.2 * macdBull +
      0.15 * volActivation,
      0,
      1
    );
    const sellScore = clamp(
      0.45 * breakoutDown +
      0.2 * trendBear +
      0.2 * macdBear +
      0.15 * volActivation,
      0,
      1
    );

    return { buyScore, sellScore };
  }

  private applyContextAdjustments(
    profile: StrategyProfile,
    price: number,
    indicators: IndicatorSnapshot,
    scored: { buyScore: number; sellScore: number }
  ): { buyScore: number; sellScore: number } {
    let buyScore = scored.buyScore;
    let sellScore = scored.sellScore;

    const trendFilter = indicators.trendFilterValue ?? price;
    const emaBullAligned = indicators.ema20! > indicators.ema50! && indicators.ema50! >= indicators.ema200!;
    const emaBearAligned = indicators.ema20! < indicators.ema50! && indicators.ema50! <= indicators.ema200!;

    if (profile.style !== 'range') {
      if (price < trendFilter) buyScore *= 0.82;
      if (price > trendFilter) sellScore *= 0.82;
      if (!emaBullAligned) buyScore *= 0.88;
      if (!emaBearAligned) sellScore *= 0.88;
    } else {
      const trendStretchBps = Math.abs(safeDiv(price - trendFilter, price, 0) * 10000);
      const localTrendBps = Math.abs(safeDiv(indicators.ema20! - indicators.ema50!, price, 0) * 10000);
      if (trendStretchBps >= 28 || localTrendBps >= 20) {
        buyScore *= 0.88;
        sellScore *= 0.88;
      }
    }

    if (profile.regime === 'high_volatility') {
      const bbWidthPct = indicators.bbWidthPct ?? 0;
      const atrPct = safeDiv(indicators.atr14!, price, 0);
      const volPenalty = clamp(1 - Math.max(bbWidthPct * 2.2, atrPct * 8), 0.68, 1);
      buyScore *= volPenalty;
      sellScore *= volPenalty;
    }

    return {
      buyScore: clamp(buyScore, 0, 1),
      sellScore: clamp(sellScore, 0, 1)
    };
  }

  private rejectedOrder(
    symbol: string,
    conid: string | undefined,
    reason: string,
    indicators?: IndicatorSnapshot,
    side: Side = 'HOLD',
    strategy = 'adaptive_profile_v1',
    generatedFromCandleTs?: Date
  ): ProposedOrder {
    return {
      instrument: symbol,
      conid,
      side,
      orderType: 'LMT',
      quantity: 0,
      reason,
      confidence: 0,
      timestamp: new Date().toISOString(),
      riskCheckStatus: 'REJECT',
      status: 'REJECTED',
      strategy,
      indicators,
      generatedFromCandleTs
    };
  }
}
