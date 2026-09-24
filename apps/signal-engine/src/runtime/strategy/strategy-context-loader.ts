/**
 * PR15.4 — Strategy context loader.
 *
 * Owns the "given a bound instrument, build a `StrategyContext`
 * so `StrategyPortfolioManager.run()` can evaluate strategies"
 * responsibility. Fail-closed:
 *
 *   - `STRATEGY_CONTRACT_MISMATCH` — the persisted contract for
 *     the bound `conId` disagrees with the operator-supplied
 *     `BoundInstrument` on any required field.
 *   - `STRATEGY_CONTEXT_UNAVAILABLE` — candles / market state
 *     are missing, stale, or insufficient to compute indicators.
 *
 * All contract fields are compared trim + upper-case; a missing
 * or null required DB field is `STRATEGY_CONTRACT_MISMATCH`, not
 * `STRATEGY_CONTEXT_UNAVAILABLE`.
 */

import type {
  BoundInstrument,
  Candle,
  CandleTimeframe,
  Instrument,
  InstrumentContract,
  SecType,
} from "@ikbr/shared";
import { isWseBound, validClosedWseCandle, wseCandleEnd, mapAssetClassToIbkrSecType } from "@ikbr/shared";

import type { StrategyContext } from "../../strategies/strategy.types.js";

import {
  computeIndicatorsForContext,
  type ComputeIndicatorsInput,
} from "./indicators.js";
import { detectRegimeForContext } from "./regime.js";

/**
 * PR15.4 §6.3 — effective minimum candle counts per timeframe.
 *
 * Effective minimum = max(snapshot minimum, indicator periods
 * required by the regime detector and any active strategy).
 *
 * - `1m` needs 220 bars for EMA200 and the intraday overnight-session
 *   scan (`SIGNAL_MIN_CANDLES`).
 * - Every higher timeframe is consumed by `MarketRegimeDetector.scoreTimeframe`,
 *   which reads `ema50` (close vs. EMA50, and EMA20 vs. EMA50). EMA50
 *   requires 50 bars of that timeframe's data — anything lower yields an
 *   undefined value and would let the loader accept an incomplete
 *   context. The smallcap donchian strategies further require EMA50 on
 *   `4h` for their trend filter. Effective minimum for every higher
 *   timeframe is therefore `50`.
 */
export const MIN_CANDLES_BY_TIMEFRAME: Readonly<
  Record<CandleTimeframe, number>
> = Object.freeze({
  "1m": 220,
  "5m": 50,
  "1h": 50,
  "4h": 50,
  "12h": 50,
  "1d": 50,
  "1w": 50,
});

/**
 * Freshness ceilings per timeframe (ms). A closed bar for a given
 * timeframe should not become stale within minutes; these values
 * cover a bar close + propagation delay (and, for daily/weekly,
 * weekends / holidays).
 */
export const MAX_CANDLE_AGE_MS: Readonly<Record<CandleTimeframe, number>> =
  Object.freeze({
    "1m": 180_000,
    "5m": 600_000,
    "1h": 5_400_000,
    "4h": 21_600_000,
    "12h": 54_000_000,
    "1d": 259_200_000,
    "1w": 864_000_000,
  });

export interface StrategyContextLoaderRepo {
  getInstrumentContractByConId(
    conId: string,
  ): Promise<InstrumentContract | null>;
  getRecentCandlesForContract(
    symbol: string,
    conId: string,
    timeframe: CandleTimeframe,
    limit: number,
    nativeWseOnly?: boolean,
  ): Promise<Candle[]>;
  getMarketState(conid: string): Promise<{
    conid: string;
    symbol: string;
    lastPrice: number;
    bid?: number;
    ask?: number;
    spread?: number;
    ts: string;
  } | null>;
}

export type StrategyContextLoadResult =
  | { readonly kind: "ok"; readonly context: StrategyContext }
  | {
      readonly kind: "error";
      readonly code:
        | "STRATEGY_CONTRACT_MISMATCH"
        | "STRATEGY_CONTEXT_UNAVAILABLE";
      readonly message: string;
    };

export interface StrategyContextLoaderOptions {
  readonly repo: StrategyContextLoaderRepo;
  /** Wall-clock reader; injectable for tests. */
  readonly clock?: () => Date;
  /**
   * Ceiling on how old the redis market-state can be before the
   * loader refuses to build a context. Zero disables the check.
   */
  readonly maxMarketStateAgeMs: number;
}

export interface StrategyContextFetchLimits {
  readonly [k: string]: number;
}

/**
 * Fetch limits per timeframe (bars). Matches the legacy inline
 * values in `SignalEngine.runForSymbol()`.
 */
export const DEFAULT_FETCH_LIMITS: Readonly<Record<CandleTimeframe, number>> =
  Object.freeze({
    "1m": 1000,
    "5m": 160,
    "1h": 160,
    "4h": 120,
    "12h": 90,
    "1d": 260,
    "1w": 104,
  });

function normalize(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

export class StrategyContextLoader {
  readonly #repo: StrategyContextLoaderRepo;
  readonly #clock: () => Date;
  readonly #maxMarketStateAgeMs: number;

  constructor(options: StrategyContextLoaderOptions) {
    if (!options?.repo) {
      throw new Error("StrategyContextLoader: repo is required");
    }
    this.#repo = options.repo;
    this.#clock = options.clock ?? (() => new Date());
    this.#maxMarketStateAgeMs = options.maxMarketStateAgeMs;
  }

  async load(input: {
    readonly instrument: Instrument;
    readonly bound: BoundInstrument;
    readonly positionQuantity: number;
    readonly timeframes: readonly CandleTimeframe[];
  }): Promise<StrategyContextLoadResult> {
    const { instrument, bound, positionQuantity } = input;
    const wse = isWseBound(bound);
    const profile = instrument.executionPolicy?.momentumBreakoutProfile ?? "default";
    if (!["default", "pko_mild_v1", "pko_moderate_v1"].includes(profile)
      || (profile !== "default" && (!wse || instrument.id !== "pko_wse" || instrument.brokerSymbol !== "PKO"
        || String(bound.conId) !== "35146360" || bound.currency !== "PLN" || bound.exchange !== "WSE" || instrument.assetClass !== "stock")))
      return { kind: "error", code: "STRATEGY_CONTRACT_MISMATCH", message: "momentum profile identity mismatch" };
    const timeframes = input.timeframes.filter(tf => !(wse && tf === "12h"));
    const nowMs = this.#clock().getTime();
    const symbol = instrument.brokerSymbol;
    const boundConId = String(bound.conId);

    // Step 1 — 1m candles first. Without them nothing else is
    // meaningful.
    let candles1m = await this.#repo.getRecentCandlesForContract(
      symbol,
      boundConId,
      "1m",
      DEFAULT_FETCH_LIMITS["1m"],
      wse,
    );
    if (wse) candles1m = candles1m.filter(c => c.timeframe === "1m" && c.conid === boundConId && c.symbol === bound.brokerSymbol && validClosedWseCandle(c, nowMs));
    if (candles1m.length === 0) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "no 1m candles for contract",
      };
    }
    if (candles1m.length < MIN_CANDLES_BY_TIMEFRAME["1m"]) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: `insufficient 1m candles: ${candles1m.length} < ${MIN_CANDLES_BY_TIMEFRAME["1m"]}`,
      };
    }
    const latest1mTs = wse ? wseCandleEnd(candles1m[candles1m.length - 1].ts, "1m") : new Date(candles1m[candles1m.length - 1].ts).getTime();
    if (Number.isNaN(latest1mTs) || latest1mTs > nowMs) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "latest 1m candle has invalid or future timestamp",
      };
    }
    if (nowMs - latest1mTs > MAX_CANDLE_AGE_MS["1m"]) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: `latest 1m candle is stale (age ${nowMs - latest1mTs}ms)`,
      };
    }

    // Step 2 — authoritative contract by conId. Absent row =
    // MISMATCH: the operator supplied a binding for a conId with
    // no persisted contract metadata.
    const contract = await this.#repo.getInstrumentContractByConId(boundConId);
    if (!contract) {
      return {
        kind: "error",
        code: "STRATEGY_CONTRACT_MISMATCH",
        message: `no contract row for conId ${boundConId}`,
      };
    }

    // Step 3 — verify every required field. All comparisons after
    // trim + uppercase. Missing / null required field is MISMATCH.
    if (normalize(contract.conid) !== normalize(boundConId)) {
      return {
        kind: "error",
        code: "STRATEGY_CONTRACT_MISMATCH",
        message: `contract conid=${contract.conid} != bound.conId=${boundConId}`,
      };
    }
    if (
      !contract.symbol ||
      normalize(contract.symbol) !== normalize(bound.brokerSymbol)
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTRACT_MISMATCH",
        message: `contract.symbol=${contract.symbol ?? "<null>"} != bound.brokerSymbol=${bound.brokerSymbol}`,
      };
    }
    if (
      !contract.localSymbol ||
      normalize(contract.localSymbol) !== normalize(bound.localSymbol)
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTRACT_MISMATCH",
        message: `contract.localSymbol=${contract.localSymbol ?? "<null>"} != bound.localSymbol=${bound.localSymbol}`,
      };
    }
    if (
      !contract.tradingClass ||
      normalize(contract.tradingClass) !== normalize(bound.tradingClass)
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTRACT_MISMATCH",
        message: `contract.tradingClass=${contract.tradingClass ?? "<null>"} != bound.tradingClass=${bound.tradingClass}`,
      };
    }
    const boundExchange = normalize(bound.exchange);
    const contractExchange = normalize(contract.exchange ?? "");
    const contractPrimaryExchange = normalize(contract.primaryExchange ?? "");
    if (
      contractExchange !== boundExchange &&
      contractPrimaryExchange !== boundExchange
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTRACT_MISMATCH",
        message: `contract.exchange=${contract.exchange ?? "<null>"} / primary=${contract.primaryExchange ?? "<null>"} != bound.exchange=${bound.exchange}`,
      };
    }
    if (
      !contract.currency ||
      normalize(contract.currency) !== normalize(bound.currency)
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTRACT_MISMATCH",
        message: `contract.currency=${contract.currency ?? "<null>"} != bound.currency=${bound.currency}`,
      };
    }
    const expectedSecType = mapAssetClassToIbkrSecType(instrument.assetClass);
    if (normalize(contract.secType) !== expectedSecType) {
      return {
        kind: "error",
        code: "STRATEGY_CONTRACT_MISMATCH",
        message: `contract.secType=${contract.secType} != ${expectedSecType} (mapped from ${instrument.assetClass})`,
      };
    }
    const secType: SecType = expectedSecType;

    // Step 4 — remaining timeframes.
    const candlesByTimeframe: Partial<Record<CandleTimeframe, Candle[]>> = {
      "1m": candles1m,
    };
    for (const tf of timeframes) {
      if (tf === "1m") continue;
      const limit = DEFAULT_FETCH_LIMITS[tf];
      let fetched = await this.#repo.getRecentCandlesForContract(
        symbol,
        boundConId,
        tf,
        limit,
        wse,
      );
      if (wse) fetched = fetched.filter(c => c.timeframe === tf && c.conid === boundConId && c.symbol === bound.brokerSymbol && validClosedWseCandle(c, nowMs));
      if (fetched.length < MIN_CANDLES_BY_TIMEFRAME[tf]) {
        return {
          kind: "error",
          code: "STRATEGY_CONTEXT_UNAVAILABLE",
          message: `insufficient ${tf} candles: ${fetched.length} < ${MIN_CANDLES_BY_TIMEFRAME[tf]}`,
        };
      }
      const latestTs = wse ? wseCandleEnd(fetched[fetched.length - 1].ts, tf) : new Date(fetched[fetched.length - 1].ts).getTime();
      if (Number.isNaN(latestTs) || latestTs > nowMs) {
        return {
          kind: "error",
          code: "STRATEGY_CONTEXT_UNAVAILABLE",
          message: `latest ${tf} candle has invalid or future timestamp`,
        };
      }
      if (nowMs - latestTs > MAX_CANDLE_AGE_MS[tf]) {
        return {
          kind: "error",
          code: "STRATEGY_CONTEXT_UNAVAILABLE",
          message: `latest ${tf} candle is stale (age ${nowMs - latestTs}ms)`,
        };
      }
      candlesByTimeframe[tf] = fetched;
    }

    // Step 5 — market state; identity validation is fail-closed.
    // Mirrors the validation rules of
    // `SignalRepositoryMarketDataReader.readMarketState`: identity
    // (conid + symbol), finite numeric fields, and freshness bounds.
    const marketState = await this.#repo.getMarketState(boundConId);
    if (!marketState) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: `no market state for conId ${boundConId}`,
      };
    }
    if (
      typeof marketState.conid !== "string" ||
      marketState.conid.trim().length === 0 ||
      marketState.conid !== boundConId
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "market state conid mismatch",
      };
    }
    if (
      typeof marketState.symbol !== "string" ||
      marketState.symbol.trim().length === 0 ||
      normalize(marketState.symbol) !== normalize(instrument.brokerSymbol)
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "market state symbol mismatch",
      };
    }
    if (
      typeof marketState.lastPrice !== "number" ||
      !Number.isFinite(marketState.lastPrice)
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "market state lastPrice is not a finite number",
      };
    }
    if (
      marketState.bid !== undefined &&
      (typeof marketState.bid !== "number" || !Number.isFinite(marketState.bid))
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "market state bid is not a finite number",
      };
    }
    if (
      marketState.ask !== undefined &&
      (typeof marketState.ask !== "number" || !Number.isFinite(marketState.ask))
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "market state ask is not a finite number",
      };
    }
    if (
      marketState.spread !== undefined &&
      (typeof marketState.spread !== "number" ||
        !Number.isFinite(marketState.spread))
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "market state spread is not a finite number",
      };
    }
    const marketStateTs = new Date(marketState.ts).getTime();
    if (Number.isNaN(marketStateTs) || marketStateTs > nowMs) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "market state has invalid or future timestamp",
      };
    }
    if (
      this.#maxMarketStateAgeMs > 0 &&
      nowMs - marketStateTs > this.#maxMarketStateAgeMs
    ) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: `market state stale (age ${nowMs - marketStateTs}ms > ${this.#maxMarketStateAgeMs}ms)`,
      };
    }

    // Step 6 — indicators + regime.
    const indicatorsInput: ComputeIndicatorsInput = {
      secType,
      candlesByTimeframe,
    };
    const indicators = computeIndicatorsForContext(indicatorsInput);
    if (!indicators) {
      return {
        kind: "error",
        code: "STRATEGY_CONTEXT_UNAVAILABLE",
        message: "indicator computation returned null",
      };
    }
    const latestCandle = candles1m[candles1m.length - 1];
    const regime = detectRegimeForContext(
      secType,
      latestCandle.close,
      indicators,
    );
    indicators.directionalRegime = regime.directionalRegime;
    indicators.volatilityRegime = regime.volatilityRegime;
    indicators.regimeScore = regime.score;
    indicators.regimeConfidence = regime.confidence;
    indicators.regimeReasons = regime.reasons;
    indicators.timeframeTrendScores = regime.timeframeTrendScores;
    indicators.timeframeTrendVotes = regime.timeframeTrendVotes;

    const context: StrategyContext = {
      momentumBreakoutProfile: profile,
      symbol,
      conid: boundConId,
      secType,
      directionalRegime: regime.directionalRegime,
      volatilityRegime: regime.volatilityRegime,
      latestCandle,
      indicators,
      candlesByTimeframe,
      marketState: {
        ...(marketState.bid !== undefined ? { bid: marketState.bid } : {}),
        ...(marketState.ask !== undefined ? { ask: marketState.ask } : {}),
        lastPrice: marketState.lastPrice,
        ...(marketState.spread !== undefined
          ? { spread: marketState.spread }
          : {}),
        ts: marketState.ts,
      },
      currentPosition: { quantity: positionQuantity },
    };
    return { kind: "ok", context };
  }
}
