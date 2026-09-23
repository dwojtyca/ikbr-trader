import { InstrumentRegistry } from "./registry.js";
import type { Instrument } from "./types.js";

/**
 * Curated seed catalogue. Disabled PKO/WSE stock plus six IBKR futures — four precious /
 * industrial metals on COMEX/NYMEX plus the two flagship US equity-index
 * e-minis on CME. These are the front-month contracts; the actual
 * expiration is resolved by the futures roll adapter (calendar strategy,
 * 7 days before expiry).
 *
 * All values are intentionally conservative — the registry ships with
 * `executionEnabled=false` on every entry so that adding the registry to
 * the platform cannot, by itself, cause an order to be sent. Operators
 * must opt in per-instrument.
 */
const METALS_TIMEZONE = "America/New_York";
const EQUITY_INDEX_TIMEZONE = "America/Chicago";

export const INSTRUMENT_DEFINITIONS: readonly Instrument[] = [
  {
    id: "si_front",
    displayName: "Silver Front Month",
    assetClass: "future",
    broker: "ibkr",
    brokerSymbol: "SI",
    exchange: "COMEX",
    currency: "USD",
    tradingClass: "SI",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    },
    risk: {
      maxQuantity: 2,
      quantityUnit: "contracts",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 0.02,
      maxSlippage: 0.05,
    },
    session: {
      useRegularTradingHours: false,
      timezone: METALS_TIMEZONE,
      sessionTemplate: "cme_metals",
    },
    roll: {
      rollStrategy: "calendar",
      rollDaysBeforeExpiry: 7,
    },
    metadata: {
      tags: ["metal", "precious", "commodity"],
      sector: "metals",
      description: "5,000 troy oz silver, COMEX front-month.",
    },
  },
  {
    id: "gc_front",
    displayName: "Gold Front Month",
    assetClass: "future",
    broker: "ibkr",
    brokerSymbol: "GC",
    exchange: "COMEX",
    currency: "USD",
    tradingClass: "GC",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    },
    risk: {
      maxQuantity: 2,
      quantityUnit: "contracts",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 0.5,
      maxSlippage: 1.0,
    },
    session: {
      useRegularTradingHours: false,
      timezone: METALS_TIMEZONE,
      sessionTemplate: "cme_metals",
    },
    roll: {
      rollStrategy: "calendar",
      rollDaysBeforeExpiry: 7,
    },
    metadata: {
      tags: ["metal", "precious", "commodity"],
      sector: "metals",
      description: "100 troy oz gold, COMEX front-month.",
    },
  },
  {
    id: "pl_front",
    displayName: "Platinum Front Month",
    assetClass: "future",
    broker: "ibkr",
    brokerSymbol: "PL",
    exchange: "NYMEX",
    currency: "USD",
    tradingClass: "PL",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    },
    risk: {
      maxQuantity: 1,
      quantityUnit: "contracts",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 2.0,
      maxSlippage: 3.0,
    },
    session: {
      useRegularTradingHours: false,
      timezone: METALS_TIMEZONE,
      sessionTemplate: "cme_metals",
    },
    roll: {
      rollStrategy: "calendar",
      rollDaysBeforeExpiry: 7,
    },
    metadata: {
      tags: ["metal", "precious", "commodity"],
      sector: "metals",
      description: "50 troy oz platinum, NYMEX front-month.",
    },
  },
  {
    id: "hg_front",
    displayName: "Copper Front Month",
    assetClass: "future",
    broker: "ibkr",
    brokerSymbol: "HG",
    exchange: "COMEX",
    currency: "USD",
    tradingClass: "HG",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    },
    risk: {
      maxQuantity: 2,
      quantityUnit: "contracts",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 0.001,
      maxSlippage: 0.003,
    },
    session: {
      useRegularTradingHours: false,
      timezone: METALS_TIMEZONE,
      sessionTemplate: "cme_metals",
    },
    roll: {
      rollStrategy: "calendar",
      rollDaysBeforeExpiry: 7,
    },
    metadata: {
      tags: ["metal", "industrial", "commodity"],
      sector: "metals",
      description: "25,000 lb copper, COMEX front-month.",
    },
  },
  {
    id: "es_front",
    displayName: "E-mini S&P 500 Front Month",
    assetClass: "future",
    broker: "ibkr",
    brokerSymbol: "ES",
    exchange: "CME",
    currency: "USD",
    tradingClass: "ES",
    trading: {
      // PR15.3 hostile-review Finding 2 — activation ROLLED BACK.
      // The Phase 2 runtime pipeline is Decision + Risk with no
      // strategy layer; it does NOT invoke
      // `MomentumBreakoutLongStrategy` (nor any strategy from
      // `apps/signal-engine/src/strategies/`) and cannot produce an
      // authenticated `strategyId` on the winning signal. Activating
      // `es_front` with `executionPolicy.strategyId =
      // "momentum_breakout_long_v1"` would let the generic pipeline
      // route ANY LONG/SHORT decision under a policy that promises
      // one specific strategy. See PR15_3_PLAN.md r2 §11 for the
      // required real strategy-registry integration; until that
      // lands, no seed may be execution-enabled.
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    },
    risk: {
      maxQuantity: 2,
      quantityUnit: "contracts",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 0.25,
      maxSlippage: 0.5,
    },
    session: {
      useRegularTradingHours: false,
      timezone: EQUITY_INDEX_TIMEZONE,
      sessionTemplate: "cme_equity_index",
    },
    roll: {
      rollStrategy: "calendar",
      rollDaysBeforeExpiry: 7,
    },
    metadata: {
      tags: ["equity_index", "us"],
      sector: "equity_index",
      description: "E-mini S&P 500 futures, CME front-month.",
    },
    // PR15.3 hostile-review Finding 2 — `executionPolicy` REMOVED
    // together with the activation flip. The shape and the target
    // values live in PR15_3_PLAN.md r2 §3.2; they re-enter this seed
    // ONLY when the r2 strategy-integration step is complete.
  },
  {
    id: "nq_front",
    displayName: "E-mini Nasdaq 100 Front Month",
    assetClass: "future",
    broker: "ibkr",
    brokerSymbol: "NQ",
    exchange: "CME",
    currency: "USD",
    tradingClass: "NQ",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    },
    risk: {
      maxQuantity: 2,
      quantityUnit: "contracts",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 0.5,
      maxSlippage: 1.0,
    },
    session: {
      useRegularTradingHours: false,
      timezone: EQUITY_INDEX_TIMEZONE,
      sessionTemplate: "cme_equity_index",
    },
    roll: {
      rollStrategy: "calendar",
      rollDaysBeforeExpiry: 7,
    },
    metadata: {
      tags: ["equity_index", "us"],
      sector: "equity_index",
      description: "E-mini Nasdaq 100 futures, CME front-month.",
    },
  },
  {
    id: "pko_wse",
    displayName: "PKO Bank Polski",
    assetClass: "stock",
    broker: "ibkr",
    brokerSymbol: "PKO",
    conId: 35146360,
    localSymbol: "PKO",
    exchange: "WSE",
    currency: "PLN",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: false,
      aiAnalysisEnabled: false,
      monitoringEnabled: false,
    },
    risk: {
      maxQuantity: 1,
      quantityUnit: "shares",
      maxLeverage: 1,
      allowOvernight: false,
      maxSpread: 0.05,
      maxSlippage: 0.05,
    },
    session: {
      useRegularTradingHours: true,
      timezone: "Europe/Warsaw",
      sessionTemplate: "wse_stock_rth",
    },
    metadata: { tags: ["equity", "poland"], sector: "financials" },
  },
];

/**
 * Process-wide registry singleton. Constructed once at module load; the
 * constructor validates uniqueness and per-asset-class invariants so any
 * definition error surfaces at boot rather than at trade time.
 */
export const defaultInstrumentRegistry = new InstrumentRegistry(
  INSTRUMENT_DEFINITIONS,
);
