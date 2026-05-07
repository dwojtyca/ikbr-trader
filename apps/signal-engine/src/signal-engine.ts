import { AssetClass, Candle, CandleTimeframe, IndicatorSnapshot, isStrategyAllowed, MarketRegime, ProposedOrder, RiskLimits, Side, TimeframeIndicatorSnapshot } from '@ikbr/shared';
import { lastAtr, lastBollinger, lastDonchian, lastEma, lastMacd, lastObvSlope, lastRsi } from './indicators.js';
import { ExposureSnapshot, LatestFilledOrderContext, SignalPerformanceStats, SignalRepository } from './repository.js';
import { inferAssetClass, listStrategyProfiles, pickStrategyProfiles, StrategyProfile } from './strategy-profiles.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(denominator) || denominator === 0) return fallback;
  return numerator / denominator;
}

function stepDecimals(step: number): number {
  const normalized = step.toString().toLowerCase();
  if (normalized.includes('e-')) {
    const exp = Number(normalized.split('e-')[1]);
    return Number.isFinite(exp) ? exp : 0;
  }
  const parts = normalized.split('.');
  return parts[1]?.length ?? 0;
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
  fractionalSymbols: Set<string>;
  fractionalQuantityStep: number;
  minStopBpsByAssetClass: Record<AssetClass, number>;
  maxMarketStateAgeMs: number;
  baseCurrency: string;
  assetClassBySymbol: Record<string, AssetClass>;
  currencyBySymbol: Record<string, string>;
  priceMultiplierBySymbol: Record<string, number>;
  executionBaseUrl: string;
  strategyCooldownMs: number;
  symbolAddLossLimit: number;
  strategyAllowlistMode: 'enforce' | 'discover';
  riskLimits: RiskLimits;
}

interface DecisionScore {
  side: Side;
  score: number;
  buyScore: number;
  sellScore: number;
}

interface ConfidenceFloor {
  value: number;
  reason?: string;
}

interface EntryPriceSelection {
  entry: number;
  source: 'touch' | 'last' | 'mid' | 'fallback_last';
}

interface ManagedExitContext {
  symbol: string;
  conid: string;
  latestClose: number;
  latestCandleTs: Date;
  latestFilled: LatestFilledOrderContext | null;
  existingPositionQty: number;
  positionAverageCost?: number;
  positionMarketPrice?: number;
  indicators: IndicatorSnapshot;
  profile: StrategyProfile;
  marketState: { bid?: number; ask?: number; lastPrice: number };
  generatedFromCandleTs?: Date;
}

interface StrategyCandidate {
  profile: StrategyProfile;
  decision: DecisionScore;
}

const STOCK_RANGE_OPEN_DISABLED = false;
const MAX_SYMBOL_EXPOSURE_SHARE_OF_LIMIT = 0.35;
const MAX_DIRECTIONAL_EXPOSURE_SHARE_OF_LIMIT = 0.8;
const STRATEGY_IDS = listStrategyProfiles().map((profile) => profile.id);

export class SignalEngine {
  constructor(
    private readonly repo: SignalRepository,
    private readonly options: SignalEngineOptions
  ) {}

  async runForSymbol(symbol: string, exposureSnapshot?: ExposureSnapshot, generatedFromCandleTs?: Date): Promise<ProposedOrder> {
    const candles = await this.repo.getRecentCandles(symbol, '1m', this.options.minCandles + 80);
    const candles1h = await this.repo.getRecentCandles(symbol, '1h', 160);
    const [candles5m, candles4h, candles12h, candles1d] = await Promise.all([
      this.repo.getRecentCandles(symbol, '5m', 160),
      this.repo.getRecentCandles(symbol, '4h', 120),
      this.repo.getRecentCandles(symbol, '12h', 90),
      this.repo.getRecentCandles(symbol, '1d', 260)
    ]);

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
      rsi14Prev: lastRsi(closes.slice(0, -1), 14),
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
      assetClass,
      timeframes: {
        '5m': this.buildTimeframeSnapshot(candles5m),
        '1h': this.buildTimeframeSnapshot(candles1h),
        '4h': this.buildTimeframeSnapshot(candles4h),
        '12h': this.buildTimeframeSnapshot(candles12h),
        '1d': this.buildTimeframeSnapshot(candles1d)
      }
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
    indicators.regime = regime;
    await this.repo.syncStrategyRuntimeStates(STRATEGY_IDS, this.options.strategyCooldownMs);
    const activeProfiles = await this.getActiveProfiles(assetClass, regime);
    if (activeProfiles.length === 0) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Strategy gate rejected: no active profile for assetClass=${assetClass}, regime=${regime}`,
        indicators,
        'HOLD',
        'strategy_gate',
        generatedFromCandleTs
      );
    }

    const marketState = await this.repo.getMarketState(latest.conid);
    if (!marketState) {
      return this.rejectedOrder(symbol, latest.conid, 'No market state in Redis for conid', indicators, 'HOLD', activeProfiles[0].id, generatedFromCandleTs);
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
        activeProfiles[0].id,
        generatedFromCandleTs
      );
    }

    const riskSnapshot = exposureSnapshot ?? (await this.repo.getExposureSnapshot(this.options.executionBaseUrl));
    const exposure = riskSnapshot.exposure;
    const openPositions = riskSnapshot.openPositions;
    const existingPositionQty = riskSnapshot.positionsBySymbol[symbol.toUpperCase()] ?? 0;
    const hasOpenPosition = Math.abs(existingPositionQty) > 1e-12;
    const positionContext = riskSnapshot.positionContextsBySymbol?.[symbol.toUpperCase()];

    if (hasOpenPosition) {
      const managedExit = await this.evaluateManagedExit({
        symbol,
        conid: latest.conid,
        latestClose: latest.close,
        latestCandleTs: latest.ts,
        latestFilled: await this.repo.getLatestFilledOrderContext(symbol),
        existingPositionQty,
        positionAverageCost: positionContext?.averageCost,
        positionMarketPrice: positionContext?.marketPrice,
        indicators: { ...indicators, strategyProfile: activeProfiles[0].id },
        profile: activeProfiles[0],
        marketState,
        generatedFromCandleTs
      });

      if (managedExit) {
        return managedExit;
      }
    }

    const spread =
      marketState.spread ??
      (marketState.ask !== undefined && marketState.bid !== undefined ? marketState.ask - marketState.bid : undefined);
    const spreadBps = spread ? Math.abs(safeDiv(spread, latest.close) * 10000) : 0;

    const selected = this.selectStrategyCandidate({
      symbol,
      assetClass,
      profiles: activeProfiles,
      price: latest.close,
      indicators,
      volume: volumes[volumes.length - 1],
      spreadBps,
      existingPositionQty
    });
    if (!selected.candidate) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        selected.reason,
        indicators,
        'HOLD',
        activeProfiles[0].id,
        generatedFromCandleTs
      );
    }

    const { profile, decision } = selected.candidate;
    indicators.strategyProfile = profile.id;
    const spreadLimitBps = this.options.maxSpreadBps * profile.spreadFactor;

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

    const closesOrReducesPosition =
      (decision.side === 'BUY' && existingPositionQty < -1e-12) ||
      (decision.side === 'SELL' && existingPositionQty > 1e-12);
    const increasesExistingExposure =
      (decision.side === 'BUY' && existingPositionQty > 1e-12) ||
      (decision.side === 'SELL' && existingPositionQty < -1e-12);

    if (increasesExistingExposure && this.options.symbolAddLossLimit > 0) {
      const dayPnl = await this.repo.getSymbolNetPnlSince(symbol, this.currentUtcDayStart());
      if (dayPnl <= -this.options.symbolAddLossLimit) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Symbol add blocked: same-direction exposure increase after daily realized PnL ${dayPnl.toFixed(2)} <= -${this.options.symbolAddLossLimit.toFixed(2)}`,
          indicators,
          decision.side,
          profile.id,
          generatedFromCandleTs
        );
      }
    }

    if (!closesOrReducesPosition) {
      const qualityRejection = this.evaluateEntryQuality(symbol, assetClass, profile, decision, latest.close, indicators);
      if (qualityRejection) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          qualityRejection,
          indicators,
          decision.side,
          profile.id,
          generatedFromCandleTs
        );
      }
    }

    if (STOCK_RANGE_OPEN_DISABLED && profile.id === 'stocks_range_v1' && !closesOrReducesPosition) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        'Risk overlay rejected signal: stock range opens are disabled pending re-tuning',
        indicators,
        decision.side,
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

    const priceMultiplier = this.priceMultiplierForSymbol(symbol);
    const fxToBase = this.fxToBaseForSymbol(symbol, riskSnapshot);
    if (fxToBase === undefined) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `FX rejected: no conversion rate for ${this.currencyForSymbol(symbol)} to account base`,
        indicators,
        decision.side,
        profile.id,
        generatedFromCandleTs
      );
    }

    const notionalEntry = entry * priceMultiplier * fxToBase;
    const riskPerUnitCash = riskPerUnit * priceMultiplier * fxToBase;
    if (notionalEntry <= 0 || riskPerUnitCash <= 0) {
      return this.rejectedOrder(symbol, latest.conid, 'Notional-adjusted risk per unit is zero', indicators, decision.side, profile.id, generatedFromCandleTs);
    }

    const quantityStep = this.quantityStepForSymbol(symbol);
    const effectiveAccountEquity =
      riskSnapshot.accountEquity && Number.isFinite(riskSnapshot.accountEquity) && riskSnapshot.accountEquity > 0
        ? riskSnapshot.accountEquity
        : this.options.riskLimits.accountEquity;
    const maxRiskCash = (effectiveAccountEquity * this.options.riskLimits.maxRiskPerTradePct) / 100;
    const riskBasedQuantity = this.roundDownToQuantityStep((maxRiskCash / riskPerUnitCash) * profile.quantityFactor, quantityStep);

    if (riskBasedQuantity < quantityStep) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Sizing rejected: quantity below minimum step ${quantityStep}`,
        indicators,
        decision.side,
        profile.id,
        generatedFromCandleTs
      );
    }

    const maxExposure = (effectiveAccountEquity * this.options.riskLimits.maxExposurePct) / 100;
    const maxNotionalPerTradePct = this.options.riskLimits.maxNotionalPerTradePct ?? this.options.riskLimits.maxExposurePct;
    const maxNotionalPerTrade = (effectiveAccountEquity * maxNotionalPerTradePct) / 100;
    const availableExposure = Math.max(0, maxExposure - exposure);
    const currentDirectionalExposure = decision.side === 'BUY'
      ? Math.max(0, riskSnapshot.longExposure ?? 0)
      : Math.max(0, riskSnapshot.shortExposure ?? 0);
    const maxDirectionalExposure = maxExposure * MAX_DIRECTIONAL_EXPOSURE_SHARE_OF_LIMIT;
    const currentSymbolExposure = Math.abs(positionContext?.marketValue ?? 0);
    const maxSymbolExposure = Math.min(maxNotionalPerTrade, maxExposure * MAX_SYMBOL_EXPOSURE_SHARE_OF_LIMIT);
    const availableDirectionalExposure = Math.max(0, maxDirectionalExposure - currentDirectionalExposure);
    const availableSymbolExposure = Math.max(0, maxSymbolExposure - currentSymbolExposure);

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
      const closeQty = this.roundDownToQuantityStep(Math.abs(existingPositionQty), quantityStep);
      if (closeQty < quantityStep) {
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

      const quantityCapByExposure = this.roundDownToQuantityStep(availableExposure / notionalEntry, quantityStep);
      const quantityCapByNotional = this.roundDownToQuantityStep(maxNotionalPerTrade / notionalEntry, quantityStep);
      const quantityCapByDirectionalExposure = this.roundDownToQuantityStep(availableDirectionalExposure / notionalEntry, quantityStep);
      const quantityCapBySymbolExposure = this.roundDownToQuantityStep(availableSymbolExposure / notionalEntry, quantityStep);
      quantity = this.roundDownToQuantityStep(
        Math.min(
          riskBasedQuantity,
          quantityCapByExposure,
          quantityCapByNotional,
          quantityCapByDirectionalExposure,
          quantityCapBySymbolExposure
        ),
        quantityStep
      );

      if (quantity < quantityStep) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Sizing rejected by notional caps (riskQty=${riskBasedQuantity}, capExposureQty=${quantityCapByExposure}, capTradeQty=${quantityCapByNotional}, capDirectionalQty=${quantityCapByDirectionalExposure}, capSymbolQty=${quantityCapBySymbolExposure}, available=${availableExposure.toFixed(2)}, availableDirectional=${availableDirectionalExposure.toFixed(2)}, availableSymbol=${availableSymbolExposure.toFixed(2)}, maxTradeNotional=${maxNotionalPerTrade.toFixed(2)})`,
          indicators,
          decision.side,
          profile.id,
          generatedFromCandleTs
        );
      }

      const newNotional = quantity * notionalEntry;
      if (currentDirectionalExposure + newNotional > maxDirectionalExposure) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Risk overlay rejected: directional exposure too high (current=${currentDirectionalExposure.toFixed(2)}, new=${newNotional.toFixed(2)}, limit=${maxDirectionalExposure.toFixed(2)})`,
          indicators,
          decision.side,
          profile.id,
          generatedFromCandleTs
        );
      }

      if (currentSymbolExposure + newNotional > maxSymbolExposure) {
        return this.rejectedOrder(
          symbol,
          latest.conid,
          `Risk overlay rejected: symbol concentration too high (current=${currentSymbolExposure.toFixed(2)}, new=${newNotional.toFixed(2)}, limit=${maxSymbolExposure.toFixed(2)})`,
          indicators,
          decision.side,
          profile.id,
          generatedFromCandleTs
        );
      }

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
    const baseMinConfidence = clamp(this.options.minConfidence * profile.minConfidenceMultiplier, 0, 0.95);
    const profilePerformance = decision.side === 'BUY' || decision.side === 'SELL'
      ? await this.repo.getSignalPerformance({ strategy: profile.id, side: decision.side, limit: 40 })
      : { trades: 0, wins: 0, losses: 0, winRate: 0 };
    const symbolPerformance = decision.side === 'BUY' || decision.side === 'SELL'
      ? await this.repo.getSignalPerformance({ instrument: symbol, strategy: profile.id, side: decision.side, limit: 30 })
      : { trades: 0, wins: 0, losses: 0, winRate: 0 };
    const confidenceFloor = this.buildConfidenceFloor(baseMinConfidence, profilePerformance, symbolPerformance);
    const minConfidence = confidenceFloor.value;

    if (confidence < minConfidence) {
      return this.rejectedOrder(
        symbol,
        latest.conid,
        `Confidence too low (${confidence.toFixed(2)} < ${minConfidence.toFixed(2)}) for ${profile.id}${confidenceFloor.reason ? `; ${confidenceFloor.reason}` : ''}`,
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

  private currentUtcDayStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private async getActiveProfiles(assetClass: AssetClass, regime: MarketRegime): Promise<StrategyProfile[]> {
    const candidates = pickStrategyProfiles(assetClass, regime);
    const now = Date.now();
    const active: StrategyProfile[] = [];

    for (const profile of candidates) {
      const state = await this.repo.getStrategyRuntimeState(profile.id);
      if (!state.enabled || state.permanentlyDisabled) continue;
      if (state.cooldownUntil && state.cooldownUntil.getTime() > now) continue;
      active.push(profile);
    }

    return active;
  }

  private buildTimeframeSnapshot(candles: Candle[]): TimeframeIndicatorSnapshot | undefined {
    if (candles.length < 20) return undefined;

    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    const latest = candles[candles.length - 1];
    const ema20 = lastEma(closes, 20);
    const ema50 = lastEma(closes, 50);
    const ema200 = lastEma(closes, 200);
    const macd = lastMacd(closes);
    const bb = lastBollinger(closes, 20);
    const atr14 = lastAtr(highs, lows, closes, 14);
    let trend: TimeframeIndicatorSnapshot['trend'] = 'neutral';
    if (ema20 !== undefined && ema50 !== undefined && latest.close > ema50 && ema20 > ema50) trend = 'bullish';
    if (ema20 !== undefined && ema50 !== undefined && latest.close < ema50 && ema20 < ema50) trend = 'bearish';

    return {
      close: latest.close,
      ema20,
      ema50,
      ema200,
      rsi14: lastRsi(closes, 14),
      atr14,
      macdHist: macd.histogram,
      bbWidthPct: bb.widthPct,
      volume: latest.volume,
      trend,
      priceVsEma50Bps: ema50 !== undefined ? safeDiv(latest.close - ema50, latest.close, 0) * 10000 : undefined
    };
  }

  private selectStrategyCandidate(input: {
    symbol: string;
    assetClass: AssetClass;
    profiles: StrategyProfile[];
    price: number;
    indicators: IndicatorSnapshot;
    volume: number;
    spreadBps: number;
    existingPositionQty: number;
  }): { candidate?: StrategyCandidate; reason: string } {
    let best: StrategyCandidate | undefined;
    const rejections: string[] = [];

    for (const profile of input.profiles) {
      const profileIndicators: IndicatorSnapshot = {
        ...input.indicators,
        strategyProfile: profile.id
      };
      const applyVolumeFilter = profile.requireVolume && this.options.volumeFilterMode === 'strict';
      if (applyVolumeFilter && input.volume < this.options.minVolume1m) {
        rejections.push(`Liquidity filter rejected ${profile.id}: low 1m volume`);
        continue;
      }

      const spreadLimitBps = this.options.maxSpreadBps * profile.spreadFactor;
      if (input.spreadBps > spreadLimitBps) {
        rejections.push(`Spread filter rejected ${profile.id} (${input.spreadBps.toFixed(2)} bps > ${spreadLimitBps.toFixed(2)} bps)`);
        continue;
      }

      const decision = this.scoreDecision(profile, input.price, profileIndicators);
      if (decision.side === 'HOLD') {
        rejections.push(`No edge for ${profile.id}: buy=${decision.buyScore.toFixed(2)}, sell=${decision.sellScore.toFixed(2)}`);
        continue;
      }

      const closesOrReducesPosition =
        (decision.side === 'BUY' && input.existingPositionQty < -1e-12) ||
        (decision.side === 'SELL' && input.existingPositionQty > 1e-12);

      if (!closesOrReducesPosition && this.options.strategyAllowlistMode === 'enforce' && !isStrategyAllowed(profile.id, input.symbol, decision.side)) {
        rejections.push(`Allowlist rejected: ${profile.id}/${input.symbol.toUpperCase()}/${decision.side} is not configured`);
        continue;
      }

      const qualityRejection = closesOrReducesPosition
        ? null
        : this.evaluateEntryQuality(input.symbol, input.assetClass, profile, decision, input.price, profileIndicators);
      if (qualityRejection) {
        rejections.push(`${profile.id}: ${qualityRejection}`);
        continue;
      }

      if (!best || decision.score > best.decision.score) {
        best = { profile, decision };
      }
    }

    return {
      candidate: best,
      reason: best
        ? `Selected ${best.profile.id}`
        : rejections.slice(0, 5).join(' | ') || 'Strategy gate rejected: no profile produced an allowed signal'
    };
  }

  private evaluateEntryQuality(
    symbol: string,
    assetClass: AssetClass,
    profile: StrategyProfile,
    decision: DecisionScore,
    price: number,
    indicators: IndicatorSnapshot
  ): string | null {
    if (decision.side !== 'BUY' && decision.side !== 'SELL') return null;

    if (profile.style === 'trend') {
      const buyRsiLimit = profile.assetClass === 'index'
        ? 72
        : 70;
      const sellRsiLimit = profile.assetClass === 'index'
        ? 30
        : 34;

      if (decision.side === 'BUY' && (indicators.rsi14 ?? 50) > buyRsiLimit) {
        return `Entry quality rejected: trend BUY is overextended (RSI14=${indicators.rsi14?.toFixed(2)})`;
      }

      if (decision.side === 'SELL' && (indicators.rsi14 ?? 50) < sellRsiLimit) {
        return `Entry quality rejected: trend SELL is overextended (RSI14=${indicators.rsi14?.toFixed(2)})`;
      }

      if (assetClass === 'stock' && decision.side === 'BUY') {
        const has1hTrend = indicators.trendFilterSource === 'EMA50_1h';
        const aligned1h = price > (indicators.trendFilterValue ?? price);
        const alignedLocalTrend = price > indicators.ema200! && indicators.ema20! > indicators.ema50!;
        if (!((has1hTrend && aligned1h) || alignedLocalTrend)) {
          return `Entry quality rejected: stock trend BUY lacks 1h trend alignment (${symbol})`;
        }
      }

      if (assetClass === 'stock' && decision.side === 'SELL') {
        const macdFalling = indicators.macdHistPrev !== undefined && indicators.macdHist !== undefined
          ? indicators.macdHist < indicators.macdHistPrev
          : true;
        if (!(price < indicators.ema20! && indicators.ema20! < indicators.ema50! && macdFalling)) {
          return `Entry quality rejected: stock trend SELL lacks breakdown confirmation (${symbol})`;
        }
      }
    }

    if (profile.style === 'range') {
      const zoneFactor = assetClass === 'stock'
        ? 0.58
        : assetClass === 'commodity'
          ? 0.55
          : 0.52;
      const lowerZoneTop = indicators.bbLower! + (indicators.bbMiddle! - indicators.bbLower!) * zoneFactor;
      const upperZoneBottom = indicators.bbUpper! - (indicators.bbUpper! - indicators.bbMiddle!) * zoneFactor;
      const rsiPrev = indicators.rsi14Prev;
      const rsiNow = indicators.rsi14!;
      const macdImproving = indicators.macdHistPrev !== undefined && indicators.macdHist !== undefined
        ? indicators.macdHist > indicators.macdHistPrev
        : false;
      const macdWeakening = indicators.macdHistPrev !== undefined && indicators.macdHist !== undefined
        ? indicators.macdHist < indicators.macdHistPrev
        : false;

      if (decision.side === 'BUY') {
        const rsiReversal = rsiPrev !== undefined
          ? (rsiPrev <= 45 && rsiNow > rsiPrev) || rsiNow <= 38
          : rsiNow <= 42;
        const rsiExtreme = rsiNow <= (assetClass === 'stock' ? 38 : 40);
        if (!(price <= lowerZoneTop && rsiReversal && (macdImproving || rsiExtreme))) {
          return `Entry quality rejected: range BUY lacks lower-band reversal (price=${price.toFixed(4)}, RSI14=${rsiNow.toFixed(2)})`;
        }
      }

      if (decision.side === 'SELL') {
        const rsiReversal = rsiPrev !== undefined
          ? (rsiPrev >= 55 && rsiNow < rsiPrev) || rsiNow >= 62
          : rsiNow >= 58;
        const rsiExtreme = rsiNow >= (assetClass === 'stock' ? 62 : 60);
        if (!(price >= upperZoneBottom && rsiReversal && (macdWeakening || rsiExtreme))) {
          return `Entry quality rejected: range SELL lacks upper-band reversal (price=${price.toFixed(4)}, RSI14=${rsiNow.toFixed(2)})`;
        }
      }
    }

    return null;
  }

  private buildConfidenceFloor(
    baseMinConfidence: number,
    profilePerformance: SignalPerformanceStats,
    symbolPerformance: SignalPerformanceStats
  ): ConfidenceFloor {
    let adjustment = 0;
    const reasons: string[] = [];

    if (
      profilePerformance.trades >= 8 &&
      (profilePerformance.expectancyPct ?? 0) < 0 &&
      (profilePerformance.medianPnlPct ?? 0) < 0
    ) {
      adjustment += 0.08;
      reasons.push(
        `profile expectancy weak (n=${profilePerformance.trades}, median=${profilePerformance.medianPnlPct?.toFixed(3)}%, expectancy=${profilePerformance.expectancyPct?.toFixed(3)}%)`
      );
    }

    if (
      symbolPerformance.trades >= 4 &&
      (symbolPerformance.expectancyPct ?? 0) < 0 &&
      (symbolPerformance.medianPnlPct ?? 0) < 0
    ) {
      adjustment += 0.05;
      reasons.push(
        `symbol/profile expectancy weak (n=${symbolPerformance.trades}, median=${symbolPerformance.medianPnlPct?.toFixed(3)}%, expectancy=${symbolPerformance.expectancyPct?.toFixed(3)}%)`
      );
    }

    return {
      value: clamp(baseMinConfidence + adjustment, 0, 0.95),
      reason: reasons.join('; ') || undefined
    };
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
      stock: { atrHigh: 0.01, bbHigh: 0.045, trendBps: 18 },
      commodity: { atrHigh: 0.014, bbHigh: 0.052, trendBps: 14 },
      index: { atrHigh: 0.0085, bbHigh: 0.04, trendBps: 12 }
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
      if (price < trendFilter) buyScore *= 0.76;
      if (price > trendFilter) sellScore *= 0.84;
      if (!emaBullAligned) buyScore *= 0.78;
      if (!emaBearAligned) sellScore *= 0.9;
    } else {
      const trendStretchBps = Math.abs(safeDiv(price - trendFilter, price, 0) * 10000);
      const localTrendBps = Math.abs(safeDiv(indicators.ema20! - indicators.ema50!, price, 0) * 10000);
      if (trendStretchBps >= 28 || localTrendBps >= 20) {
        buyScore *= 0.8;
        sellScore *= 0.84;
      }
    }

    if (profile.assetClass === 'stock' && profile.style !== 'range') {
      if ((indicators.macdHist ?? 0) <= 0) buyScore *= 0.82;
      if ((indicators.macdHist ?? 0) >= 0) sellScore *= 0.94;
      if ((indicators.rsi14 ?? 50) > 66) buyScore *= 0.88;
      if ((indicators.rsi14 ?? 50) < 34) sellScore *= 0.9;
      if (price < indicators.ema20!) buyScore *= 0.85;
      if (price > indicators.ema20!) sellScore *= 0.94;
    } else if (profile.assetClass === 'stock') {
      if ((indicators.rsi14 ?? 50) > 54) buyScore *= 0.88;
      if ((indicators.rsi14 ?? 50) < 46) sellScore *= 0.9;
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

  private async evaluateManagedExit(context: ManagedExitContext): Promise<ProposedOrder | null> {
    const {
      symbol,
      conid,
      latestClose,
      latestCandleTs,
      latestFilled,
      existingPositionQty,
      positionAverageCost,
      positionMarketPrice,
      indicators,
      profile,
      marketState,
      generatedFromCandleTs
    } = context;

    const isLong = existingPositionQty > 0;
    const exitSide: Side = isLong ? 'SELL' : 'BUY';
    const referenceEntry = positionAverageCost ?? latestFilled?.entry;
    const livePrice = positionMarketPrice ?? latestClose;
    const pnlPct = Number.isFinite(referenceEntry) && referenceEntry && referenceEntry > 0
      ? isLong
        ? ((livePrice - referenceEntry) / referenceEntry) * 100
        : ((referenceEntry - livePrice) / referenceEntry) * 100
      : undefined;
    const initialRiskPct = latestFilled?.entry && latestFilled.stop
      ? Math.abs((latestFilled.entry - latestFilled.stop) / latestFilled.entry) * 100
      : undefined;
    const rMultiple = pnlPct !== undefined && initialRiskPct !== undefined && initialRiskPct > 0
      ? pnlPct / initialRiskPct
      : undefined;

    const heldMinutes = latestFilled
      ? Math.max(0, Math.floor((latestCandleTs.getTime() - latestFilled.executedAt.getTime()) / 60000))
      : 0;
    const maxHoldMinutes = profile.style === 'range'
      ? 60
      : profile.style === 'trend'
        ? 240
        : 150;

    const longMomentumBroken =
      latestClose < (indicators.trendFilterValue ?? latestClose) &&
      indicators.ema20! < indicators.ema50! &&
      (indicators.macdHist ?? 0) < 0 &&
      (indicators.rsi14 ?? 50) < 48;
    const shortMomentumBroken =
      latestClose > (indicators.trendFilterValue ?? latestClose) &&
      indicators.ema20! > indicators.ema50! &&
      (indicators.macdHist ?? 0) > 0 &&
      (indicators.rsi14 ?? 50) > 52;

    if (heldMinutes >= maxHoldMinutes && (pnlPct === undefined || pnlPct < 0.2)) {
      return this.buildManagedExitOrder(
        symbol,
        conid,
        existingPositionQty,
        exitSide,
        marketState,
        indicators,
        profile.id,
        `Managed exit: time stop after ${heldMinutes}m with pnl=${pnlPct?.toFixed(2) ?? 'n/a'}%`,
        generatedFromCandleTs
      );
    }

    const profitProtectTriggered =
      pnlPct !== undefined &&
      pnlPct > 0 &&
      (rMultiple === undefined || rMultiple >= 0.7) &&
      (
        (isLong && latestClose < indicators.ema20! && (indicators.macdHist ?? 0) < (indicators.macdHistPrev ?? indicators.macdHist ?? 0)) ||
        (!isLong && latestClose > indicators.ema20! && (indicators.macdHist ?? 0) > (indicators.macdHistPrev ?? indicators.macdHist ?? 0))
      );

    if (profitProtectTriggered) {
      return this.buildManagedExitOrder(
        symbol,
        conid,
        existingPositionQty,
        exitSide,
        marketState,
        indicators,
        profile.id,
        `Managed exit: profit protection after ${heldMinutes}m with pnl=${pnlPct.toFixed(2)}%${rMultiple !== undefined ? ` (${rMultiple.toFixed(2)}R)` : ''}`,
        generatedFromCandleTs
      );
    }

    if ((isLong && longMomentumBroken) || (!isLong && shortMomentumBroken)) {
      return this.buildManagedExitOrder(
        symbol,
        conid,
        existingPositionQty,
        exitSide,
        marketState,
        indicators,
        profile.id,
        `Managed exit: momentum breakdown with pnl=${pnlPct?.toFixed(2) ?? 'n/a'}%`,
        generatedFromCandleTs
      );
    }

    return null;
  }

  private buildManagedExitOrder(
    symbol: string,
    conid: string,
    existingPositionQty: number,
    side: Side,
    marketState: { bid?: number; ask?: number; lastPrice: number },
    indicators: IndicatorSnapshot,
    strategy: string,
    reason: string,
    generatedFromCandleTs?: Date
  ): ProposedOrder | null {
    const quantityStep = this.quantityStepForSymbol(symbol);
    const quantity = this.roundDownToQuantityStep(Math.abs(existingPositionQty), quantityStep);
    if (quantity < quantityStep) return null;

    const entrySelection = this.selectEntryPrice(side === 'BUY' ? 'BUY' : 'SELL', marketState.lastPrice, marketState);
    return {
      instrument: symbol,
      conid,
      side,
      positionEffect: 'CLOSE_OR_REDUCE',
      orderType: 'LMT',
      quantity,
      entry: entrySelection.entry,
      reason,
      confidence: 0.72,
      timestamp: new Date().toISOString(),
      riskCheckStatus: 'PASS',
      status: 'PROPOSED',
      strategy,
      indicators,
      generatedFromCandleTs
    };
  }

  private quantityStepForSymbol(symbol: string): number {
    return this.options.fractionalSymbols.has(symbol.toUpperCase())
      ? this.options.fractionalQuantityStep
      : 1;
  }

  private priceMultiplierForSymbol(symbol: string): number {
    const multiplier = this.options.priceMultiplierBySymbol[symbol.toUpperCase()];
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  }

  private currencyForSymbol(symbol: string): string {
    return (this.options.currencyBySymbol[symbol.toUpperCase()] ?? this.options.baseCurrency).trim().toUpperCase();
  }

  private fxToBaseForSymbol(symbol: string, riskSnapshot: ExposureSnapshot): number | undefined {
    const currency = this.currencyForSymbol(symbol);
    const baseCurrency = this.options.baseCurrency.trim().toUpperCase();
    if (currency === baseCurrency) return 1;

    const rate = riskSnapshot.fxToBaseByCurrency?.[currency];
    return Number.isFinite(rate) && Number(rate) > 0 ? Number(rate) : undefined;
  }

  private roundDownToQuantityStep(value: number, step: number): number {
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(step) || step <= 0) return 0;
    const decimals = stepDecimals(step);
    const scaled = Math.floor(value / step + 1e-9) * step;
    return Number(scaled.toFixed(decimals));
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
