import { Worker } from "node:worker_threads";
import { SignalEngine } from "@ikbr/signal-engine/signal-engine";
import { createStrategies } from "@ikbr/signal-engine/strategies/strategy-registry";
import type { Candle, InstrumentContract, ProposedOrder, Side } from "@ikbr/shared";
import {
  listAllStrategyProfiles,
  listStrategyProfiles,
  type StrategyProfile,
} from "@ikbr/shared";
import type { BacktestRepository } from "./repository.js";
import type {
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
  syntheticSpreadBps: number;
  orderTtlCandles: number;
  strategyIds?: string[];
  riskLimits: {
    accountEquity: number;
    maxRiskPerTradePct: number;
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

interface Position {
  symbol: string;
  conid?: string;
  quantity: number;
  averageCost: number;
  stop?: number;
  takeProfit?: number;
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function groupCandles(candles: Candle[]): Map<string, Candle[]> {
  const out = new Map<string, Candle[]>();
  for (const candle of candles) {
    const key = candle.symbol.toUpperCase();
    const rows = out.get(key);
    if (rows) {
      rows.push(candle);
    } else {
      out.set(key, [candle]);
    }
  }
  for (const [key, rows] of out.entries()) {
    out.set(
      key,
      rows.sort((a, b) => a.ts.getTime() - b.ts.getTime()),
    );
  }
  return out;
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

function binarySearchLastAtOrBefore(candles: Candle[], ts: Date): number {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  const target = ts.getTime();
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].ts.getTime() <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export class BacktestSimulator {
  private readonly candles1mBySymbol: Map<string, Candle[]>;
  private readonly candles1hBySymbol: Map<string, Candle[]>;
  private readonly candlesByTimeframe: Record<
    "1m" | "5m" | "1h" | "4h" | "12h" | "1d" | "1w",
    Map<string, Candle[]>
  >;
  private readonly currentIndexBySymbol = new Map<string, number>();
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
  private currentEquity: number;

  constructor(
    private readonly repo: BacktestRepository,
    private readonly runId: number,
    private readonly data: LoadedBacktestData,
    private readonly options: SimulatorOptions,
  ) {
    this.candles1mBySymbol = groupCandles(data.candles1m);
    this.candles1hBySymbol = groupCandles(data.candles1h);
    this.candlesByTimeframe = {
      "1m": this.candles1mBySymbol,
      "5m": groupCandles(data.candles5m),
      "1h": this.candles1hBySymbol,
      "4h": groupCandles(data.candles4h),
      "12h": groupCandles(data.candles12h),
      "1d": groupCandles(data.candles1d),
      "1w": groupCandles(data.candles1w),
    };
    this.currentEquity = options.riskLimits.accountEquity;
    const activeStrategyIds = new Set(
      options.strategyIds ?? listStrategyProfiles().map((profile) => profile.id),
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
  }

  async run(
    progress?: RunProgressOptions,
  ): Promise<{
    totalPnl: number;
    trades: number;
    wins: number;
    winRate: number;
  }> {
    const signalEngine = new SignalEngine(
      this as any,
      {
        strategies: createStrategies(this.options.strategyIds),
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
      },
    );

    const events = this.data.candles1m
      .map((candle) => ({ candle, key: candle.symbol.toUpperCase() }))
      .sort(
        (a, b) =>
          a.candle.ts.getTime() - b.candle.ts.getTime() ||
          a.key.localeCompare(b.key),
      );
    const cursorBySymbol = new Map<string, number>();
    const progressBase = progress?.baseCurrent ?? 0;
    const progressTotal = progress?.total ?? events.length;
    const progressLabel = progress?.label ?? "running backtest";
    await progress?.onProgress?.({
      current: progressBase,
      total: progressTotal,
      label: progressLabel,
    });

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      if (eventIndex > 0 && eventIndex % YIELD_EVERY_EVENTS === 0) {
        await yieldToEventLoop();
      }
      if (eventIndex > 0 && eventIndex % PROGRESS_EVERY_EVENTS === 0) {
        await progress?.onProgress?.({
          current: progressBase + eventIndex,
          total: progressTotal,
          label: progressLabel,
        });
      }

      const event = events[eventIndex];
      const index = (cursorBySymbol.get(event.key) ?? -1) + 1;
      cursorBySymbol.set(event.key, index);

      this.currentCandle = event.candle;
      this.currentTime = event.candle.ts;
      this.currentIndexBySymbol.set(event.key, index);

      await this.processPendingOrders(event.candle);
      await this.processBracketExit(event.candle);

      if (this.hasPendingOrderForSymbol(event.candle.symbol)) {
        continue;
      }

      const order = await signalEngine.runForSymbol(
        event.candle.symbol,
        await this.getExposureSnapshot(),
        event.candle.ts,
      );
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
        continue;
      }
      this.recordDiagnostic(order, "proposed", "pass");

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
        generatedFromCandleTs: event.candle.ts,
        createdAt: event.candle.ts,
      });
      this.pendingOrders.push({
        id: orderId,
        order,
        generatedAt: event.candle.ts,
        remainingCandles: this.options.orderTtlCandles,
      });
    }

    await progress?.onProgress?.({
      current: progressBase + events.length,
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

  async getRecentCandles(
    symbol: string,
    timeframe: Candle["timeframe"],
    limit: number,
  ): Promise<Candle[]> {
    const key = symbol.toUpperCase();
    if (timeframe === "1m") {
      const rows = this.candles1mBySymbol.get(key) ?? [];
      const index = this.currentIndexBySymbol.get(key) ?? -1;
      if (index < 0) return [];
      return rows.slice(Math.max(0, index - limit + 1), index + 1);
    }

    const rows = this.candlesByTimeframe[timeframe].get(key) ?? [];
    const index = binarySearchLastAtOrBefore(
      rows,
      this.currentTime ?? new Date(0),
    );
    if (index < 0) return [];
    return rows.slice(Math.max(0, index - limit + 1), index + 1);
  }

  async getInstrumentContract(
    symbol: string,
    conid?: string,
  ): Promise<InstrumentContract | null> {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return null;

    const candles = this.candles1mBySymbol.get(normalized) ?? [];
    const latestConid = candles[candles.length - 1]?.conid;
    const secTypeRaw =
      this.options.secTypeBySymbol[normalized]?.trim().toUpperCase() ?? "STK";
    const secType =
      secTypeRaw === "IND" || secTypeRaw === "CMDTY" ? secTypeRaw : "STK";

    return {
      symbol: normalized,
      conid: String(conid ?? latestConid ?? normalized),
      secType,
      currency: this.currencyForSymbol(normalized),
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

      if (isOrderTouched(pending.order, candle)) {
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

  private async fillOrder(
    pending: PendingOrder,
    candle: Candle,
  ): Promise<void> {
    const order = pending.order;
    const symbol = order.instrument.toUpperCase();
    const fillPrice = Number(order.entry ?? candle.open);
    const existing = this.positions.get(symbol);

    await this.repo.updateOrderStatus(
      pending.id,
      "FILLED",
      "backtest_entry_filled",
    );

    if (order.positionEffect === "CLOSE_OR_REDUCE") {
      if (existing) {
        await this.closePosition(
          existing,
          fillPrice,
          candle.ts,
          "managed_exit",
          pending.id,
        );
      }
      return;
    }

    const qty = signedQuantity(order.side, order.quantity);
    if (!existing || Math.sign(existing.quantity) === Math.sign(qty)) {
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

      this.positions.set(symbol, {
        symbol: order.instrument,
        conid: order.conid,
        quantity: (existing?.quantity ?? 0) + qty,
        averageCost,
        stop: order.stop,
        takeProfit: order.takeProfit,
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
      });
      return;
    }

    await this.closePosition(
      existing,
      fillPrice,
      candle.ts,
      "opposite_signal",
      pending.id,
    );
  }

  private async processBracketExit(candle: Candle): Promise<void> {
    const position = this.positions.get(candle.symbol.toUpperCase());
    if (!position || position.entryAt.getTime() >= candle.ts.getTime()) return;

    const isLong = position.quantity > 0;
    const stopTouched =
      position.stop !== undefined
        ? isLong
          ? candle.low <= position.stop
          : candle.high >= position.stop
        : false;
    const takeProfitTouched =
      position.takeProfit !== undefined
        ? isLong
          ? candle.high >= position.takeProfit
          : candle.low <= position.takeProfit
        : false;

    if (stopTouched) {
      await this.closePosition(
        position,
        Number(position.stop),
        candle.ts,
        "stop",
        position.orderId,
      );
      return;
    }

    if (takeProfitTouched) {
      await this.closePosition(
        position,
        Number(position.takeProfit),
        candle.ts,
        "take_profit",
        position.orderId,
      );
    }
  }

  private async closePosition(
    position: Position,
    exitPrice: number,
    exitAt: Date,
    exitReason: string,
    orderId: number,
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
    const commission =
      ((entryNotional + exitNotional) * this.options.commissionBps) / 10000;
    const netPnl = grossPnl - commission;
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
      grossPnl,
      commission,
      netPnl,
      pnlPct,
      exitReason,
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

  private async closeOpenPositionsAtDatasetEnd(): Promise<void> {
    for (const position of Array.from(this.positions.values())) {
      const price =
        this.latestPrice(position.symbol.toUpperCase()) ?? position.averageCost;
      const lastTs =
        this.latestCandleTs(position.symbol.toUpperCase()) ??
        this.currentTime ??
        new Date();
      await this.closePosition(
        position,
        price,
        lastTs,
        "dataset_end",
        position.orderId,
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
  const eventsPerStrategy = data.candles1m.length;
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
