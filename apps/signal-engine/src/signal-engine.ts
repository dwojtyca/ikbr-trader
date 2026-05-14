import {
  SecType,
  Candle,
  CandleTimeframe,
  IndicatorSnapshot,
  ProposedOrder,
  RegimeAnalysis,
  RiskLimits,
  Side,
  TimeframeIndicatorSnapshot,
} from "@ikbr/shared";
import {
  emaSlopePct,
  lastAdx,
  lastAtr,
  lastBollinger,
  lastCmf,
  lastDonchian,
  lastEma,
  lastMacd,
  lastMfi,
  lastObvSlope,
  lastRsi,
  lastSma,
} from "./indicators.js";
import { MarketRegimeDetector } from "./regime/market-regime-detector.js";
import { StrategyPortfolioManager } from "./portfolio/strategy-portfolio-manager.js";
import {
  ExposureSnapshot,
  SignalPerformanceStats,
  SignalRepository,
} from "./repository.js";
import type { Strategy, StrategySignal } from "./strategies/strategy.types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(denominator) || denominator === 0) return fallback;
  return numerator / denominator;
}

function stepDecimals(step: number): number {
  const normalized = step.toString().toLowerCase();
  if (normalized.includes("e-")) {
    const exp = Number(normalized.split("e-")[1]);
    return Number.isFinite(exp) ? exp : 0;
  }
  const parts = normalized.split(".");
  return parts[1]?.length ?? 0;
}

interface SignalEngineOptions {
  strategies: readonly Strategy[];
  minCandles: number;
  maxSpreadBps: number;
  minVolume1m: number;
  volumeFilterMode: "strict" | "off";
  minConfidence: number;
  lmtEntryMode: "touch" | "last" | "mid";
  lmtEntryBufferBps: number;
  fractionalSymbols: Set<string>;
  fractionalQuantityStep: number;
  minStopBpsBySecType: Record<SecType, number>;
  maxMarketStateAgeMs: number;
  baseCurrency: string;
  currencyBySymbol: Record<string, string>;
  priceMultiplierBySymbol: Record<string, number>;
  executionBaseUrl: string;
  strategyCooldownMs: number;
  riskLimits: RiskLimits;
}

interface EntryPriceSelection {
  entry: number;
  source: "touch" | "last" | "mid" | "fallback_last";
}

interface ConfidenceFloor {
  value: number;
  reason?: string;
}

export class SignalEngine {
  private readonly marketRegimeDetector = new MarketRegimeDetector();
  private readonly portfolioManager: StrategyPortfolioManager;

  constructor(
    private readonly repo: SignalRepository,
    private readonly options: SignalEngineOptions,
  ) {
    this.portfolioManager = new StrategyPortfolioManager(options.strategies);
  }

  get strategyId(): string {
    return this.portfolioManager.primaryStrategyId;
  }

  get strategyIds(): string[] {
    return this.portfolioManager.strategyIds;
  }

  async runForSymbol(
    symbol: string,
    exposureSnapshot?: ExposureSnapshot,
    generatedFromCandleTs?: Date,
  ): Promise<ProposedOrder> {
    const candles = await this.repo.getRecentCandles(
      symbol,
      "1m",
      this.options.minCandles + 80,
    );
    const candles1h = await this.repo.getRecentCandles(symbol, "1h", 160);
    const [candles5m, candles4h, candles12h, candles1d, candles1w] =
      await Promise.all([
        this.repo.getRecentCandles(symbol, "5m", 160),
        this.repo.getRecentCandles(symbol, "4h", 120),
        this.repo.getRecentCandles(symbol, "12h", 90),
        this.repo.getRecentCandles(symbol, "1d", 260),
        this.repo.getRecentCandles(symbol, "1w", 104),
      ]);

    if (candles.length < this.options.minCandles) {
      return this.rejectedOrder(
        symbol,
        undefined,
        "Insufficient candles for indicators",
        undefined,
        "HOLD",
        generatedFromCandleTs,
      );
    }

    const latest = candles[candles.length - 1];
    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    const volumes = candles.map((candle) => candle.volume);
    const instrumentContract = await this.repo.getInstrumentContract(
      symbol,
      latest.conid,
    );
    if (!instrumentContract) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        "Missing resolved contract metadata",
        undefined,
        "HOLD",
        generatedFromCandleTs,
      );
    }
    const secType = instrumentContract.secType.toUpperCase();

    const trendFrom1h = lastEma(
      candles1h.map((candle) => candle.close),
      50,
    );
    const trendFrom1m = lastEma(closes, 200);
    const trendFilterValue = trendFrom1h ?? trendFrom1m;
    const macdSnapshot = lastMacd(closes);
    const cmfSnapshot = lastCmf(highs, lows, closes, volumes, 20);
    const mfiSnapshot = lastMfi(highs, lows, closes, volumes, 14);
    const bbSnapshot = lastBollinger(closes, 20);
    const donchianSnapshot = lastDonchian(closes, 20);

    const indicators: IndicatorSnapshot = {
      ema20: lastEma(closes, 20),
      ema50: lastEma(closes, 50),
      ema200: lastEma(closes, 200),
      sma200: lastSma(closes, 200),
      rsi14: lastRsi(closes, 14),
      rsi14Prev: lastRsi(closes.slice(0, -1), 14),
      atr14: lastAtr(highs, lows, closes, 14),
      adx14: lastAdx(highs, lows, closes, 14),
      macdLine: macdSnapshot.macdLine,
      macdSignal: macdSnapshot.signalLine,
      macdHist: macdSnapshot.histogram,
      macdHistPrev: macdSnapshot.previousHistogram,
      macdHistPrev2: macdSnapshot.previous2Histogram,
      cmf20: cmfSnapshot.value,
      cmf20Prev: cmfSnapshot.previous,
      mfi14: mfiSnapshot.value,
      mfi14Prev: mfiSnapshot.previous,
      bbUpper: bbSnapshot.upper,
      bbMiddle: bbSnapshot.middle,
      bbLower: bbSnapshot.lower,
      bbWidthPct: bbSnapshot.widthPct,
      dcUpper20: donchianSnapshot.upper,
      dcLower20: donchianSnapshot.lower,
      obvSlope: lastObvSlope(closes, volumes, 8),
      return5mPct: this.returnPct(closes, 5),
      return20mPct: this.returnPct(closes, 20),
      return60mPct: this.returnPct(closes, 60),
      trendFilterValue,
      trendFilterSource: trendFrom1h !== undefined ? "EMA50_1h" : "EMA200_1m",
      secType,
      timeframes: {
        "5m": this.buildTimeframeSnapshot(candles5m),
        "1h": this.buildTimeframeSnapshot(candles1h),
        "4h": this.buildTimeframeSnapshot(candles4h),
        "12h": this.buildTimeframeSnapshot(candles12h),
        "1d": this.buildTimeframeSnapshot(candles1d),
        "1w": this.buildTimeframeSnapshot(candles1w),
      },
    };

    if (!this.hasRequiredIndicators(indicators)) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        "Indicator values are not available",
        indicators,
        "HOLD",
        generatedFromCandleTs,
      );
    }

    const regimeAnalysis = this.detectRegime(
      secType,
      latest.close,
      indicators,
    );
    const regime = regimeAnalysis.regime;
    indicators.regime = regime;
    indicators.directionalRegime = regimeAnalysis.directionalRegime;
    indicators.volatilityRegime = regimeAnalysis.volatilityRegime;
    indicators.regimeScore = regimeAnalysis.score;
    indicators.regimeConfidence = regimeAnalysis.confidence;
    indicators.regimeReasons = regimeAnalysis.reasons;
    indicators.timeframeTrendScores = regimeAnalysis.timeframeTrendScores;
    indicators.timeframeTrendVotes = regimeAnalysis.timeframeTrendVotes;
    indicators.strategyProfile = this.portfolioManager.strategyIds.join(",");
    await this.repo.syncStrategyRuntimeStates(
      this.portfolioManager.strategyIds,
      this.options.strategyCooldownMs,
    );

    const activeStrategyIds: string[] = [];
    const disabledReasons: string[] = [];
    for (const strategyId of this.portfolioManager.strategyIds) {
      const runtimeState = await this.repo.getStrategyRuntimeState(strategyId);
      if (!runtimeState.enabled || runtimeState.permanentlyDisabled) {
        disabledReasons.push(`${strategyId} is disabled`);
        continue;
      }
      if (
        runtimeState.cooldownUntil &&
        runtimeState.cooldownUntil.getTime() > Date.now()
      ) {
        disabledReasons.push(`${strategyId} is in cooldown`);
        continue;
      }
      activeStrategyIds.push(strategyId);
    }

    if (activeStrategyIds.length === 0) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        disabledReasons.join("; ") || "No active strategies",
        indicators,
        "HOLD",
        generatedFromCandleTs,
      );
    }

    const marketState = await this.repo.getMarketState(latest.conid);
    if (!marketState) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        "No market state in Redis for conid",
        indicators,
        "HOLD",
        generatedFromCandleTs,
      );
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
        "HOLD",
        generatedFromCandleTs,
      );
    }

    const riskSnapshot =
      exposureSnapshot ??
      (await this.repo.getExposureSnapshot(this.options.executionBaseUrl));
    const existingPositionQty =
      riskSnapshot.positionsBySymbol[symbol.toUpperCase()] ?? 0;
    const positionContext =
      riskSnapshot.positionContextsBySymbol?.[symbol.toUpperCase()];
    const spread =
      marketState.spread ??
      (marketState.ask !== undefined && marketState.bid !== undefined
        ? marketState.ask - marketState.bid
        : undefined);
    const spreadBps = spread
      ? Math.abs(safeDiv(spread, latest.close) * 10000)
      : 0;

    if (
      this.options.volumeFilterMode === "strict" &&
      latest.volume < this.options.minVolume1m
    ) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        "Liquidity filter rejected: low 1m volume",
        indicators,
        "HOLD",
        generatedFromCandleTs,
      );
    }
    if (spreadBps > this.options.maxSpreadBps) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Spread filter rejected (${spreadBps.toFixed(2)} bps > ${this.options.maxSpreadBps.toFixed(2)} bps)`,
        indicators,
        "HOLD",
        generatedFromCandleTs,
      );
    }

    const portfolioResult = this.portfolioManager.run(
      {
        symbol,
        conid: latest.conid,
        secType,
        regime,
        latestCandle: latest,
        indicators,
        candlesByTimeframe: {
          "1m": candles,
          "5m": candles5m,
          "1h": candles1h,
          "4h": candles4h,
          "12h": candles12h,
          "1d": candles1d,
          "1w": candles1w,
        },
        marketState,
        currentPosition: {
          quantity: existingPositionQty,
          averageCost: positionContext?.averageCost,
          marketPrice: positionContext?.marketPrice,
          marketValue: positionContext?.marketValue,
        },
        exposureSnapshot: riskSnapshot,
      },
      new Set(activeStrategyIds),
    );
    const signal = portfolioResult.selected?.signal ?? null;

    if (!signal) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        portfolioResult.rejectionReasons.length > 0
          ? portfolioResult.rejectionReasons.join("; ")
          : `No strategy signal for secType=${secType}, regime=${regime}`,
        indicators,
        "HOLD",
        generatedFromCandleTs,
      );
    }

    return this.buildOrderFromSignal({
      symbol,
      latest,
      indicators,
      signal,
      marketState,
      riskSnapshot,
      existingPositionQty,
      spreadBps,
      generatedFromCandleTs,
    });
  }

  private async buildOrderFromSignal(input: {
    symbol: string;
    latest: Candle;
    indicators: IndicatorSnapshot;
    signal: StrategySignal;
    marketState: { bid?: number; ask?: number; lastPrice: number };
    riskSnapshot: ExposureSnapshot;
    existingPositionQty: number;
    spreadBps: number;
    generatedFromCandleTs?: Date;
  }): Promise<ProposedOrder> {
    const {
      symbol,
      latest,
      indicators,
      signal,
      marketState,
      riskSnapshot,
      existingPositionQty,
      spreadBps,
      generatedFromCandleTs,
    } = input;
    const closesOrReducesPosition =
      (signal.side === "BUY" && existingPositionQty < -1e-12) ||
      (signal.side === "SELL" && existingPositionQty > 1e-12);
    const increasesExistingExposure =
      (signal.side === "BUY" && existingPositionQty > 1e-12) ||
      (signal.side === "SELL" && existingPositionQty < -1e-12);

    if (increasesExistingExposure) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        "Position already open in signal direction",
        indicators,
        signal.side,
        generatedFromCandleTs,
      );
    }

    const entrySelection = this.selectEntryPrice(
      signal.side,
      latest.close,
      marketState,
    );
    const entry = signal.suggestedEntry ?? entrySelection.entry;
    const orderType = signal.entryOrderType ?? "LMT";
    if (signal.stopLoss === undefined || signal.takeProfit === undefined) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        "Strategy signal missing stopLoss or takeProfit",
        indicators,
        signal.side,
        generatedFromCandleTs,
      );
    }
    let stop = signal.stopLoss;
    let takeProfit = signal.takeProfit;

    const rawRiskPerUnit = Math.abs(entry - stop);
    const rawRewardPerUnit = Math.abs(takeProfit - entry);
    const rr =
      rawRiskPerUnit > 0 ? safeDiv(rawRewardPerUnit, rawRiskPerUnit, 2) : 2;
    const minStopBps = Math.max(
      0,
      this.options.minStopBpsBySecType[indicators.secType ?? "STK"] ??
        this.options.minStopBpsBySecType.STK ??
        0,
    );
    const minRiskPerUnit = entry * (minStopBps / 10000);
    if (minRiskPerUnit > rawRiskPerUnit) {
      stop =
        signal.side === "BUY" ? entry - minRiskPerUnit : entry + minRiskPerUnit;
      takeProfit =
        signal.side === "BUY"
          ? entry + minRiskPerUnit * rr
          : entry - minRiskPerUnit * rr;
    }

    const riskPerUnit = Math.abs(entry - stop);
    if (riskPerUnit <= 0) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        "Risk per unit is zero",
        indicators,
        signal.side,
        generatedFromCandleTs,
      );
    }

    const priceMultiplier = this.priceMultiplierForSymbol(symbol);
    const fxToBase = this.fxToBaseForSymbol(symbol, riskSnapshot);
    if (fxToBase === undefined) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `FX rejected: no conversion rate for ${this.currencyForSymbol(symbol)} to account base`,
        indicators,
        signal.side,
        generatedFromCandleTs,
      );
    }

    const notionalEntry = entry * priceMultiplier * fxToBase;
    const riskPerUnitCash = riskPerUnit * priceMultiplier * fxToBase;
    if (notionalEntry <= 0 || riskPerUnitCash <= 0) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        "Notional-adjusted risk per unit is zero",
        indicators,
        signal.side,
        generatedFromCandleTs,
      );
    }

    const quantityStep = this.quantityStepForSymbol(symbol);
    const effectiveAccountEquity =
      riskSnapshot.accountEquity &&
      Number.isFinite(riskSnapshot.accountEquity) &&
      riskSnapshot.accountEquity > 0
        ? riskSnapshot.accountEquity
        : this.options.riskLimits.accountEquity;
    const maxRiskCash =
      (effectiveAccountEquity * this.options.riskLimits.maxRiskPerTradePct) /
      100;
    const riskBasedQuantity = this.roundDownToQuantityStep(
      maxRiskCash / riskPerUnitCash,
      quantityStep,
    );
    if (riskBasedQuantity < quantityStep) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Sizing rejected: quantity below minimum step ${quantityStep}`,
        indicators,
        signal.side,
        generatedFromCandleTs,
      );
    }

    const maxExposure =
      (effectiveAccountEquity * this.options.riskLimits.maxExposurePct) / 100;
    const maxNotionalPerTradePct =
      this.options.riskLimits.maxNotionalPerTradePct ??
      this.options.riskLimits.maxExposurePct;
    const maxNotionalPerTrade =
      (effectiveAccountEquity * maxNotionalPerTradePct) / 100;
    const availableExposure = Math.max(0, maxExposure - riskSnapshot.exposure);

    let quantity: number;
    let positionEffect: "OPEN_OR_ADD" | "CLOSE_OR_REDUCE" = "OPEN_OR_ADD";
    if (closesOrReducesPosition) {
      positionEffect = "CLOSE_OR_REDUCE";
      quantity = this.roundDownToQuantityStep(
        Math.abs(existingPositionQty),
        quantityStep,
      );
      if (quantity < quantityStep) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Sizing rejected: no closeable quantity for open position=${existingPositionQty.toFixed(4)}`,
          indicators,
          signal.side,
          generatedFromCandleTs,
        );
      }
    } else {
      if (
        riskSnapshot.openPositions >= this.options.riskLimits.maxOpenPositions
      ) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          "Risk check failed: max open positions reached",
          indicators,
          signal.side,
          generatedFromCandleTs,
        );
      }
      if (availableExposure <= 0) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Risk check failed: max exposure exceeded (current=${riskSnapshot.exposure.toFixed(2)}, available=${availableExposure.toFixed(2)}, limit=${maxExposure.toFixed(2)}, source=${riskSnapshot.source})`,
          indicators,
          signal.side,
          generatedFromCandleTs,
        );
      }

      const quantityCapByExposure = this.roundDownToQuantityStep(
        availableExposure / notionalEntry,
        quantityStep,
      );
      const quantityCapByNotional = this.roundDownToQuantityStep(
        maxNotionalPerTrade / notionalEntry,
        quantityStep,
      );
      quantity = this.roundDownToQuantityStep(
        Math.min(riskBasedQuantity, quantityCapByExposure, quantityCapByNotional),
        quantityStep,
      );

      if (quantity < quantityStep) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Sizing rejected by notional caps (riskQty=${riskBasedQuantity}, capExposureQty=${quantityCapByExposure}, capTradeQty=${quantityCapByNotional}, available=${availableExposure.toFixed(2)}, maxTradeNotional=${maxNotionalPerTrade.toFixed(2)})`,
          indicators,
          signal.side,
          generatedFromCandleTs,
        );
      }

      const newNotional = quantity * notionalEntry;
      if (riskSnapshot.exposure + newNotional > maxExposure) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Risk check failed: max exposure exceeded (current=${riskSnapshot.exposure.toFixed(2)}, new=${newNotional.toFixed(2)}, post=${(riskSnapshot.exposure + newNotional).toFixed(2)}, limit=${maxExposure.toFixed(2)}, source=${riskSnapshot.source})`,
          indicators,
          signal.side,
          generatedFromCandleTs,
        );
      }
    }

    const strategyId = signal.strategyId;
    const profilePerformance = await this.repo.getSignalPerformance({
      strategy: strategyId,
      side: signal.side,
      limit: 40,
    });
    const symbolPerformance = await this.repo.getSignalPerformance({
      instrument: symbol,
      strategy: strategyId,
      side: signal.side,
      limit: 30,
    });
    const confidenceFloor = this.buildConfidenceFloor(
      this.options.minConfidence,
      profilePerformance,
      symbolPerformance,
    );
    const spreadScore = clamp(
      1 - safeDiv(spreadBps, this.options.maxSpreadBps, 0),
      0,
      1,
    );
    const confidence = clamp(
      signal.confidenceScore * (0.85 + 0.15 * spreadScore),
      0,
      1,
    );
    if (confidence < confidenceFloor.value) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Confidence too low (${confidence.toFixed(2)} < ${confidenceFloor.value.toFixed(2)}) for ${strategyId}${confidenceFloor.reason ? `; ${confidenceFloor.reason}` : ""}`,
        indicators,
        signal.side,
        generatedFromCandleTs,
      );
    }

    return {
      instrument: symbol,
      conid: latest.conid,
      side: signal.side,
      positionEffect,
      orderType,
      quantity,
      entry,
      stop: positionEffect === "OPEN_OR_ADD" ? stop : undefined,
      takeProfit: positionEffect === "OPEN_OR_ADD" ? takeProfit : undefined,
      reason: `${signal.entryReason}, strategy=${strategyId}, regime=${indicators.regime}, mode=${positionEffect}, position=${existingPositionQty.toFixed(4)}, entrySource=${signal.suggestedEntry !== undefined ? "strategy" : entrySelection.source}`,
      confidence,
      timestamp: new Date().toISOString(),
      riskCheckStatus: "PASS",
      status: "PROPOSED",
      strategy: strategyId,
      indicators,
      generatedFromCandleTs,
    };
  }

  private hasRequiredIndicators(indicators: IndicatorSnapshot): boolean {
    return (
      indicators.ema20 !== undefined &&
      indicators.ema50 !== undefined &&
      indicators.ema200 !== undefined &&
      indicators.rsi14 !== undefined &&
      indicators.atr14 !== undefined &&
      indicators.macdLine !== undefined &&
      indicators.macdSignal !== undefined &&
      indicators.macdHist !== undefined &&
      indicators.bbUpper !== undefined &&
      indicators.bbMiddle !== undefined &&
      indicators.bbLower !== undefined &&
      indicators.dcUpper20 !== undefined &&
      indicators.dcLower20 !== undefined &&
      indicators.trendFilterValue !== undefined
    );
  }

  private detectRegime(
    secType: SecType,
    price: number,
    indicators: IndicatorSnapshot,
  ): RegimeAnalysis {
    return this.marketRegimeDetector.detectDetailed(
      secType,
      price,
      indicators,
    );
  }

  private buildTimeframeSnapshot(
    candles: Candle[],
  ): TimeframeIndicatorSnapshot | undefined {
    if (candles.length < 20) return undefined;

    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    const volumes = candles.map((candle) => candle.volume);
    const latest = candles[candles.length - 1];
    const ema20 = lastEma(closes, 20);
    const ema50 = lastEma(closes, 50);
    const ema200 = lastEma(closes, 200);
    const sma200 = lastSma(closes, 200);
    const macd = lastMacd(closes);
    const cmf = lastCmf(highs, lows, closes, volumes, 20);
    const mfi = lastMfi(highs, lows, closes, volumes, 14);
    const bb = lastBollinger(closes, 20);
    let trend: TimeframeIndicatorSnapshot["trend"] = "neutral";
    if (
      ema20 !== undefined &&
      ema50 !== undefined &&
      latest.close > ema50 &&
      ema20 > ema50
    )
      trend = "bullish";
    if (
      ema20 !== undefined &&
      ema50 !== undefined &&
      latest.close < ema50 &&
      ema20 < ema50
    )
      trend = "bearish";

    return {
      close: latest.close,
      ema20,
      ema50,
      ema200,
      sma200,
      rsi14: lastRsi(closes, 14),
      atr14: lastAtr(highs, lows, closes, 14),
      adx14: lastAdx(highs, lows, closes, 14),
      macdHist: macd.histogram,
      macdHistPrev: macd.previousHistogram,
      macdHistPrev2: macd.previous2Histogram,
      cmf20: cmf.value,
      mfi14: mfi.value,
      bbWidthPct: bb.widthPct,
      volume: latest.volume,
      trend,
      priceVsEma50Bps:
        ema50 !== undefined
          ? safeDiv(latest.close - ema50, latest.close, 0) * 10000
          : undefined,
      ema50Slope10Pct: emaSlopePct(closes, 50, 10),
      return3Pct: this.returnPct(closes, 3),
      return4Pct: this.returnPct(closes, 4),
      return12Pct: this.returnPct(closes, 12),
      return18Pct: this.returnPct(closes, 18),
      return20Pct: this.returnPct(closes, 20),
      return24Pct: this.returnPct(closes, 24),
      return30Pct: this.returnPct(closes, 30),
      return48Pct: this.returnPct(closes, 48),
    };
  }

  private returnPct(closes: number[], lookback: number): number | undefined {
    if (closes.length <= lookback) return undefined;
    const current = closes[closes.length - 1];
    const previous = closes[closes.length - 1 - lookback];
    if (!(previous > 0)) return undefined;
    return ((current - previous) / previous) * 100;
  }

  private selectEntryPrice(
    side: Exclude<Side, "HOLD">,
    last: number,
    marketState: { bid?: number; ask?: number; lastPrice: number },
  ): EntryPriceSelection {
    const mode = this.options.lmtEntryMode;
    const bid = marketState.bid;
    const ask = marketState.ask;
    const bufferSign = side === "BUY" ? 1 : -1;
    const applyBuffer = (price: number) =>
      price * (1 + (bufferSign * this.options.lmtEntryBufferBps) / 10000);

    if (mode === "last") {
      return { entry: applyBuffer(last), source: "last" };
    }
    if (mode === "mid" && bid !== undefined && ask !== undefined) {
      return { entry: applyBuffer((bid + ask) / 2), source: "mid" };
    }
    if (side === "BUY" && ask !== undefined) {
      return { entry: applyBuffer(ask), source: "touch" };
    }
    if (side === "SELL" && bid !== undefined) {
      return { entry: applyBuffer(bid), source: "touch" };
    }
    return { entry: applyBuffer(last), source: "fallback_last" };
  }

  private buildConfidenceFloor(
    baseMinConfidence: number,
    profilePerformance: SignalPerformanceStats,
    symbolPerformance: SignalPerformanceStats,
  ): ConfidenceFloor {
    let floor = baseMinConfidence;
    const reasons: string[] = [];

    if (profilePerformance.trades >= 20 && profilePerformance.winRate < 0.35) {
      floor += 0.06;
      reasons.push(`strategy winRate=${profilePerformance.winRate.toFixed(2)}`);
    }
    if (symbolPerformance.trades >= 12 && symbolPerformance.winRate < 0.34) {
      floor += 0.05;
      reasons.push(`symbol winRate=${symbolPerformance.winRate.toFixed(2)}`);
    }

    return {
      value: clamp(floor, 0, 0.9),
      reason: reasons.join(", ") || undefined,
    };
  }

  private quantityStepForSymbol(symbol: string): number {
    return this.options.fractionalSymbols.has(symbol.toUpperCase())
      ? this.options.fractionalQuantityStep
      : 1;
  }

  private priceMultiplierForSymbol(symbol: string): number {
    const multiplier =
      this.options.priceMultiplierBySymbol[symbol.toUpperCase()];
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  }

  private currencyForSymbol(symbol: string): string {
    return (
      this.options.currencyBySymbol[symbol.toUpperCase()] ??
      this.options.baseCurrency
    )
      .trim()
      .toUpperCase();
  }

  private fxToBaseForSymbol(
    symbol: string,
    riskSnapshot: ExposureSnapshot,
  ): number | undefined {
    const currency = this.currencyForSymbol(symbol);
    const baseCurrency = this.options.baseCurrency.trim().toUpperCase();
    if (currency === baseCurrency) return 1;

    const rate = riskSnapshot.fxToBaseByCurrency?.[currency];
    return Number.isFinite(rate) && Number(rate) > 0 ? Number(rate) : undefined;
  }

  private roundDownToQuantityStep(value: number, step: number): number {
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      !Number.isFinite(step) ||
      step <= 0
    )
      return 0;
    const decimals = stepDecimals(step);
    const scaled = Math.floor(value / step + 1e-9) * step;
    return Number(scaled.toFixed(decimals));
  }

  private rejectedOrder(
    symbol: string,
    conid: string | undefined,
    reason: string,
    indicators?: IndicatorSnapshot,
    side: Side = "HOLD",
    generatedFromCandleTs?: Date,
  ): ProposedOrder {
    return {
      instrument: symbol,
      conid,
      side,
      orderType: "LMT",
      quantity: 0,
      reason,
      confidence: 0,
      timestamp: new Date().toISOString(),
      riskCheckStatus: "REJECT",
      status: "REJECTED",
      strategy: this.portfolioManager.primaryStrategyId,
      indicators,
      generatedFromCandleTs,
    };
  }
}
