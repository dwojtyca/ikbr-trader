import { Worker } from "node:worker_threads";
import { SignalEngine } from "@ikbr/signal-engine/signal-engine";
import { createStrategies } from "@ikbr/signal-engine/strategies/strategy-registry";
import type {
  Candle,
  InstrumentContract,
  ProposedOrder,
  Side,
} from "@ikbr/shared";
import {
  applyAdverseSlippage,
  futuresRoundTripPnl,
  normalizeInstructionPrice,
  priceToTicks,
  stopExitReference,
} from "./bar-execution.js";
import {
  assertWholeContracts,
  FUTURES_EXECUTION_MODEL_VERSION,
  requireFuturesSpec,
  validateFuturesContractMetadata,
  type FuturesContractSpec,
} from "./futures-model.js";
import {
  aggregateCmeFuturesCandles,
  CmeSessionCalendar,
  type CmeCalendarDefinition,
} from "./cme-session-calendar.js";
import {
  listAllStrategyProfiles,
  listStrategyProfiles,
  type StrategyProfile,
} from "@ikbr/shared";
import type { BacktestRepository } from "./repository.js";
import type {
  BacktestFillRecord,
  BacktestFuturesContractMetadata,
  BacktestSignalDiagnosticRecord,
  LoadedBacktestData,
} from "./types.js";

export interface SimulatorOptions {
  minCandles: number;
  maxSpreadBps: number;
  minVolume1m: number;
  minConfidence: number;
  lmtEntryMode: "touch" | "last" | "mid";
  lmtEntryBufferBps: number;
  fractionalSymbols: Set<string>;
  fractionalQuantityStep: number;
  minStopBpsBySecType: Record<string, number>;
  baseCurrency: string;
  currencyBySymbol: Record<string, string>;
  secTypeBySymbol: Record<string, string>;
  priceMultiplierBySymbol: Record<string, number>;
  strategyCooldownMs: number;
  commissionBps: number;
  /** Per-share fee per side (e.g. IBKR Tiered = 0.0035). 0 disables the per-share model. */
  commissionPerShare: number;
  /** Minimum commission per side in account base currency (e.g. IBKR Tiered = $0.35). */
  commissionMinPerSide: number;
  /** Exchange + clearing + regulatory pass-through, in bps of notional per side. */
  commissionPassthroughBps: number;
  syntheticSpreadBps: number;
  orderTtlCandles: number;
  futuresSpecs: ReadonlyMap<string, FuturesContractSpec>;
  futuresContracts: ReadonlyMap<string, BacktestFuturesContractMetadata>;
  futuresCalendars: ReadonlyMap<string, CmeCalendarDefinition>;
  strategyIds?: string[];
  /** Research-only injection seam. Production callers use the registry. */
  strategyFactory?: () => readonly object[];
  /** Research-only: ignore stored aggregates and derive every timeframe from projected 1m futures rows. */
  deriveAllFuturesTimeframesFrom1m?: boolean;
  /** Test-only semantic oracle for indexed candle lookup parity. */
  recentCandleLookup?: "indexed" | "reference";
  riskLimits: {
    accountEquity: number;
    maxRiskPerTradePct: number;
    targetRiskPerTradePct?: number;
    maxExposurePct: number;
    maxNotionalPerTradePct: number;
    maxOpenPositions: number;
  };
}

interface StrategyState {
  strategyId: string;
  enabled: boolean;
  permanentlyDisabled: boolean;
  cooldownUntil?: Date;
  consecutiveLossCount: number;
  cooldownCount: number;
  reason?: string;
}

interface ClosedTrade {
  instrument: string;
  strategy: string;
  side: Side;
  pnl: number;
  pnlPct: number;
  exitedAt: Date;
}

interface PendingOrder {
  id: number;
  order: ProposedOrder;
  remainingCandles: number;
  generatedAt: Date;
}

interface PendingPartial {
  fraction: number;
  price: number;
  executed: boolean;
}

interface Position {
  symbol: string;
  conid?: string;
  quantity: number;
  /** Absolute size at the very first entry; used to size partial closes. */
  originalQuantityAbs: number;
  averageCost: number;
  stop?: number;
  /** Initial stop captured at entry; used to compute 1R for breakeven move. */
  initialStop?: number;
  takeProfit?: number;
  /**
   * Intermediate take-profit ladder. Each level is closed for
   * `originalQuantityAbs * fraction` shares (rounded down). Sorted in the
   * order the price would be reached for the position's direction.
   */
  pendingPartials?: PendingPartial[];
  /**
   * Trailing-stop offset in percent of price (mirrors live IBKR TRAIL order).
   * When set, the simulator ratchets `stop` upward (long) or downward (short)
   * each candle so that `stop = peak * (1 - pct/100)` (long) or
   * `stop = trough * (1 + pct/100)` (short). Initial `stop` acts as the
   * floor (long) / ceiling (short) — the trail never relaxes it.
   */
  trailingStopPct?: number;
  /**
   * R-multiple offset that delays trailing-stop activation. Trail starts
   * tracking only once unrealized profit reaches `entry + activationR * R`
   * (long) or `entry - activationR * R` (short), where R = `entry - initialStop`
   * for long. While inactive, `stop` stays pinned at `initialStop`. After
   * activation we additionally ratchet `stop` to break-even (entry) before
   * the trail takes over, so a fully-armed trail can never give back to the
   * initial-loss zone.
   */
  trailingStopActivationR?: number;
  /** True once price reached the activation threshold. */
  trailActivated?: boolean;
  /** Highest high seen since entry (long) — for trail computation. */
  peakPrice?: number;
  /** Lowest low seen since entry (short) — for trail computation. */
  troughPrice?: number;
  entryAt: Date;
  orderId: number;
  strategy: string;
  runtimeKey: string;
  confidence: number;
  directionalRegime: string;
  volatilityRegime: string;
  side: Side;
  priceMultiplier: number;
  fxToBaseAtEntry: number;
  entryReferencePrice: number;
  entrySlippage: number;
  futuresSpec?: FuturesContractSpec;
}

const YIELD_EVERY_EVENTS = 1000;
const PROGRESS_EVERY_EVENTS = 10000;

interface RunProgressOptions {
  baseCurrent?: number;
  total?: number;
  label?: string;
  onProgress?: (progress: {
    current: number;
    total: number;
    label: string;
  }) => Promise<void> | void;
}

interface StrategyWorkerMessage {
  type: "progress" | "completed";
  strategyId: string;
  current?: number;
  total?: number;
  metrics?: {
    totalPnl: number;
    trades: number;
    wins: number;
    winRate: number;
  };
}

interface StrategyWorkItem {
  profile: StrategyProfile;
  profileIndex: number;
  symbols: string[];
  eventCount: number;
}

type BacktestTimeframe = Candle["timeframe"];

interface IndexedCandleSeries {
  rows: Candle[];
  visibleAt: number[];
}

interface CandleLookupIndex {
  all: IndexedCandleSeries;
  byConid: Map<string, IndexedCandleSeries>;
}

function appendIndexedCandle(
  index: IndexedCandleSeries,
  row: Candle,
  visibleAt: number,
): void {
  index.rows.push(row);
  index.visibleAt.push(visibleAt);
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function indexedTail(
  series: IndexedCandleSeries | undefined,
  visibleThrough: number,
  limit: number,
): Candle[] {
  if (!series) return [];
  const end = upperBound(series.visibleAt, visibleThrough);
  if (limit <= 0) return series.rows.slice(0, end).slice(-limit);
  return series.rows.slice(Math.max(0, end - limit), end);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isOrderTouched(order: ProposedOrder, candle: Candle): boolean {
  if (order.orderType === "MKT") return true;
  const entry = order.entry;
  if (!Number.isFinite(entry)) return false;
  if (order.orderType === "STP") {
    if (order.side === "BUY") return candle.high >= Number(entry);
    if (order.side === "SELL") return candle.low <= Number(entry);
    return false;
  }
  if (order.side === "BUY") return candle.low <= Number(entry);
  if (order.side === "SELL") return candle.high >= Number(entry);
  return false;
}

function signedQuantity(side: Side, quantity: number): number {
  return side === "SELL" ? -Math.abs(quantity) : Math.abs(quantity);
}

export class BacktestSimulator {
  private readonly candles1mBySymbol: Map<string, Candle[]>;
  private readonly candlesByTimeframe: Record<
    "1m" | "5m" | "1h" | "4h" | "12h" | "1d" | "1w",
    Map<string, Candle[]>
  >;
  private readonly currentIndexBySymbol = new Map<string, number>();
  private readonly futuresCalendarBySymbol = new Map<string, CmeSessionCalendar>();
  private readonly candleLookupIndexes: Record<
    BacktestTimeframe,
    Map<string, CandleLookupIndex>
  >;
  private readonly positions = new Map<string, Position>();
  private readonly pendingOrders: PendingOrder[] = [];
  private readonly strategyStates = new Map<string, StrategyState>();
  private readonly closedTrades: ClosedTrade[] = [];
  private readonly diagnostics = new Map<
    string,
    BacktestSignalDiagnosticRecord
  >();
  private currentCandle?: Candle;
  private currentTime?: Date;
  private readonly lastCandleBySymbol = new Map<string, Candle>();
  private currentEquity: number;

  constructor(
    private readonly repo: BacktestRepository,
    private readonly runId: number,
    private readonly data: LoadedBacktestData,
    private readonly options: SimulatorOptions,
  ) {
    this.candles1mBySymbol = data.candles1m;
    this.candlesByTimeframe = {
      "1m": new Map(data.candles1m),
      "5m": new Map(data.candles5m),
      "1h": new Map(data.candles1h),
      "4h": new Map(data.candles4h),
      "12h": new Map(data.candles12h),
      "1d": new Map(data.candles1d),
      "1w": new Map(data.candles1w),
    };
    this.currentEquity = options.riskLimits.accountEquity;
    const activeStrategyIds = new Set(
      options.strategyIds ??
        listStrategyProfiles().map((profile) => profile.id),
    );
    for (const profile of listStrategyProfiles()) {
      if (!activeStrategyIds.has(profile.id)) continue;
      this.strategyStates.set(profile.id, {
        strategyId: profile.id,
        enabled: true,
        permanentlyDisabled: false,
        consecutiveLossCount: 0,
        cooldownCount: 0,
        reason: undefined,
      });
    }
    for (const [symbol, candles] of data.candles1m) {
      if (!this.isFuturesSymbol(symbol) || candles.length === 0) continue;
      const metadata = this.options.futuresContracts.get(candles[0].conid);
      const spec = metadata ? this.options.futuresSpecs.get(metadata.tradingClass.toUpperCase()) : undefined;
      const definition = spec ? this.options.futuresCalendars.get(spec.calendarVersion) : undefined;
      if (!definition) continue;
      const calendar = new CmeSessionCalendar(definition);
      this.futuresCalendarBySymbol.set(symbol.toUpperCase(), calendar);
      const timeframes = options.deriveAllFuturesTimeframesFrom1m
        ? (["5m", "1h", "4h", "12h", "1d", "1w"] as const)
        : (["1h", "4h", "1d"] as const);
      for (const timeframe of timeframes) {
        this.candlesByTimeframe[timeframe].set(symbol.toUpperCase(), aggregateCmeFuturesCandles(candles, timeframe, calendar));
      }
    }
    this.candleLookupIndexes = this.buildCandleLookupIndexes();
  }

  private buildCandleLookupIndexes(): Record<
    BacktestTimeframe,
    Map<string, CandleLookupIndex>
  > {
    const result = Object.fromEntries(
      (["1m", "5m", "1h", "4h", "12h", "1d", "1w"] as const)
        .map((timeframe) => [timeframe, new Map<string, CandleLookupIndex>()]),
    ) as Record<BacktestTimeframe, Map<string, CandleLookupIndex>>;
    const durationsMs: Record<Exclude<BacktestTimeframe, "1m">, number> = {
      "5m": 5 * 60_000,
      "1h": 60 * 60_000,
      "4h": 4 * 60 * 60_000,
      "12h": 12 * 60 * 60_000,
      "1d": 24 * 60 * 60_000,
      "1w": 7 * 24 * 60 * 60_000,
    };

    for (const timeframe of ["1m", "5m", "1h", "4h", "12h", "1d", "1w"] as const) {
      for (const [rawSymbol, rows] of this.candlesByTimeframe[timeframe]) {
        const symbol = rawSymbol.toUpperCase();
        const index: CandleLookupIndex = {
          all: { rows: [], visibleAt: [] },
          byConid: new Map(),
        };
        const calendar = this.futuresCalendarBySymbol.get(symbol);
        for (let sourceIndex = 0; sourceIndex < rows.length; sourceIndex += 1) {
          const row = rows[sourceIndex];
          const visibleAt = timeframe === "1m"
            ? sourceIndex
            : calendar && (this.options.deriveAllFuturesTimeframesFrom1m ||
                timeframe === "1h" || timeframe === "4h" || timeframe === "1d")
              ? calendar.completedAt(row.ts, timeframe).getTime()
              : row.ts.getTime() + durationsMs[timeframe];
          appendIndexedCandle(index.all, row, visibleAt);
          let contract = index.byConid.get(row.conid);
          if (!contract) {
            contract = { rows: [], visibleAt: [] };
            index.byConid.set(row.conid, contract);
          }
          appendIndexedCandle(contract, row, visibleAt);
        }
        result[timeframe].set(symbol, index);
      }
    }
    return result;
  }

  async run(progress?: RunProgressOptions): Promise<{
    totalPnl: number;
    trades: number;
    wins: number;
    winRate: number;
  }> {
    this.validateFuturesDataset();
    const signalEngine = new SignalEngine(this as any, {
      strategies: this.options.strategyFactory
        ? [...this.options.strategyFactory()]
        : createStrategies(this.options.strategyIds),
      minCandles: this.options.minCandles,
      maxSpreadBps: this.options.maxSpreadBps,
      minVolume1m: this.options.minVolume1m,
      volumeFilterMode: "off",
      minConfidence: this.options.minConfidence,
      lmtEntryMode: this.options.lmtEntryMode,
      lmtEntryBufferBps: this.options.lmtEntryBufferBps,
      fractionalSymbols: this.options.fractionalSymbols,
      fractionalQuantityStep: this.options.fractionalQuantityStep,
      minStopBpsBySecType: this.options.minStopBpsBySecType,
      maxMarketStateAgeMs: 0,
      baseCurrency: this.options.baseCurrency,
      secTypeBySymbol: this.options.secTypeBySymbol,
      currencyBySymbol: this.options.currencyBySymbol,
      priceMultiplierBySymbol: this.options.priceMultiplierBySymbol,
      executionBaseUrl: "backtest",
      strategyCooldownMs: this.options.strategyCooldownMs,
      riskLimits: this.options.riskLimits,
    });

    const mergeSymbols = [...this.candles1mBySymbol.keys()].sort();
    const mergeArrays = mergeSymbols.map((s) => this.candles1mBySymbol.get(s)!);
    const mergeIndices = new Array<number>(mergeSymbols.length).fill(0);
    const totalEvents = this.data.candleCount1m;
    const cursorBySymbol = new Map<string, number>();
    const progressBase = progress?.baseCurrent ?? 0;
    const progressTotal = progress?.total ?? totalEvents;
    const progressLabel = progress?.label ?? "running backtest";
    await progress?.onProgress?.({
      current: progressBase,
      total: progressTotal,
      label: progressLabel,
    });

    let eventIndex = 0;
    const perfEnabled = process.env.BACKTEST_PERF === "1";
    const perf = {
      merge: 0,
      pending: 0,
      bracket: 0,
      signal: 0,
      exposure: 0,
      diag: 0,
      insertOrder: 0,
      lastReport: Date.now(),
    };
    while (true) {
      const tMerge = perfEnabled ? performance.now() : 0;
      let bestIdx = -1;
      let bestTs = Number.POSITIVE_INFINITY;
      for (let i = 0; i < mergeSymbols.length; i++) {
        if (mergeIndices[i] >= mergeArrays[i].length) continue;
        const ts = mergeArrays[i][mergeIndices[i]].ts.getTime();
        if (ts < bestTs) {
          bestTs = ts;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      const eventCandle = mergeArrays[bestIdx][mergeIndices[bestIdx]];
      const eventKey = mergeSymbols[bestIdx];
      mergeIndices[bestIdx] += 1;
      if (perfEnabled) perf.merge += performance.now() - tMerge;

      if (eventIndex > 0 && eventIndex % YIELD_EVERY_EVENTS === 0) {
        await yieldToEventLoop();
      }
      if (eventIndex > 0 && eventIndex % PROGRESS_EVERY_EVENTS === 0) {
        await progress?.onProgress?.({
          current: progressBase + eventIndex,
          total: progressTotal,
          label: progressLabel,
        });
        if (perfEnabled) {
          const now = Date.now();
          const elapsed = now - perf.lastReport;
          // eslint-disable-next-line no-console
          console.log(
            `[perf] events=${eventIndex} wall=${elapsed}ms merge=${perf.merge.toFixed(0)} pending=${perf.pending.toFixed(0)} bracket=${perf.bracket.toFixed(0)} exposure=${perf.exposure.toFixed(0)} signal=${perf.signal.toFixed(0)} diag=${perf.diag.toFixed(0)} insertOrder=${perf.insertOrder.toFixed(0)} (ms)`,
          );
          perf.merge = 0;
          perf.pending = 0;
          perf.bracket = 0;
          perf.exposure = 0;
          perf.signal = 0;
          perf.diag = 0;
          perf.insertOrder = 0;
          perf.lastReport = now;
        }
      }

      const index = (cursorBySymbol.get(eventKey) ?? -1) + 1;
      cursorBySymbol.set(eventKey, index);

      await this.processContractTransition(eventCandle);
      this.currentCandle = eventCandle;
      this.currentTime = eventCandle.ts;
      this.currentIndexBySymbol.set(eventKey, index);

      const tPending = perfEnabled ? performance.now() : 0;
      await this.processPendingOrders(eventCandle);
      if (perfEnabled) perf.pending += performance.now() - tPending;
      const tBracket = perfEnabled ? performance.now() : 0;
      await this.processBracketExit(eventCandle);
      if (perfEnabled) perf.bracket += performance.now() - tBracket;

      if (this.hasPendingOrderForSymbol(eventCandle.symbol)) {
        eventIndex += 1;
        continue;
      }

      const tExposure = perfEnabled ? performance.now() : 0;
      const exposure = await this.getExposureSnapshot();
      if (perfEnabled) perf.exposure += performance.now() - tExposure;
      const tSignal = perfEnabled ? performance.now() : 0;
      const order = await signalEngine.runForSymbol(
        eventCandle.symbol,
        exposure,
        eventCandle.ts,
      );
      if (perfEnabled) perf.signal += performance.now() - tSignal;
      const tDiag = perfEnabled ? performance.now() : 0;
      this.recordDiagnostic(order, "analyzed", "all");
      if (
        order.riskCheckStatus !== "PASS" ||
        order.side === "HOLD" ||
        order.quantity <= 0
      ) {
        this.recordDiagnostic(
          order,
          "rejected",
          this.classifyRejection(order.reason),
        );
        this.recordDiagnostic(
          order,
          "rejected_detail",
          this.rejectionDetail(order.reason),
        );
        if (perfEnabled) perf.diag += performance.now() - tDiag;
        eventIndex += 1;
        continue;
      }
      this.recordDiagnostic(order, "proposed", "pass");
      if (perfEnabled) perf.diag += performance.now() - tDiag;

      this.validateFuturesOrder(order, eventCandle);

      const tInsert = perfEnabled ? performance.now() : 0;
      const orderId = await this.repo.insertOrder({
        runId: this.runId,
        instrument: order.instrument,
        conid: order.conid,
        side: order.side,
        positionEffect: order.positionEffect,
        orderType: order.orderType,
        quantity: order.quantity,
        entry: order.entry,
        stop: order.stop,
        takeProfit: order.takeProfit,
        reason: order.reason,
        confidence: order.confidence,
        riskCheckStatus: order.riskCheckStatus,
        status: "PROPOSED",
        strategy: order.strategy,
        indicatorSnapshot: order.indicators,
        partialTakeProfits: order.partialTakeProfits,
        trailingStopPct: order.trailingStopPct,
        trailingStopActivationR: order.trailingStopActivationR,
        generatedFromCandleTs: eventCandle.ts,
        createdAt: eventCandle.ts,
      });
      this.pendingOrders.push({
        id: orderId,
        order,
        generatedAt: eventCandle.ts,
        remainingCandles: this.options.orderTtlCandles,
      });
      if (perfEnabled) perf.insertOrder += performance.now() - tInsert;
      eventIndex += 1;
    }

    await progress?.onProgress?.({
      current: progressBase + eventIndex,
      total: progressTotal,
      label: progressLabel,
    });
    await this.closeOpenPositionsAtDatasetEnd();
    await this.persistStrategyStates();
    await this.persistDiagnostics();

    const totalPnl = this.closedTrades.reduce(
      (sum, trade) => sum + trade.pnl,
      0,
    );
    const wins = this.closedTrades.filter((trade) => trade.pnl > 0).length;
    return {
      totalPnl,
      trades: this.closedTrades.length,
      wins,
      winRate:
        this.closedTrades.length > 0 ? wins / this.closedTrades.length : 0,
    };
  }

  private isFuturesSymbol(symbol: string): boolean {
    return this.options.secTypeBySymbol[symbol.toUpperCase()]?.toUpperCase() === "FUT";
  }

  private validateFuturesDataset(): void {
    for (const [symbolRaw, candles] of this.candles1mBySymbol) {
      const symbol = symbolRaw.toUpperCase();
      if (!this.isFuturesSymbol(symbol)) continue;
      if (candles.length === 0) continue;
      const retired = new Set<string>();
      let activeConid: string | undefined;
      let previousTs = -Infinity;
      for (const candle of candles) {
        if (!candle.conid?.trim()) throw new Error(`Futures candle for ${symbol} is missing conId`);
        if (candle.ts.getTime() <= previousTs)
          throw new Error(`Futures candles for ${symbol} overlap or are not strictly ordered`);
        previousTs = candle.ts.getTime();
        const metadata = this.options.futuresContracts.get(candle.conid);
        if (!metadata) throw new Error(`Missing futures contract metadata for conId ${candle.conid}`);
        const validated = validateFuturesContractMetadata(metadata);
        if (validated.symbol !== symbol)
          throw new Error(`Futures conId ${candle.conid} belongs to ${validated.symbol}, not ${symbol}`);
        const spec = requireFuturesSpec(this.options.futuresSpecs, validated.tradingClass);
        const calendarDefinition = this.options.futuresCalendars.get(spec.calendarVersion);
        if (!calendarDefinition)
          throw new Error(`Missing CME calendar ${spec.calendarVersion} for ${symbol}`);
        const calendar = new CmeSessionCalendar(calendarDefinition);
        if (!calendar.sessionFor(candle.ts))
          throw new Error(`Futures candle for conId ${candle.conid} is outside its CME session`);
        if (this.currencyForSymbol(symbol) !== spec.currency)
          throw new Error(`Futures currency mismatch for ${symbol}`);
        if (spec.currency !== this.options.baseCurrency.trim().toUpperCase() &&
          this.fxToBaseForCurrency(spec.currency, candle.ts) === undefined)
          throw new Error(`Missing FX rate for ${symbol} at ${candle.ts.toISOString()}`);
        for (const [field, price] of [["open", candle.open], ["high", candle.high],
          ["low", candle.low], ["close", candle.close]] as const) {
          if (!Number.isInteger(priceToTicks(price, spec.tickSize)))
            throw new Error(`Futures candle ${field} for conId ${candle.conid} is off tick grid`);
        }
        if (candle.ts.getTime() >= validated.lastTradeAt.getTime())
          throw new Error(`Futures candle for conId ${candle.conid} is at or after last trade`);
        if (activeConid !== candle.conid) {
          if (retired.has(candle.conid))
            throw new Error(`Retired futures conId ${candle.conid} reappeared`);
          if (activeConid) retired.add(activeConid);
          activeConid = candle.conid;
        }
      }
    }
  }

  private async processContractTransition(candle: Candle): Promise<void> {
    const symbol = candle.symbol.toUpperCase();
    const previous = this.lastCandleBySymbol.get(symbol);
    if (this.isFuturesSymbol(symbol) && previous && previous.conid !== candle.conid) {
      const position = this.positions.get(symbol);
      if (position) {
        const exitSide = position.quantity > 0 ? "SELL" : "BUY";
        const exitPrice = position.futuresSpec
          ? applyAdverseSlippage(previous.close, exitSide, position.futuresSpec)
          : previous.close;
        const outgoingMetadata = this.options.futuresContracts.get(previous.conid);
        const reason = outgoingMetadata && candle.ts.getTime() >= outgoingMetadata.lastTradeAt.getTime()
          ? "expiry"
          : "contract_roll";
        await this.closePosition(position, exitPrice, previous.ts, reason, position.orderId, previous.close, previous.conid);
      }
      const keep: PendingOrder[] = [];
      for (const pending of this.pendingOrders) {
        if (pending.order.instrument.toUpperCase() === symbol) {
          await this.repo.updateOrderStatus(pending.id, "CANCELLED", "contract_roll");
        } else keep.push(pending);
      }
      this.pendingOrders.length = 0;
      this.pendingOrders.push(...keep);
    }
    this.lastCandleBySymbol.set(symbol, candle);
  }

  private validateFuturesOrder(order: ProposedOrder, candle: Candle): void {
    if (!this.isFuturesSymbol(order.instrument)) return;
    if (order.conid !== candle.conid)
      throw new Error(`Futures order conId ${order.conid ?? "missing"} does not match current contract ${candle.conid}`);
    const spec = this.futuresSpecForConid(candle.conid);
    if (!spec) throw new Error(`Missing futures specification for conId ${candle.conid}`);
    assertWholeContracts(order.quantity);
    const existing = this.positions.get(order.instrument.toUpperCase());
    const orderDirection = order.side === "SELL" ? -1 : 1;
    if (existing && Math.sign(existing.quantity) === orderDirection)
      throw new Error("Futures pyramiding is not supported by execution model pr15.5b-v1");
    if (order.orderType !== "MKT") {
      if (!Number.isFinite(order.entry)) throw new Error("Futures limit/stop order requires an entry price");
      normalizeInstructionPrice(Number(order.entry), spec.tickSize, order.side as "BUY" | "SELL",
        order.orderType === "STP" ? "stop" : "limit");
    }
    const exitSide = order.side === "BUY" ? "SELL" : "BUY";
    if (order.stop !== undefined)
      normalizeInstructionPrice(order.stop, spec.tickSize, exitSide, "stop");
    if (order.takeProfit !== undefined)
      normalizeInstructionPrice(order.takeProfit, spec.tickSize, exitSide, "limit");
    for (const partial of order.partialTakeProfits ?? [])
      normalizeInstructionPrice(partial.price, spec.tickSize, exitSide, "limit");
  }

  async getRecentCandles(
    symbol: string,
    timeframe: Candle["timeframe"],
    limit: number,
  ): Promise<Candle[]> {
    const key = symbol.toUpperCase();
    if (this.options.recentCandleLookup === "reference")
      return this.getRecentCandlesReference(key, timeframe, limit);
    if (timeframe === "1m") {
      const index = this.currentIndexBySymbol.get(key) ?? -1;
      if (index < 0) return [];
      const rows = this.candles1mBySymbol.get(key) ?? [];
      const currentConid = this.currentCandle?.symbol.toUpperCase() === key
        ? this.currentCandle.conid : rows[index]?.conid;
      return indexedTail(
        this.candleLookupIndexes[timeframe].get(key)?.byConid.get(currentConid),
        index,
        limit,
      );
    }

    const evaluationTime = this.currentTime ?? new Date(0);
    const currentConid = this.currentCandle?.symbol.toUpperCase() === key
      ? this.currentCandle.conid : undefined;
    const lookup = this.candleLookupIndexes[timeframe].get(key);
    return indexedTail(
      currentConid ? lookup?.byConid.get(currentConid) : lookup?.all,
      evaluationTime.getTime(),
      limit,
    );
  }

  private getRecentCandlesReference(
    key: string,
    timeframe: BacktestTimeframe,
    limit: number,
  ): Candle[] {
    if (timeframe === "1m") {
      const rows = this.candles1mBySymbol.get(key) ?? [];
      const index = this.currentIndexBySymbol.get(key) ?? -1;
      if (index < 0) return [];
      const currentConid = this.currentCandle?.symbol.toUpperCase() === key
        ? this.currentCandle.conid : rows[index]?.conid;
      return rows.slice(0, index + 1)
        .filter((row) => row.conid === currentConid).slice(-limit);
    }
    const rows = this.candlesByTimeframe[timeframe].get(key) ?? [];
    const evaluationTime = this.currentTime ?? new Date(0);
    const durationMs: Record<Exclude<BacktestTimeframe, "1m">, number> = {
      "5m": 5 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000,
      "12h": 12 * 60 * 60_000, "1d": 24 * 60 * 60_000, "1w": 7 * 24 * 60 * 60_000,
    };
    const currentConid = this.currentCandle?.symbol.toUpperCase() === key
      ? this.currentCandle.conid : undefined;
    const calendar = this.futuresCalendarBySymbol.get(key);
    return rows.filter((row) =>
      (calendar && (this.options.deriveAllFuturesTimeframesFrom1m ||
        timeframe === "1h" || timeframe === "4h" || timeframe === "1d")
        ? calendar.completedAt(row.ts, timeframe).getTime()
        : row.ts.getTime() + durationMs[timeframe]) <= evaluationTime.getTime() &&
      (!currentConid || row.conid === currentConid),
    ).slice(-limit);
  }

  async getInstrumentContract(
    symbol: string,
    conid?: string,
  ): Promise<InstrumentContract | null> {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return null;

    const candles = this.candles1mBySymbol.get(normalized) ?? [];
    const currentConid = this.currentCandle?.symbol.toUpperCase() === normalized
      ? this.currentCandle.conid
      : candles[this.currentIndexBySymbol.get(normalized) ?? -1]?.conid;
    const secTypeRaw =
      this.options.secTypeBySymbol[normalized]?.trim().toUpperCase() ?? "STK";
    const secType =
      secTypeRaw === "IND" || secTypeRaw === "CMDTY" || secTypeRaw === "FUT"
        ? secTypeRaw : "STK";
    const effectiveConid = String(conid ?? currentConid ?? normalized);
    const futuresMetadata = secType === "FUT"
      ? this.options.futuresContracts.get(effectiveConid) : undefined;
    const futuresSpec = futuresMetadata
      ? requireFuturesSpec(this.options.futuresSpecs, futuresMetadata.tradingClass) : undefined;

    return {
      symbol: normalized,
      conid: effectiveConid,
      secType,
      currency: futuresSpec?.currency ?? this.currencyForSymbol(normalized),
      localSymbol: futuresMetadata?.localSymbol,
      tradingClass: futuresMetadata?.tradingClass,
      minTick: futuresSpec?.tickSize,
      source: "override_fallback",
      resolvedAt: this.currentTime ?? new Date(),
    };
  }

  async getMarketState(conid: string): Promise<any> {
    const candle = this.currentCandle;
    if (!candle) return undefined;
    const halfSpread = this.options.syntheticSpreadBps / 2 / 10000;
    return {
      conid,
      symbol: candle.symbol,
      lastPrice: candle.close,
      bid: candle.close * (1 - halfSpread),
      ask: candle.close * (1 + halfSpread),
      spread: candle.close * halfSpread * 2,
      ts: candle.ts.toISOString(),
    };
  }

  async getExposureSnapshot(): Promise<any> {
    let exposure = 0;
    let longExposure = 0;
    let shortExposure = 0;
    const positionsBySymbol: Record<string, number> = {};
    const positionContextsBySymbol: Record<string, any> = {};

    for (const [symbol, position] of this.positions.entries()) {
      const price = this.latestPrice(symbol) ?? position.averageCost;
      const priceMultiplier = this.priceMultiplierForSymbol(symbol);
      const fxToBase =
        this.fxToBaseForSymbol(symbol, this.currentTime ?? new Date()) ??
        position.fxToBaseAtEntry;
      const marketValue =
        position.quantity * price * priceMultiplier * fxToBase;
      const gross = Math.abs(marketValue);
      exposure += gross;
      if (position.quantity > 0) longExposure += gross;
      if (position.quantity < 0) shortExposure += gross;
      positionsBySymbol[symbol] = position.quantity;
      positionContextsBySymbol[symbol] = {
        quantity: position.quantity,
        averageCost: position.averageCost,
        marketPrice: price,
        marketValue,
        unrealizedPnL:
          position.quantity > 0
            ? (price - position.averageCost) *
              Math.abs(position.quantity) *
              priceMultiplier *
              fxToBase
            : (position.averageCost - price) *
              Math.abs(position.quantity) *
              priceMultiplier *
              fxToBase,
      };
    }

    return {
      exposure,
      openPositions: this.positions.size,
      source: "db",
      positionsBySymbol,
      accountEquity: this.currentEquity,
      fxToBaseByCurrency: this.currentFxToBaseByCurrency(),
      longExposure,
      shortExposure,
      positionContextsBySymbol,
    };
  }

  async getLatestFilledOrderContext(symbol: string): Promise<any | null> {
    const position = this.positions.get(symbol.toUpperCase());
    if (!position) return null;
    return {
      instrument: position.symbol,
      side: position.side,
      quantity: Math.abs(position.quantity),
      entry: position.averageCost,
      stop: position.stop,
      takeProfit: position.takeProfit,
      executedAt: position.entryAt,
      createdAt: position.entryAt,
      strategy: position.strategy,
    };
  }

  async getOpenPositionBySymbol(
    symbol: string,
  ): Promise<{ strategyId: string; entryPrice: number | null } | null> {
    const position = this.positions.get(symbol.toUpperCase());
    if (!position) return null;
    return {
      strategyId: position.strategy,
      entryPrice: Number.isFinite(position.averageCost)
        ? position.averageCost
        : null,
    };
  }

  async insertProposedOrder(_order: ProposedOrder): Promise<number> {
    // Backtest persists accepted orders once in the main run loop after
    // SignalEngine returns them. Keep this adapter side-effect free so early
    // exit evaluation can reuse SignalEngine without duplicating backtest rows.
    return 0;
  }

  async syncStrategyRuntimeStates(strategyIds: string[]): Promise<void> {
    for (const strategyId of strategyIds) {
      if (!this.strategyStates.has(strategyId)) {
        this.strategyStates.set(strategyId, {
          strategyId,
          enabled: true,
          permanentlyDisabled: false,
          consecutiveLossCount: 0,
          cooldownCount: 0,
        });
      }
    }
  }

  async getStrategyRuntimeState(strategyId: string): Promise<StrategyState> {
    const state = this.strategyStates.get(strategyId) ?? {
      strategyId,
      enabled: true,
      permanentlyDisabled: false,
      consecutiveLossCount: 0,
      cooldownCount: 0,
    };

    if (state.cooldownUntil && this.currentTime) {
      const cooldownActiveInSimulatedTime =
        state.cooldownUntil.getTime() > this.currentTime.getTime();
      return {
        ...state,
        cooldownUntil: cooldownActiveInSimulatedTime
          ? new Date(Date.now() + 60_000)
          : undefined,
      };
    }

    return state;
  }

  async getSignalPerformance(input: {
    instrument?: string;
    strategy: string;
    side: Side;
    limit: number;
  }): Promise<any> {
    const rows = this.closedTrades
      .filter(
        (trade) =>
          trade.strategy === input.strategy &&
          trade.side === input.side &&
          (!input.instrument ||
            trade.instrument.toUpperCase() === input.instrument.toUpperCase()),
      )
      .slice(-input.limit);

    const wins = rows.filter((trade) => trade.pnl > 0).length;
    const losses = rows.filter((trade) => trade.pnl <= 0).length;
    const pnlPcts = rows.map((trade) => trade.pnlPct);
    return {
      trades: rows.length,
      wins,
      losses,
      winRate: rows.length > 0 ? wins / rows.length : 0,
      avgPnlPct: pnlPcts.length
        ? pnlPcts.reduce((sum, value) => sum + value, 0) / pnlPcts.length
        : undefined,
      medianPnlPct: this.median(pnlPcts),
      expectancyPct: pnlPcts.length
        ? pnlPcts.reduce((sum, value) => sum + value, 0) / pnlPcts.length
        : undefined,
    };
  }

  private async processPendingOrders(candle: Candle): Promise<void> {
    const symbol = candle.symbol.toUpperCase();
    const remaining: PendingOrder[] = [];

    for (const pending of this.pendingOrders) {
      if (pending.order.instrument.toUpperCase() !== symbol) {
        remaining.push(pending);
        continue;
      }

      if (candle.ts.getTime() <= pending.generatedAt.getTime()) {
        remaining.push(pending);
        continue;
      }

      if (this.isOrderTouchedForCandle(pending.order, candle)) {
        this.recordDiagnostic(pending.order, "filled", "entry_filled");
        await this.fillOrder(pending, candle);
        continue;
      }

      pending.remainingCandles -= 1;
      if (pending.remainingCandles <= 0) {
        this.recordDiagnostic(pending.order, "cancelled", "limit_not_filled");
        await this.repo.updateOrderStatus(
          pending.id,
          "CANCELLED",
          "backtest_limit_not_filled",
        );
      } else {
        remaining.push(pending);
      }
    }

    this.pendingOrders.length = 0;
    this.pendingOrders.push(...remaining);
  }

  private futuresSpecForConid(conid: string | undefined): FuturesContractSpec | undefined {
    if (!conid) return undefined;
    const metadata = this.options.futuresContracts.get(conid);
    return metadata ? requireFuturesSpec(this.options.futuresSpecs, metadata.tradingClass) : undefined;
  }

  private isOrderTouchedForCandle(order: ProposedOrder, candle: Candle): boolean {
    const spec = this.isFuturesSymbol(order.instrument)
      ? this.futuresSpecForConid(order.conid ?? candle.conid) : undefined;
    if (!spec || order.orderType === "MKT") return isOrderTouched(order, candle);
    if (!Number.isFinite(order.entry)) return false;
    const instruction = order.orderType === "STP" ? "stop" : "limit";
    const normalized = normalizeInstructionPrice(Number(order.entry), spec.tickSize, order.side as "BUY" | "SELL", instruction);
    return order.orderType === "STP"
      ? order.side === "BUY" ? candle.high >= normalized : candle.low <= normalized
      : order.side === "BUY" ? candle.low <= normalized : candle.high >= normalized;
  }

  private async fillOrder(
    pending: PendingOrder,
    candle: Candle,
  ): Promise<void> {
    const order = pending.order;
    const symbol = order.instrument.toUpperCase();
    const futuresSpec = this.isFuturesSymbol(symbol)
      ? this.futuresSpecForConid(order.conid ?? candle.conid) : undefined;
    if (futuresSpec) assertWholeContracts(order.quantity);
    const rawReference = futuresSpec && order.orderType === "MKT"
      ? candle.open
      : Number(order.entry ?? candle.open);
    const normalizedReference = futuresSpec && order.orderType !== "MKT"
      ? normalizeInstructionPrice(rawReference, futuresSpec.tickSize, order.side as "BUY" | "SELL", order.orderType === "STP" ? "stop" : "limit")
      : rawReference;
    const entryReferencePrice = futuresSpec && order.orderType === "STP"
      ? order.side === "BUY"
        ? Math.max(normalizedReference, candle.open)
        : Math.min(normalizedReference, candle.open)
      : normalizedReference;
    const fillPrice = futuresSpec && order.orderType !== "LMT"
      ? applyAdverseSlippage(entryReferencePrice, order.side as "BUY" | "SELL", futuresSpec)
      : entryReferencePrice;
    const existing = this.positions.get(symbol);

    if (order.positionEffect === "CLOSE_OR_REDUCE") {
      if (existing) {
        await this.closePosition(
          existing,
          fillPrice,
          candle.ts,
          "managed_exit",
          pending.id,
          entryReferencePrice,
          candle.conid,
        );
      }
      await this.repo.updateOrderStatus(
        pending.id,
        "FILLED",
        "backtest_entry_filled",
      );
      return;
    }

    const qty = signedQuantity(order.side, order.quantity);
    if (!existing || Math.sign(existing.quantity) === Math.sign(qty)) {
      if (futuresSpec && existing)
        throw new Error("Futures pyramiding is not supported by execution model pr15.5b-v1");
      const fxToBase = this.fxToBaseForSymbol(symbol, candle.ts);
      if (fxToBase === undefined)
        throw new Error(
          `Missing FX rate for ${symbol} at ${candle.ts.toISOString()}`,
        );
      const priceMultiplier = this.priceMultiplierForSymbol(symbol);
      const oldQtyAbs = existing ? Math.abs(existing.quantity) : 0;
      const newQtyAbs = Math.abs(qty);
      const totalQtyAbs = oldQtyAbs + newQtyAbs;
      const averageCost =
        totalQtyAbs > 0
          ? ((existing?.averageCost ?? 0) * oldQtyAbs + fillPrice * newQtyAbs) /
            totalQtyAbs
          : fillPrice;
      const oldLocalNotional = existing
        ? Math.abs(existing.averageCost * oldQtyAbs * existing.priceMultiplier)
        : 0;
      const newLocalNotional = Math.abs(
        fillPrice * newQtyAbs * priceMultiplier,
      );
      const fxToBaseAtEntry =
        oldLocalNotional + newLocalNotional > 0
          ? ((existing?.fxToBaseAtEntry ?? fxToBase) * oldLocalNotional +
              fxToBase * newLocalNotional) /
            (oldLocalNotional + newLocalNotional)
          : fxToBase;

      await this.repo.updateOrderStatus(
        pending.id,
        "FILLED",
        "backtest_entry_filled",
      );

      this.positions.set(symbol, {
        symbol: order.instrument,
        conid: order.conid,
        quantity: (existing?.quantity ?? 0) + qty,
        originalQuantityAbs: existing
          ? existing.originalQuantityAbs + Math.abs(qty)
          : Math.abs(qty),
        averageCost,
        stop: futuresSpec && order.stop !== undefined
          ? normalizeInstructionPrice(order.stop, futuresSpec.tickSize, order.side === "BUY" ? "SELL" : "BUY", "stop") : order.stop,
        initialStop: existing?.initialStop ?? (futuresSpec && order.stop !== undefined
          ? normalizeInstructionPrice(order.stop, futuresSpec.tickSize, order.side === "BUY" ? "SELL" : "BUY", "stop") : order.stop),
        takeProfit: futuresSpec && order.takeProfit !== undefined
          ? normalizeInstructionPrice(order.takeProfit, futuresSpec.tickSize, order.side === "BUY" ? "SELL" : "BUY", "limit") : order.takeProfit,
        pendingPartials:
          existing?.pendingPartials ?? this.buildPendingPartials(order, futuresSpec),
        trailingStopPct: existing?.trailingStopPct ?? order.trailingStopPct,
        trailingStopActivationR:
          existing?.trailingStopActivationR ?? order.trailingStopActivationR,
        trailActivated:
          existing?.trailActivated ??
          // No activation gate -> trail is armed from entry.
          (order.trailingStopActivationR === undefined ||
            !(order.trailingStopActivationR > 0)),
        peakPrice:
          existing?.peakPrice !== undefined
            ? Math.max(existing.peakPrice, fillPrice)
            : qty > 0
              ? fillPrice
              : undefined,
        troughPrice:
          existing?.troughPrice !== undefined
            ? Math.min(existing.troughPrice, fillPrice)
            : qty < 0
              ? fillPrice
              : undefined,
        entryAt: existing?.entryAt ?? candle.ts,
        orderId: pending.id,
        strategy: order.strategy ?? "n/a",
        runtimeKey: this.strategyRuntimeKey(
          order.strategy ?? "n/a",
          order.instrument,
          order.side,
        ),
        confidence: order.confidence,
        directionalRegime: order.indicators?.directionalRegime ?? "unknown",
        volatilityRegime: order.indicators?.volatilityRegime ?? "unknown",
        side: qty < 0 ? "SELL" : "BUY",
        priceMultiplier,
        fxToBaseAtEntry,
        entryReferencePrice,
        entrySlippage: Math.abs(fillPrice - entryReferencePrice),
        futuresSpec,
      });
      return;
    }

    await this.closePosition(
      existing,
      fillPrice,
      candle.ts,
      "opposite_signal",
      pending.id,
      entryReferencePrice,
      candle.conid,
    );
    await this.repo.updateOrderStatus(
      pending.id,
      "FILLED",
      "backtest_entry_filled",
    );
  }

  private async processBracketExit(candle: Candle): Promise<void> {
    const position = this.positions.get(candle.symbol.toUpperCase());
    if (!position) return;

    const isLong = position.quantity > 0;
    const stopTouchedAtOpen = position.stop !== undefined
      ? isLong ? candle.low <= position.stop : candle.high >= position.stop
      : false;
    if (stopTouchedAtOpen) {
      const exitSide = isLong ? "SELL" : "BUY";
      const exitReference = position.futuresSpec
        ? stopExitReference(exitSide, Number(position.stop), candle.open, position.futuresSpec.tickSize)
        : Number(position.stop);
      const exitFill = position.futuresSpec
        ? applyAdverseSlippage(exitReference, exitSide, position.futuresSpec)
        : exitReference;
      await this.closePosition(position, exitFill, candle.ts, "stop", position.orderId, exitReference, candle.conid);
      return;
    }

    // On an entry candle only an adverse protective stop is creditable from
    // OHLC. Favorable targets and stop ratchets wait for the next candle.
    if (position.entryAt.getTime() === candle.ts.getTime()) return;

    // Move stop to breakeven (entry) once price has travelled 1R in our favor.
    // Per-strategy opt-in: globally enabling BE hurt 3/4 strategies (run #9).
    // Only momentum_breakdown_short_v1 benefits (its TP target is far, BE protects).
    const breakevenStrategies = new Set(["momentum_breakdown_short_v1"]);
    if (
      breakevenStrategies.has(position.strategy) &&
      position.initialStop !== undefined &&
      position.stop === position.initialStop
    ) {
      const riskPerShare = isLong
        ? position.averageCost - position.initialStop
        : position.initialStop - position.averageCost;
      if (riskPerShare > 0) {
        const oneR = isLong
          ? position.averageCost + riskPerShare
          : position.averageCost - riskPerShare;
        const reachedOneR = isLong ? candle.high >= oneR : candle.low <= oneR;
        const touchedOriginalStop = isLong
          ? candle.low <= position.initialStop
          : candle.high >= position.initialStop;
        if (reachedOneR && !touchedOriginalStop) {
          position.stop = position.averageCost;
        }
      }
    }

    // Soft trailing: lock +1R profit once price reaches 3R in our favor.
    // Only momentum_breakout_long_v1 (TP=4R). Less aggressive than the failed
    // "lock 0.5R after 2R" experiment (run #12) — only kicks in for genuine winners
    // already deep in profit, leaving normal swings to TP=4R or full ATR stop.
    const lockPlus1RAfter3RStrategies = new Set(["momentum_breakout_long_v1"]);
    if (
      lockPlus1RAfter3RStrategies.has(position.strategy) &&
      position.initialStop !== undefined &&
      position.stop === position.initialStop
    ) {
      const riskPerShare = isLong
        ? position.averageCost - position.initialStop
        : position.initialStop - position.averageCost;
      if (riskPerShare > 0) {
        const threeR = isLong
          ? position.averageCost + riskPerShare * 3
          : position.averageCost - riskPerShare * 3;
        const oneR = isLong
          ? position.averageCost + riskPerShare
          : position.averageCost - riskPerShare;
        const reachedThreeR = isLong
          ? candle.high >= threeR
          : candle.low <= threeR;
        const touchedOriginalStop = isLong
          ? candle.low <= position.initialStop
          : candle.high >= position.initialStop;
        if (reachedThreeR && !touchedOriginalStop) {
          position.stop = oneR;
        }
      }
    }

    // Partial take-profits: scale out a fraction of the original size at each
    // intermediate level reached this candle. Executed BEFORE final stop/TP so
    // the runner can still hit the main target on the same bar. We assume each
    // touched level fills fully at its limit price (optimistic, in line with
    // the simulator's stop/TP semantics).
    if (position.pendingPartials && position.pendingPartials.length > 0) {
      for (const partial of position.pendingPartials) {
        if (partial.executed) continue;
        const reached = isLong
          ? candle.high >= partial.price
          : candle.low <= partial.price;
        if (!reached) continue;
        await this.closePartialPosition(position, partial, candle.ts);
        // If the partial close drained the position, stop processing.
        if (!this.positions.has(position.symbol.toUpperCase())) return;
      }
    }

    const takeProfitTouched =
      position.takeProfit !== undefined
        ? isLong
          ? candle.high >= position.takeProfit
          : candle.low <= position.takeProfit
        : false;

    if (takeProfitTouched) {
      await this.closePosition(
        position,
        Number(position.takeProfit),
        candle.ts,
        "take_profit",
        position.orderId,
      );
      return;
    }

    // Trailing-stop ratchet: position survived this candle, so update the
    // peak/trough and tighten the stop. Applied AFTER stop/TP checks so the
    // stop level used for the current candle is the one set at the end of
    // the previous candle (matches conservative tick-based simulation).
    if (
      position.trailingStopPct !== undefined &&
      position.trailingStopPct > 0
    ) {
      const pct = position.trailingStopPct / 100;
      if (isLong) {
        position.peakPrice = Math.max(
          position.peakPrice ?? candle.high,
          candle.high,
        );

        // Activation gate: trail stays disarmed until peak reaches
        // entry + activationR * (entry - initialStop). On activation, the
        // stop also jumps to break-even (entry) so we never give back to
        // the initial-loss zone.
        if (
          !position.trailActivated &&
          position.trailingStopActivationR !== undefined &&
          position.trailingStopActivationR > 0 &&
          position.initialStop !== undefined
        ) {
          const rPerShare = position.averageCost - position.initialStop;
          if (rPerShare > 0) {
            const activationLevel =
              position.averageCost +
              rPerShare * position.trailingStopActivationR;
            if (position.peakPrice >= activationLevel) {
              position.trailActivated = true;
              // Lock break-even at activation.
              position.stop = Math.max(
                position.stop ?? -Infinity,
                position.averageCost,
              );
            }
          }
        }

        if (position.trailActivated !== false) {
          const trailedStop = position.peakPrice * (1 - pct);
          const normalizedTrailedStop = position.futuresSpec
            ? normalizeInstructionPrice(
                trailedStop,
                position.futuresSpec.tickSize,
                "SELL",
                "stop",
              )
            : trailedStop;
          position.stop = Math.max(
            position.stop ?? -Infinity,
            normalizedTrailedStop,
          );
        }
      } else {
        position.troughPrice = Math.min(
          position.troughPrice ?? candle.low,
          candle.low,
        );

        if (
          !position.trailActivated &&
          position.trailingStopActivationR !== undefined &&
          position.trailingStopActivationR > 0 &&
          position.initialStop !== undefined
        ) {
          const rPerShare = position.initialStop - position.averageCost;
          if (rPerShare > 0) {
            const activationLevel =
              position.averageCost -
              rPerShare * position.trailingStopActivationR;
            if (position.troughPrice <= activationLevel) {
              position.trailActivated = true;
              position.stop = Math.min(
                position.stop ?? Infinity,
                position.averageCost,
              );
            }
          }
        }

        if (position.trailActivated !== false) {
          const trailedStop = position.troughPrice * (1 + pct);
          const normalizedTrailedStop = position.futuresSpec
            ? normalizeInstructionPrice(
                trailedStop,
                position.futuresSpec.tickSize,
                "BUY",
                "stop",
              )
            : trailedStop;
          position.stop = Math.min(
            position.stop ?? Infinity,
            normalizedTrailedStop,
          );
        }
      }
    }
  }

  private buildPendingPartials(
    order: ProposedOrder,
    futuresSpec?: FuturesContractSpec,
  ): PendingPartial[] | undefined {
    const levels = order.partialTakeProfits;
    if (!levels || levels.length === 0) return undefined;
    const isLong = order.side === "BUY";
    const sorted = [...levels].sort((a, b) =>
      isLong ? a.price - b.price : b.price - a.price,
    );
    return sorted.map((level) => ({
      fraction: level.fraction,
      price: futuresSpec
        ? normalizeInstructionPrice(level.price, futuresSpec.tickSize, order.side === "BUY" ? "SELL" : "BUY", "limit")
        : level.price,
      executed: false,
    }));
  }

  private async closePartialPosition(
    position: Position,
    partial: PendingPartial,
    exitAt: Date,
  ): Promise<void> {
    partial.executed = true;
    const partialQtyAbs = Math.floor(
      position.originalQuantityAbs * partial.fraction,
    );
    if (!(partialQtyAbs > 0)) return;
    const remainingAbs = Math.abs(position.quantity);
    const closeQtyAbs = Math.min(partialQtyAbs, remainingAbs);
    if (!(closeQtyAbs > 0)) return;

    const exitPrice = partial.price;
    const exitFxToBase = this.fxToBaseForSymbol(position.symbol, exitAt);
    if (exitFxToBase === undefined)
      throw new Error(
        `Missing FX rate for ${position.symbol} at ${exitAt.toISOString()}`,
      );
    const priceMultiplier = position.priceMultiplier;
    const entryNotional = Math.abs(
      position.averageCost *
        closeQtyAbs *
        priceMultiplier *
        position.fxToBaseAtEntry,
    );
    const exitNotional = Math.abs(
      exitPrice * closeQtyAbs * priceMultiplier * exitFxToBase,
    );
    const grossPnl =
      position.quantity > 0
        ? (exitPrice - position.averageCost) *
          closeQtyAbs *
          priceMultiplier *
          exitFxToBase
        : (position.averageCost - exitPrice) *
          closeQtyAbs *
          priceMultiplier *
          exitFxToBase;
    const futuresPnl = position.futuresSpec
      ? futuresRoundTripPnl({ direction: position.quantity > 0 ? 1 : -1,
          quantity: closeQtyAbs, entryFillPrice: position.averageCost,
          exitFillPrice: exitPrice, fxRate: exitFxToBase, spec: position.futuresSpec })
      : undefined;
    const effectiveGrossPnl = futuresPnl?.grossPnl ?? grossPnl;
    const commission = futuresPnl?.commission ??
      (this.commissionForSide(closeQtyAbs, entryNotional) +
      this.commissionForSide(closeQtyAbs, exitNotional));
    const netPnl = effectiveGrossPnl - commission;
    const pnlPct = entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0;

    await this.repo.insertFill({
      runId: this.runId,
      orderId: position.orderId,
      instrument: position.symbol,
      conid: position.conid,
      strategy: position.strategy,
      side: position.side,
      directionalRegime: position.directionalRegime,
      volatilityRegime: position.volatilityRegime,
      confidence: position.confidence,
      quantity: closeQtyAbs,
      entryPrice: position.averageCost,
      exitPrice,
      entryAt: position.entryAt,
      exitAt,
      grossPnl: effectiveGrossPnl,
      commission,
      netPnl,
      pnlPct,
      exitReason: "partial_take_profit",
      ...(position.futuresSpec ? this.futuresAudit(position, exitPrice, exitPrice, 0, closeQtyAbs, position.conid) : {}),
    });

    // Decrement position size (preserving direction sign).
    const direction = position.quantity > 0 ? 1 : -1;
    position.quantity = direction * (remainingAbs - closeQtyAbs);
    if (position.quantity === 0) {
      this.positions.delete(position.symbol.toUpperCase());
    }

    this.closedTrades.push({
      instrument: position.symbol,
      strategy: position.strategy,
      side: position.side,
      pnl: netPnl,
      pnlPct,
      exitedAt: exitAt,
    });
    this.currentEquity += netPnl;
    this.updateStrategyRuntime(
      position.runtimeKey,
      netPnl,
      exitAt,
      "partial_take_profit",
      pnlPct,
    );
  }

  private async closePosition(
    position: Position,
    exitPrice: number,
    exitAt: Date,
    exitReason: string,
    orderId: number,
    exitReferencePrice = exitPrice,
    exitConid = position.conid,
  ): Promise<void> {
    const quantityAbs = Math.abs(position.quantity);
    if (!(quantityAbs > 0)) return;

    const exitFxToBase = this.fxToBaseForSymbol(position.symbol, exitAt);
    if (exitFxToBase === undefined)
      throw new Error(
        `Missing FX rate for ${position.symbol} at ${exitAt.toISOString()}`,
      );
    const priceMultiplier = position.priceMultiplier;
    const entryNotional = Math.abs(
      position.averageCost *
        quantityAbs *
        priceMultiplier *
        position.fxToBaseAtEntry,
    );
    const exitNotional = Math.abs(
      exitPrice * quantityAbs * priceMultiplier * exitFxToBase,
    );
    const grossPnl =
      position.quantity > 0
        ? (exitPrice - position.averageCost) *
          quantityAbs *
          priceMultiplier *
          exitFxToBase
        : (position.averageCost - exitPrice) *
          quantityAbs *
          priceMultiplier *
          exitFxToBase;
    const futuresPnl = position.futuresSpec
      ? futuresRoundTripPnl({ direction: position.quantity > 0 ? 1 : -1,
          quantity: quantityAbs, entryFillPrice: position.averageCost,
          exitFillPrice: exitPrice, fxRate: exitFxToBase, spec: position.futuresSpec })
      : undefined;
    const effectiveGrossPnl = futuresPnl?.grossPnl ?? grossPnl;
    const commission = futuresPnl?.commission ??
      (this.commissionForSide(quantityAbs, entryNotional) +
      this.commissionForSide(quantityAbs, exitNotional));
    const netPnl = effectiveGrossPnl - commission;
    const pnlPct = entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0;

    await this.repo.insertFill({
      runId: this.runId,
      orderId,
      instrument: position.symbol,
      conid: position.conid,
      strategy: position.strategy,
      side: position.side,
      directionalRegime: position.directionalRegime,
      volatilityRegime: position.volatilityRegime,
      confidence: position.confidence,
      quantity: quantityAbs,
      entryPrice: position.averageCost,
      exitPrice,
      entryAt: position.entryAt,
      exitAt,
      grossPnl: effectiveGrossPnl,
      commission,
      netPnl,
      pnlPct,
      exitReason,
      ...(position.futuresSpec ? this.futuresAudit(
        position, exitReferencePrice, exitPrice,
        Math.abs(exitPrice - exitReferencePrice), quantityAbs, exitConid,
      ) : {}),
    });

    this.positions.delete(position.symbol.toUpperCase());
    this.closedTrades.push({
      instrument: position.symbol,
      strategy: position.strategy,
      side: position.side,
      pnl: netPnl,
      pnlPct,
      exitedAt: exitAt,
    });
    this.currentEquity += netPnl;
    this.updateStrategyRuntime(
      position.runtimeKey,
      netPnl,
      exitAt,
      exitReason,
      pnlPct,
    );
  }

  private futuresAudit(
    position: Position,
    exitReferencePrice: number,
    exitFillPrice: number,
    exitSlippage: number,
    quantity: number,
    exitConid: string | undefined,
  ): Partial<BacktestFillRecord> {
    const spec = position.futuresSpec!;
    const slippageCost = (position.entrySlippage + exitSlippage) * quantity *
      spec.multiplier * position.fxToBaseAtEntry;
    return {
      entryReferencePrice: position.entryReferencePrice,
      entryFillPrice: position.averageCost,
      exitReferencePrice,
      exitFillPrice,
      multiplier: spec.multiplier,
      tickSize: spec.tickSize,
      entrySlippage: position.entrySlippage,
      exitSlippage,
      slippageCost,
      commissionPerContractSide: spec.commissionPerContractPerSide,
      entryConid: position.conid,
      exitConid,
      executionModelVersion: FUTURES_EXECUTION_MODEL_VERSION,
      calendarVersion: spec.calendarVersion,
    };
  }

  private async closeOpenPositionsAtDatasetEnd(): Promise<void> {
    for (const position of Array.from(this.positions.values())) {
      const price =
        this.latestPrice(position.symbol.toUpperCase()) ?? position.averageCost;
      const lastTs =
        this.latestCandleTs(position.symbol.toUpperCase()) ??
        this.currentTime ??
        new Date();
      const metadata = position.conid ? this.options.futuresContracts.get(position.conid) : undefined;
      const reason = metadata && this.data.dataset.dateTo
        && new Date(this.data.dataset.dateTo).getTime() >= metadata.lastTradeAt.getTime()
        ? "expiry" : "dataset_end";
      const exitSide = position.quantity > 0 ? "SELL" : "BUY";
      const exitPrice = position.futuresSpec
        ? applyAdverseSlippage(price, exitSide, position.futuresSpec) : price;
      await this.closePosition(
        position,
        exitPrice,
        lastTs,
        reason,
        position.orderId,
        price,
        position.conid,
      );
    }
  }

  private hasPendingOrderForSymbol(symbol: string): boolean {
    const key = symbol.toUpperCase();
    return this.pendingOrders.some(
      (pending) => pending.order.instrument.toUpperCase() === key,
    );
  }

  private updateStrategyRuntime(
    strategyId: string,
    netPnl: number,
    exitedAt: Date,
    exitReason: string,
    pnlPct: number,
  ): void {
    let state = this.strategyStates.get(strategyId);
    if (!state) {
      state = {
        strategyId,
        enabled: true,
        permanentlyDisabled: false,
        consecutiveLossCount: 0,
        cooldownCount: 0,
      };
      this.strategyStates.set(strategyId, state);
    }

    const flatCostExit = exitReason === "managed_exit" && pnlPct > -0.16;
    if (netPnl > 0 || flatCostExit) {
      state.consecutiveLossCount = 0;
      if (!state.permanentlyDisabled) {
        state.reason = flatCostExit
          ? "Backtest flat managed exit reset loss streak"
          : "Backtest win reset loss streak";
      }
      return;
    }

    state.consecutiveLossCount += 1;
    if (state.consecutiveLossCount < 3) {
      state.reason = `Backtest loss streak ${state.consecutiveLossCount}/3`;
      return;
    }

    if (state.cooldownCount >= 1) {
      state.enabled = false;
      state.permanentlyDisabled = true;
      state.cooldownUntil = undefined;
      state.reason = "Backtest disabled after second 3-loss streak";
    } else {
      state.cooldownCount += 1;
      state.cooldownUntil = new Date(
        exitedAt.getTime() + this.options.strategyCooldownMs,
      );
      state.reason = "Backtest cooldown after 3-loss streak";
    }
    state.consecutiveLossCount = 0;
  }

  private strategyRuntimeKey(
    strategyId: string,
    symbol: string,
    side: Side,
  ): string {
    return `${strategyId}|${symbol.toUpperCase()}|${side}`;
  }

  private async persistStrategyStates(): Promise<void> {
    const states = Array.from(this.strategyStates.values());

    await this.repo.upsertStrategyStates(
      this.runId,
      states.map((state) => ({
        strategyId: state.strategyId,
        enabled: state.enabled,
        permanentlyDisabled: state.permanentlyDisabled,
        cooldownUntil: state.cooldownUntil,
        reason: state.reason,
      })),
    );
  }

  private recordDiagnostic(
    order: ProposedOrder,
    stage: string,
    reasonGroup: string,
  ): void {
    const strategy =
      order.strategy ?? order.indicators?.strategyProfile ?? "n/a";
    const instrument = (order.instrument || "n/a").toUpperCase();
    const side = order.side ?? "HOLD";
    const key = `${strategy}|${instrument}|${side}|${stage}|${reasonGroup}`;
    const existing = this.diagnostics.get(key);
    if (existing) {
      existing.samples += 1;
      return;
    }

    this.diagnostics.set(key, {
      runId: this.runId,
      strategy,
      instrument,
      side,
      stage,
      reasonGroup,
      samples: 1,
    });
  }

  private classifyRejection(reason: string): string {
    const normalized = reason.toLowerCase();
    if (normalized.includes("insufficient candles"))
      return "insufficient_candles";
    if (normalized.includes("indicator values")) return "indicator_unavailable";
    if (
      normalized.includes("no active profile") ||
      normalized.includes("regime_not_trend") ||
      normalized.includes("regime_not_bull_trend") ||
      normalized.includes("directional_regime_not_") ||
      normalized.includes("volatility_regime_") ||
      normalized.includes("asset_class_not_stock") ||
      normalized.includes("asset_class_not_supported")
    )
      return "regime_or_profile_mismatch";
    if (normalized.includes("no edge")) return "no_edge";
    if (normalized.includes("spread filter")) return "spread";
    if (
      normalized.includes("liquidity filter") ||
      normalized.includes("low 1m volume")
    )
      return "volume";
    if (
      normalized.includes("volume_not_confirmed") ||
      normalized.includes("volume_baseline_unavailable")
    )
      return "volume";
    if (
      normalized.includes("higher_timeframe") ||
      normalized.includes("daily_momentum_not_positive") ||
      normalized.includes("daily_momentum_too_weak") ||
      normalized.includes("hourly_momentum_too_weak") ||
      normalized.includes("intraday_momentum_too_weak")
    )
      return "higher_timeframe";
    if (
      normalized.includes("no_confirmed_breakout") ||
      normalized.includes("no_donchian_breakout") ||
      normalized.includes("prior_high_unavailable") ||
      normalized.includes("breakout_candle") ||
      normalized.includes("breakout_close") ||
      normalized.includes("breakout_body") ||
      normalized.includes("breakout_upper_wick")
    )
      return "breakout";
    if (
      normalized.includes("overextended") ||
      normalized.includes("rsi_overheated")
    )
      return "overextended";
    if (normalized.includes("volatility_not_compressed")) return "compression";
    if (normalized.includes("planned_reward_too_small"))
      return "reward_to_cost";
    if (normalized.includes("entry quality")) return "entry_quality";
    if (normalized.includes("confidence too low")) return "confidence";
    if (normalized.includes("sizing rejected")) return "sizing";
    if (
      normalized.includes("risk overlay") ||
      normalized.includes("risk check failed")
    )
      return "risk";
    if (normalized.includes("symbol add blocked")) return "symbol_loss_limit";
    if (normalized.includes("fx rejected")) return "fx";
    if (
      normalized.includes("stale market state") ||
      normalized.includes("no market state")
    )
      return "market_state";
    return "other";
  }

  private rejectionDetail(reason: string): string {
    const withoutStrategyPrefix = reason.replace(/^[A-Za-z0-9_]+:\s*/, "");
    const withoutDynamicNumbers = withoutStrategyPrefix
      .replace(/\([^)]*\)/g, "")
      .replace(/\b\d+(?:\.\d+)?(?:ms|bps)?\b/g, "#")
      .replace(/\s+/g, " ")
      .trim();

    const firstSentence =
      withoutDynamicNumbers.split(/[.;]/, 1)[0]?.trim() ?? "";
    if (!firstSentence) return "unknown";

    return firstSentence
      .toLowerCase()
      .replace(/[^a-z0-9_ -]+/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 120);
  }

  private async persistDiagnostics(): Promise<void> {
    await this.repo.upsertSignalDiagnostics(
      Array.from(this.diagnostics.values()),
    );
  }

  private latestPrice(symbol: string): number | undefined {
    const rows = this.candles1mBySymbol.get(symbol.toUpperCase()) ?? [];
    const currentIndex = this.currentIndexBySymbol.get(symbol.toUpperCase());
    if (currentIndex !== undefined && rows[currentIndex])
      return rows[currentIndex].close;
    return rows[rows.length - 1]?.close;
  }

  private latestCandleTs(symbol: string): Date | undefined {
    const rows = this.candles1mBySymbol.get(symbol.toUpperCase()) ?? [];
    return rows[rows.length - 1]?.ts;
  }

  private priceMultiplierForSymbol(symbol: string): number {
    const multiplier =
      this.options.priceMultiplierBySymbol[symbol.toUpperCase()];
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  }

  /**
   * Estimate broker commission for a single side of a trade.
   * Mirrors the IBKR Tiered model:
   *   per_side = max(min_per_side, shares * per_share + notional * passthrough_bps / 10000)
   * Falls back to a flat bps-of-notional model when commissionPerShare = 0
   * (legacy behaviour).
   */
  private commissionForSide(shares: number, notional: number): number {
    const sharesAbs = Math.abs(shares);
    const notionalAbs = Math.abs(notional);
    if (this.options.commissionPerShare > 0) {
      const variable =
        sharesAbs * this.options.commissionPerShare +
        (notionalAbs * this.options.commissionPassthroughBps) / 10000;
      return Math.max(this.options.commissionMinPerSide, variable);
    }
    return (notionalAbs * this.options.commissionBps) / 10000;
  }

  private currencyForSymbol(symbol: string): string {
    return (
      this.options.currencyBySymbol[symbol.toUpperCase()] ??
      this.options.baseCurrency
    )
      .trim()
      .toUpperCase();
  }

  private currentFxToBaseByCurrency(): Record<string, number> {
    const out: Record<string, number> = {
      [this.options.baseCurrency.trim().toUpperCase()]: 1,
    };
    const at = this.currentTime ?? new Date();
    for (const currency of new Set(
      Object.values(this.options.currencyBySymbol).map((value) =>
        value.trim().toUpperCase(),
      ),
    )) {
      const rate = this.fxToBaseForCurrency(currency, at);
      if (rate !== undefined) out[currency] = rate;
    }
    return out;
  }

  private fxToBaseForSymbol(symbol: string, at: Date): number | undefined {
    return this.fxToBaseForCurrency(this.currencyForSymbol(symbol), at);
  }

  private fxToBaseForCurrency(currency: string, at: Date): number | undefined {
    const normalizedCurrency = currency.trim().toUpperCase();
    const baseCurrency = this.options.baseCurrency.trim().toUpperCase();
    if (!normalizedCurrency || normalizedCurrency === baseCurrency) return 1;

    const targetDate = at.toISOString().slice(0, 10);
    let best: { date: string; rateToBase: number } | undefined;
    for (const rate of this.data.fxRates) {
      if (
        rate.baseCurrency !== baseCurrency ||
        rate.quoteCurrency !== normalizedCurrency
      )
        continue;
      if (rate.date > targetDate) continue;
      if (!best || rate.date > best.date) best = rate;
    }

    return best?.rateToBase;
  }

  private median(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }
}

export async function runIsolatedStrategyBacktest(
  repo: BacktestRepository,
  runId: number,
  data: LoadedBacktestData,
  options: SimulatorOptions,
  onProgress?: (line: string) => void,
): Promise<{
  totalPnl: number;
  trades: number;
  wins: number;
  winRate: number;
}> {
  let totalPnl = 0;
  let trades = 0;
  let wins = 0;
  const profiles = listAllStrategyProfiles();
  const eventsPerStrategy = data.candleCount1m;
  const totalEvents = profiles.length * eventsPerStrategy;

  for (
    let profileIndex = 0;
    profileIndex < profiles.length;
    profileIndex += 1
  ) {
    const profile = profiles[profileIndex];
    const label = `${profileIndex + 1}/${profiles.length} ${profile.id}`;
    onProgress?.(`isolated strategy ${profile.id} started`);
    await repo.updateRunProgress(runId, {
      current: profileIndex * eventsPerStrategy,
      total: totalEvents,
      label: `initializing ${label}`,
    });
    const simulator = new BacktestSimulator(repo, runId, data, {
      ...options,
    });
    const metrics = await simulator.run({
      baseCurrent: profileIndex * eventsPerStrategy,
      total: totalEvents,
      label,
      onProgress: (progress) => repo.updateRunProgress(runId, progress),
    });
    totalPnl += metrics.totalPnl;
    trades += metrics.trades;
    wins += metrics.wins;
    await repo.updateRunProgress(runId, {
      current: (profileIndex + 1) * eventsPerStrategy,
      total: totalEvents,
      label: `completed ${profile.id}`,
    });
    onProgress?.(
      `isolated strategy ${profile.id} completed trades=${metrics.trades} pnl=${metrics.totalPnl.toFixed(2)}`,
    );
  }

  return {
    totalPnl,
    trades,
    wins,
    winRate: trades > 0 ? wins / trades : 0,
  };
}

export async function runParallelIsolatedStrategyBacktest(
  repo: BacktestRepository,
  runId: number,
  postgresUrl: string,
  options: SimulatorOptions,
  concurrency: number,
  onProgress?: (line: string) => void,
): Promise<{
  totalPnl: number;
  trades: number;
  wins: number;
  winRate: number;
}> {
  const profiles = listAllStrategyProfiles();
  const summaries = await repo.listCandleSymbolSummaries();
  const candleCountBySymbol = new Map(
    summaries.map((summary) => [summary.symbol.toUpperCase(), summary.candles]),
  );
  const symbolsBySecType = new Map<string, string[]>();

  for (const summary of summaries) {
    const symbol = summary.symbol.toUpperCase();
    const secType = options.secTypeBySymbol[symbol] ?? "STK";
    symbolsBySecType.set(secType, [
      ...(symbolsBySecType.get(secType) ?? []),
      symbol,
    ]);
  }

  const workItems: StrategyWorkItem[] = profiles
    .map((profile, profileIndex) => {
      const symbols = Array.from(
        new Set(
          profile.secType.flatMap(
            (secType) => symbolsBySecType.get(secType) ?? [],
          ),
        ),
      );
      const eventCount = symbols.reduce(
        (sum, symbol) => sum + (candleCountBySymbol.get(symbol) ?? 0),
        0,
      );
      return { profile, profileIndex, symbols, eventCount };
    })
    .filter((item) => item.eventCount > 0);

  const totalEvents = workItems.reduce((sum, item) => sum + item.eventCount, 0);
  const workerCount = Math.max(
    1,
    Math.min(Math.floor(concurrency), workItems.length),
  );
  const progressByStrategy = new Map<string, number>(
    workItems.map((item) => [item.profile.id, 0]),
  );
  const activeStrategies = new Set<string>();

  let nextProfileIndex = 0;
  let totalPnl = 0;
  let trades = 0;
  let wins = 0;

  const label = () => {
    const active = Array.from(activeStrategies);
    return active.length > 0
      ? `active: ${active.join(", ")}`
      : "starting strategy lab";
  };

  const publishProgress = async (): Promise<void> => {
    const current = Array.from(progressByStrategy.values()).reduce(
      (sum, value) => sum + value,
      0,
    );
    await repo.updateRunProgress(runId, {
      current,
      total: totalEvents,
      label: label(),
    });
  };

  const runProfile = (
    item: StrategyWorkItem,
  ): Promise<{
    totalPnl: number;
    trades: number;
    wins: number;
    winRate: number;
  }> => {
    return new Promise((resolve, reject) => {
      const profile = item.profile;
      const worker = new Worker(
        new URL("./strategy-lab-worker.js", import.meta.url),
        {
          workerData: {
            postgresUrl,
            runId,
            strategyId: profile.id,
            strategyIndex: item.profileIndex,
            strategyTotal: profiles.length,
            symbols: item.symbols,
            options,
          },
          // Cap each worker's V8 heap so one runaway worker can't
          // SIGKILL the whole container (each holds its own copy of
          // the candle dataset).
          resourceLimits: {
            maxOldGenerationSizeMb: 6144,
          },
        },
      );

      let metrics:
        | { totalPnl: number; trades: number; wins: number; winRate: number }
        | undefined;

      worker.on("message", (message: StrategyWorkerMessage) => {
        if (message.type === "progress") {
          progressByStrategy.set(
            profile.id,
            Math.max(0, Math.min(item.eventCount, message.current ?? 0)),
          );
          void publishProgress();
          return;
        }

        if (message.type === "completed" && message.metrics) {
          metrics = message.metrics;
          progressByStrategy.set(profile.id, item.eventCount);
          void publishProgress();
        }
      });

      worker.on("error", reject);
      worker.on("exit", (code) => {
        activeStrategies.delete(profile.id);
        if (code !== 0) {
          reject(
            new Error(`Strategy worker ${profile.id} exited with code ${code}`),
          );
          return;
        }
        if (!metrics) {
          reject(
            new Error(`Strategy worker ${profile.id} exited without metrics`),
          );
          return;
        }
        resolve(metrics);
      });
    });
  };

  const workerLoop = async (slot: number): Promise<void> => {
    while (nextProfileIndex < workItems.length) {
      const itemIndex = nextProfileIndex;
      nextProfileIndex += 1;
      const item = workItems[itemIndex];
      const profile = item.profile;
      activeStrategies.add(profile.id);
      onProgress?.(
        `isolated strategy ${profile.id} started slot=${slot + 1}/${workerCount} symbols=${item.symbols.length} events=${item.eventCount}`,
      );
      await publishProgress();

      const metrics = await runProfile(item);
      totalPnl += metrics.totalPnl;
      trades += metrics.trades;
      wins += metrics.wins;
      onProgress?.(
        `isolated strategy ${profile.id} completed trades=${metrics.trades} pnl=${metrics.totalPnl.toFixed(2)}`,
      );
    }
  };

  await repo.updateRunProgress(runId, {
    current: 0,
    total: totalEvents,
    label: `starting ${workerCount} workers with symbol-filtered datasets`,
  });

  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => workerLoop(index)),
  );
  await repo.updateRunProgress(runId, {
    current: totalEvents,
    total: totalEvents,
    label: "completed",
  });

  return {
    totalPnl,
    trades,
    wins,
    winRate: trades > 0 ? wins / trades : 0,
  };
}
