/**
 * Instrument Registry — type definitions.
 *
 * The Instrument Registry is the single source of truth for every tradable
 * instrument in the platform: contract identity, per-instrument trading
 * flags, risk envelope, session profile, futures roll policy and metadata.
 *
 * Consumers (execution-engine, signal-engine, backtest-engine, llm-agent,
 * ingestion, ui) MUST resolve instruments through the registry API and MUST
 * NOT keep private symbol lists or contract details.
 */

/**
 * Asset class taxonomy. Kept broad enough to accommodate the roadmap
 * (stocks/ETFs on equity brokers, options, crypto), but conservative enough
 * that runtime code can rely on discriminant checks without an `any` escape
 * hatch.
 */
export type AssetClass =
  | "future"
  | "stock"
  | "etf"
  | "index"
  | "forex"
  | "option"
  | "crypto";

/**
 * Broker adapter identifier. Extended as new brokers are onboarded.
 */
export type Broker = "ibkr";

/**
 * Named session profile. Concrete calendar / session-window resolution is
 * the responsibility of the Market Context Engine (future). The registry
 * stores only the template label so multiple instruments can share one
 * schedule without duplication.
 */
export type SessionTemplate =
  | "cme_metals"
  | "cme_equity_index"
  | "us_stock_rth"
  | "us_stock_ext"
  | "lse_stock_rth"
  | "wse_stock_rth";

/**
 * Roll policy for futures. `calendar` rolls a fixed number of days before
 * expiry (`rollDaysBeforeExpiry`); `volume_and_oi` rolls when the next
 * contract overtakes the current one in both metrics; `none` means the
 * instrument is treated as a single dated contract and never rolled.
 */
export type RollStrategy = "none" | "calendar" | "volume_and_oi";

export interface InstrumentTradingFlags {
  /** Whether the execution-engine will accept live orders for this instrument. */
  readonly executionEnabled: boolean;
  /** Whether the signal-engine emits new StrategySignals for this instrument. */
  readonly signalGenerationEnabled: boolean;
  /** Whether the llm-agent gates decisions on this instrument. */
  readonly aiAnalysisEnabled: boolean;
  /** Whether ingestion tracks market state / candles for this instrument. */
  readonly monitoringEnabled: boolean;
}

/**
 * Unit that `InstrumentRisk.maxQuantity` counts. `contracts` for futures /
 * options, `shares` for equities / ETFs. Kept explicit so downstream code
 * (Risk Engine, sizing, UI) never has to infer intent from `assetClass`.
 */
export type QuantityUnit = "contracts" | "shares";

export interface InstrumentRisk {
  /**
   * Hard cap on how many units of the instrument may be held at once.
   * This is an **integer count**, not a notional dollar value: e.g. `2`
   * for two ES futures contracts, `500` for 500 AAPL shares. The unit is
   * given by `quantityUnit`.
   */
  readonly maxQuantity: number;
  /** Unit `maxQuantity` counts (see `QuantityUnit`). */
  readonly quantityUnit: QuantityUnit;
  /** Max broker leverage tolerated for this instrument (`1` = cash / no leverage). */
  readonly maxLeverage: number;
  /** Whether positions in this instrument may be carried past the session close. */
  readonly allowOvernight: boolean;
  /** Max acceptable bid/ask spread in price units. */
  readonly maxSpread: number;
  /** Max acceptable per-trade slippage in price units. */
  readonly maxSlippage: number;
}

export interface InstrumentSession {
  /**
   * When `true`, ingestion / execution respect only Regular Trading Hours
   * (e.g. IBKR `outsideRTH=false`, no pre/post-market fills).
   */
  readonly useRegularTradingHours: boolean;
  /** IANA timezone the session template is anchored to. */
  readonly timezone: string;
  /** Named session profile (see `SessionTemplate`). */
  readonly sessionTemplate: SessionTemplate;
}

export interface InstrumentRoll {
  readonly rollStrategy: RollStrategy;
  /**
   * Days before expiry to roll when `rollStrategy === "calendar"`.
   * Ignored for other strategies but retained for auditability.
   */
  readonly rollDaysBeforeExpiry: number;
}

export interface InstrumentMetadata {
  readonly tags: readonly string[];
  readonly sector?: string;
  readonly description?: string;
}

/**
 * Fully-qualified broker contract identity — everything a broker adapter
 * needs to unambiguously address a single tradable contract.
 *
 * `brokerSymbol` alone is NOT unique: futures roots (e.g. `SI`, `ES`)
 * are shared across many expirations. Disambiguation goes through
 * `localSymbol` (e.g. `SIZ26`) or `conId` (the IBKR-assigned contract id,
 * globally unique per broker) or, for options and some weekly futures,
 * `tradingClass`.
 *
 * Registry uniqueness is enforced on the full tuple
 * `(broker, exchange, currency, brokerSymbol, tradingClass, localSymbol, conId)`.
 * Two entries that agree on that tuple are treated as duplicates; any
 * difference in `localSymbol` OR `conId` OR `tradingClass` (with everything
 * else equal) is a legitimate multi-contract catalogue.
 */
export interface BrokerContractKey {
  readonly broker: Broker;
  readonly brokerSymbol: string;
  readonly exchange: string;
  readonly currency: string;
  readonly tradingClass?: string;
  readonly localSymbol?: string;
  readonly conId?: number;
}

/**
 * A single instrument definition. Immutable — every field is `readonly` at
 * the type level and every object (including nested `trading`, `risk`,
 * `session`, `roll`, `metadata` and `metadata.tags`) is deep-frozen at
 * runtime by `InstrumentRegistry`, so consumers can safely share
 * references without defensive copies.
 *
 * Invariants (enforced by `InstrumentRegistry` at construction time):
 *   - `id` is unique across the registry.
 *   - The full `BrokerContractKey` tuple
 *     `(broker, exchange, currency, brokerSymbol, tradingClass, localSymbol, conId)`
 *     is unique across the registry. Multiple entries may share
 *     `brokerSymbol` (e.g. several futures expirations of `SI`) as long as
 *     `localSymbol`, `conId` or `tradingClass` disambiguate them.
 *   - `assetClass === "future"` requires `roll` to be present.
 *   - `assetClass !== "future"` requires `roll` to be absent (guards against
 *     copy-paste bugs where an equity accidentally inherits a futures roll
 *     policy).
 */
export interface Instrument {
  readonly id: string;
  readonly displayName: string;
  readonly assetClass: AssetClass;
  readonly broker: Broker;
  readonly brokerSymbol: string;
  readonly exchange: string;
  readonly currency: string;
  readonly primaryExchange?: string;
  readonly conId?: number;
  readonly localSymbol?: string;
  readonly tradingClass?: string;
  readonly trading: InstrumentTradingFlags;
  readonly risk: InstrumentRisk;
  readonly session: InstrumentSession;
  readonly roll?: InstrumentRoll;
  readonly metadata: InstrumentMetadata;
}
