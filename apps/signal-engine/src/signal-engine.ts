import {
  SecType,
  Candle,
  CandleTimeframe,
  DirectionalRegime,
  IndicatorSnapshot,
  PartialTakeProfit,
  ProposedOrder,
  RegimeAnalysis,
  RiskLimits,
  Side,
  TimeframeIndicatorSnapshot,
  VolatilityRegime,
  findStrategyProfile,
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
import type {
  Strategy,
  StrategySignal,
  ExitSignal,
  ExitContext,
} from "./strategies/strategy.types.js";

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
  executionApiToken: string;
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
  private readonly timeframeSnapshotCache = new Map<
    string,
    { lastTs: number; snapshot: TimeframeIndicatorSnapshot | undefined }
  >();

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
    // We need enough 1m candles to (a) compute indicators (minCandles+80)
    // AND (b) include at least one overnight gap so buildIntradaySnapshot
    // can locate the current session's open. A US session is ~390 minutes
    // and a WSE session ~510 minutes, so 1000 bars guarantees ≥2 sessions
    // worth of data regardless of when we run mid-session. The older bars
    // are essentially free — strategies only inspect the last ~60 bars.
    const oneMinuteBufferSize = Math.max(this.options.minCandles + 80, 1000);
    const candles = await this.repo.getRecentCandles(
      symbol,
      "1m",
      oneMinuteBufferSize,
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
        "5m": this.buildTimeframeSnapshot(candles5m, `${symbol}:5m`),
        "1h": this.buildTimeframeSnapshot(candles1h, `${symbol}:1h`),
        "4h": this.buildTimeframeSnapshot(candles4h, `${symbol}:4h`),
        "12h": this.buildTimeframeSnapshot(candles12h, `${symbol}:12h`),
        "1d": this.buildTimeframeSnapshot(candles1d, `${symbol}:1d`),
        "1w": this.buildTimeframeSnapshot(candles1w, `${symbol}:1w`),
      },
      intraday: this.buildIntradaySnapshot(candles),
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

    const regimeAnalysis = this.detectRegime(secType, latest.close, indicators);
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
    const symbolUpper = symbol.toUpperCase();
    for (const strategyId of this.portfolioManager.strategyIds) {
      const profile = findStrategyProfile(strategyId);
      if (
        profile?.excludedSymbols?.some(
          (excluded) => excluded.toUpperCase() === symbolUpper,
        )
      ) {
        disabledReasons.push(`${strategyId} excluded for ${symbolUpper}`);
        continue;
      }
      if (
        profile?.includedSymbols &&
        profile.includedSymbols.length > 0 &&
        !profile.includedSymbols.some(
          (included) => included.toUpperCase() === symbolUpper,
        )
      ) {
        disabledReasons.push(
          `${strategyId} not in includedSymbols for ${symbolUpper}`,
        );
        continue;
      }
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
      (await this.repo.getExposureSnapshot(
        this.options.executionBaseUrl,
        this.options.executionApiToken,
      ));
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

    // Evaluate early exit (shouldExit) if position is open
    if (existingPositionQty !== 0) {
      const exitSignal = await this.evaluateExit(
        symbol,
        latest.conid,
        secType,
        regimeAnalysis.directionalRegime,
        regimeAnalysis.volatilityRegime,
        latest,
        indicators,
        candles,
        candles5m,
        candles1h,
        candles4h,
        candles12h,
        candles1d,
        candles1w,
        marketState,
        existingPositionQty,
        positionContext?.averageCost,
        riskSnapshot,
        activeStrategyIds,
        generatedFromCandleTs,
      );
      if (exitSignal) {
        return exitSignal;
      }
    }

    const portfolioResult = this.portfolioManager.run(
      {
        symbol,
        conid: latest.conid,
        secType,
        directionalRegime: regimeAnalysis.directionalRegime,
        volatilityRegime: regimeAnalysis.volatilityRegime,
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
          : `No strategy signal for secType=${secType}, directionalRegime=${regimeAnalysis.directionalRegime}, volatilityRegime=${regimeAnalysis.volatilityRegime}`,
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
    const strategyProfile = findStrategyProfile(signal.strategyId);
    const quantityFactor =
      strategyProfile?.quantityFactor && strategyProfile.quantityFactor > 0
        ? strategyProfile.quantityFactor
        : 1;
    // Risk-budget semantics:
    //   targetRiskPerTradePct is the per-trade baseline (defaults to maxRiskPerTradePct).
    //   quantityFactor scales the target up/down per strategy.
    //   The result is clamped to maxRiskPerTradePct so a misconfigured factor > 1
    //   can never breach the global per-trade risk cap.
    const targetRiskPct =
      this.options.riskLimits.targetRiskPerTradePct ??
      this.options.riskLimits.maxRiskPerTradePct;
    const scaledRiskPct = Math.min(
      targetRiskPct * quantityFactor,
      this.options.riskLimits.maxRiskPerTradePct,
    );
    const effectiveRiskCash = (effectiveAccountEquity * scaledRiskPct) / 100;
    const riskBasedQuantity = this.roundDownToQuantityStep(
      effectiveRiskCash / riskPerUnitCash,
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
        Math.min(
          riskBasedQuantity,
          quantityCapByExposure,
          quantityCapByNotional,
        ),
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
    const profile = findStrategyProfile(strategyId);
    // Stage 9: enforce per-profile raw entry-score floor before regime/symbol modifiers.
    if (profile && signal.confidenceScore < profile.entryScore) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Confidence below profile entryScore (${signal.confidenceScore.toFixed(2)} < ${profile.entryScore.toFixed(2)}) for ${strategyId}`,
        indicators,
        signal.side,
        generatedFromCandleTs,
      );
    }
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
    const minConfidenceMultiplier =
      profile?.minConfidenceMultiplier && profile.minConfidenceMultiplier > 0
        ? profile.minConfidenceMultiplier
        : 1;
    const confidenceFloor = this.buildConfidenceFloor(
      this.options.minConfidence * minConfidenceMultiplier,
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
      partialTakeProfits:
        positionEffect === "OPEN_OR_ADD" && signal.partialTakeProfits
          ? this.sanitizePartialTakeProfits(
              signal.partialTakeProfits,
              signal.side,
              entry,
              takeProfit,
            )
          : undefined,
      trailingStopPct:
        positionEffect === "OPEN_OR_ADD" &&
        signal.trailingStopPct !== undefined &&
        Number.isFinite(signal.trailingStopPct) &&
        signal.trailingStopPct > 0 &&
        signal.trailingStopPct < 50
          ? signal.trailingStopPct
          : undefined,
      trailingStopActivationR:
        positionEffect === "OPEN_OR_ADD" &&
        signal.trailingStopActivationR !== undefined &&
        Number.isFinite(signal.trailingStopActivationR) &&
        signal.trailingStopActivationR > 0 &&
        signal.trailingStopActivationR < 20
          ? signal.trailingStopActivationR
          : undefined,
      reason: `${signal.entryReason}, strategy=${strategyId}, directionalRegime=${indicators.directionalRegime}, volatilityRegime=${indicators.volatilityRegime}, mode=${positionEffect}, position=${existingPositionQty.toFixed(4)}, entrySource=${signal.suggestedEntry !== undefined ? "strategy" : entrySelection.source}`,
      confidence,
      timestamp: new Date().toISOString(),
      riskCheckStatus: "PASS",
      status: "PROPOSED",
      strategy: strategyId,
      indicators,
      generatedFromCandleTs,
    };
  }

  /**
   * Filters and orders partial take-profit levels so they sit strictly between
   * the entry and the final take-profit on the correct side of the entry, and
   * the cumulative fraction never exceeds 1. Anything malformed is dropped.
   */
  private sanitizePartialTakeProfits(
    levels: PartialTakeProfit[],
    side: Exclude<Side, "HOLD">,
    entry: number,
    finalTakeProfit: number,
  ): PartialTakeProfit[] | undefined {
    if (!Array.isArray(levels) || levels.length === 0) return undefined;
    const isLong = side === "BUY";
    const valid = levels.filter((level) => {
      if (!Number.isFinite(level.price) || !Number.isFinite(level.fraction))
        return false;
      if (!(level.fraction > 0 && level.fraction < 1)) return false;
      if (isLong) {
        return level.price > entry && level.price < finalTakeProfit;
      }
      return level.price < entry && level.price > finalTakeProfit;
    });
    if (valid.length === 0) return undefined;
    const sorted = [...valid].sort((a, b) =>
      isLong ? a.price - b.price : b.price - a.price,
    );
    let cumulative = 0;
    const out: PartialTakeProfit[] = [];
    for (const level of sorted) {
      const remaining = 1 - cumulative;
      if (remaining <= 1e-6) break;
      const fraction = Math.min(level.fraction, remaining - 1e-6);
      if (fraction <= 0) break;
      out.push({ fraction, price: level.price });
      cumulative += fraction;
    }
    return out.length > 0 ? out : undefined;
  }

  private async evaluateExit(
    symbol: string,
    conid: string,
    secType: SecType,
    directionalRegime: DirectionalRegime,
    volatilityRegime: VolatilityRegime,
    latestCandle: Candle,
    indicators: IndicatorSnapshot,
    candles1m: Candle[],
    candles5m: Candle[],
    candles1h: Candle[],
    candles4h: Candle[],
    candles12h: Candle[],
    candles1d: Candle[],
    candles1w: Candle[],
    marketState: {
      bid?: number;
      ask?: number;
      lastPrice: number;
      spread?: number;
      ts?: Date | string;
    },
    existingPositionQty: number,
    entryPrice: number | undefined,
    riskSnapshot: ExposureSnapshot,
    activeStrategyIds: string[],
    generatedFromCandleTs?: Date,
  ): Promise<ProposedOrder | null> {
    // Look up which strategy opened this position (stored in proposed_orders)
    const positionInfo = await this.repo.getOpenPositionBySymbol(symbol);
    if (!positionInfo || !positionInfo.strategyId) {
      return null; // No position info or didn't come from a strategy
    }

    // Check if this strategy has earlyExitEnabled
    const profile = findStrategyProfile(positionInfo.strategyId);
    if (!profile || !profile.earlyExitEnabled) {
      return null; // Early exit disabled for this strategy
    }

    // Get the strategy instance
    const strategy = this.portfolioManager.getStrategy(positionInfo.strategyId);
    if (!strategy || !strategy.shouldExit) {
      return null; // Strategy not found or doesn't implement shouldExit
    }

    // Build ExitContext
    const exitContext: ExitContext = {
      symbol,
      conid,
      secType,
      directionalRegime,
      volatilityRegime,
      latestCandle,
      indicators,
      candlesByTimeframe: {
        "1m": candles1m,
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
        averageCost: entryPrice,
        marketPrice: marketState.lastPrice,
      },
      exposureSnapshot: riskSnapshot,
      entryPrice,
      positionQuantity: Math.abs(existingPositionQty),
    };

    // Evaluate shouldExit
    const exitSignal = strategy.shouldExit(exitContext);
    if (!exitSignal) {
      return null; // No exit signal
    }

    // Convert ExitSignal to ProposedOrder
    // Determine the inverted side for closing the position
    const closeSide: Side = existingPositionQty > 0 ? "SELL" : "BUY";
    const quantity = Math.abs(existingPositionQty);

    const order: ProposedOrder = {
      instrument: symbol,
      conid,
      side: closeSide,
      orderType: "MKT",
      quantity,
      entry: entryPrice,
      stop: undefined,
      takeProfit: undefined,
      positionEffect: "CLOSE_OR_REDUCE",
      reason: `Early exit: ${exitSignal.reason}`,
      confidence: exitSignal.confidenceScore,
      timestamp: new Date().toISOString(),
      riskCheckStatus: "PASS",
      indicators: undefined,
      strategy: exitSignal.strategyId,
      status: "PROPOSED",
      createdAt: new Date(),
      generatedFromCandleTs,
      aiReason: exitSignal.metadata
        ? JSON.stringify(exitSignal.metadata)
        : undefined,
    };

    // Persist and return
    const id = await this.repo.insertProposedOrder(order);
    return { ...order, id };
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
    return this.marketRegimeDetector.detectDetailed(secType, price, indicators);
  }

  private buildTimeframeSnapshot(
    candles: Candle[],
    cacheKey?: string,
  ): TimeframeIndicatorSnapshot | undefined {
    if (candles.length < 20) {
      if (cacheKey) this.timeframeSnapshotCache.delete(cacheKey);
      return undefined;
    }
    const latest = candles[candles.length - 1];
    const latestTsMs = latest.ts.getTime();
    if (cacheKey) {
      const cached = this.timeframeSnapshotCache.get(cacheKey);
      if (cached && cached.lastTs === latestTsMs) return cached.snapshot;
    }

    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    const volumes = candles.map((candle) => candle.volume);
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

    const snapshot: TimeframeIndicatorSnapshot = {
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
    if (cacheKey) {
      this.timeframeSnapshotCache.set(cacheKey, {
        lastTs: latestTsMs,
        snapshot,
      });
    }
    return snapshot;
  }

  private returnPct(closes: number[], lookback: number): number | undefined {
    if (closes.length <= lookback) return undefined;
    const current = closes[closes.length - 1];
    const previous = closes[closes.length - 1 - lookback];
    if (!(previous > 0)) return undefined;
    return ((current - previous) / previous) * 100;
  }

  /**
   * Detects current session boundaries using gaps in 1m candle timestamps.
   * Returns intraday metadata (gap pct, session open, opening range, VWAP).
   *
   * Heuristic: scan from the latest candle backwards. The most recent gap
   * larger than `sessionGapMinutes` (default 60) marks the start of the
   * current session. The candle just before the gap is the previous session
   * close.
   *
   * Returns `undefined` for fields that cannot be computed (e.g. when there
   * are not enough candles, or no overnight gap exists in the buffer).
   */
  private buildIntradaySnapshot(
    candles1m: Candle[],
    sessionGapMinutes = 60,
  ): IndicatorSnapshot["intraday"] {
    if (candles1m.length < 2) return undefined;
    const latest = candles1m[candles1m.length - 1];
    const latestTs = new Date(latest.ts).getTime();

    // Walk backwards to find the most recent inter-candle gap > threshold.
    let sessionStartIndex: number | undefined;
    let prevSessionCloseIndex: number | undefined;
    const gapMs = sessionGapMinutes * 60_000;
    for (let i = candles1m.length - 1; i > 0; i -= 1) {
      const curTs = new Date(candles1m[i].ts).getTime();
      const prevTs = new Date(candles1m[i - 1].ts).getTime();
      if (curTs - prevTs >= gapMs) {
        sessionStartIndex = i;
        prevSessionCloseIndex = i - 1;
        break;
      }
    }
    if (sessionStartIndex === undefined) return undefined;

    const sessionOpenCandle = candles1m[sessionStartIndex];
    const prevCloseCandle = candles1m[prevSessionCloseIndex!];
    const sessionOpen = sessionOpenCandle.open;
    const prevSessionClose = prevCloseCandle.close;
    const sessionOpenTs = sessionOpenCandle.ts;
    const minutesSinceSessionOpen = Math.max(
      0,
      Math.floor((latestTs - new Date(sessionOpenTs).getTime()) / 60_000),
    );
    const gapPct =
      prevSessionClose > 0
        ? ((sessionOpen - prevSessionClose) / prevSessionClose) * 100
        : undefined;

    const sessionCandles = candles1m.slice(sessionStartIndex);
    const orWindow = sessionCandles.slice(0, 30);
    const openingRange30High =
      orWindow.length > 0
        ? Math.max(...orWindow.map((c) => c.high))
        : undefined;
    const openingRange30Low =
      orWindow.length > 0 ? Math.min(...orWindow.map((c) => c.low)) : undefined;

    let cumPv = 0;
    let cumVol = 0;
    for (const c of sessionCandles) {
      const typical = (c.high + c.low + c.close) / 3;
      cumPv += typical * c.volume;
      cumVol += c.volume;
    }
    const vwap = cumVol > 0 ? cumPv / cumVol : undefined;
    const distanceFromVwapBps =
      vwap !== undefined && vwap > 0
        ? ((latest.close - vwap) / vwap) * 10000
        : undefined;

    return {
      prevSessionClose,
      sessionOpen,
      sessionOpenTs,
      minutesSinceSessionOpen,
      gapPct,
      openingRange30High,
      openingRange30Low,
      vwap,
      distanceFromVwapBps,
      sessionVolume: cumVol > 0 ? cumVol : undefined,
    };
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
