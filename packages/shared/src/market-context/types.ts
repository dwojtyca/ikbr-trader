/**
 * Market Context Engine — type definitions.
 *
 * A `MarketContextSnapshot` is a single, immutable, structured view of
 * everything a downstream Decision Engine, Risk Engine or LLM needs to
 * know about an instrument at a point in time. Data is grouped into
 * eleven independently-refreshed sections (see `MarketContextSectionKey`).
 *
 * Providers (see `./provider.ts`) each own exactly one section and are
 * composed by `MarketContextBuilder`. The builder never throws for
 * provider failures — it surfaces them via section `status`,
 * `warnings`, and the overall snapshot status.
 */

import type {
  AssetClass,
  Broker,
  QuantityUnit,
  SessionTemplate,
} from "../instruments/types.js";

/** Freshness classification for a single section or for the snapshot. */
export type SectionStatus = "fresh" | "partial" | "stale" | "unavailable";

/** Overall snapshot status. Same alphabet as `SectionStatus`. */
export type OverallStatus = SectionStatus;

/**
 * Canonical section identifiers. New sections MUST be added here first;
 * the builder + freshness policy + snapshot shape are keyed off this
 * union so a missed spot is a compile error.
 */
export type MarketContextSectionKey =
  | "instrument"
  | "price"
  | "technical"
  | "macro"
  | "crossAsset"
  | "positioning"
  | "flows"
  | "inventory"
  | "calendar"
  | "news"
  | "brokerState";

/**
 * Every section is wrapped in the same envelope so consumers can read
 * status + provenance without knowing which section they hold.
 *
 * `data === null` iff `status === "unavailable"`.
 */
export interface Section<T> {
  readonly status: SectionStatus;
  readonly observedAt: Date | null;
  readonly source: string | null;
  readonly data: T | null;
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Section data types
// ---------------------------------------------------------------------------

/**
 * Static instrument identity, sourced from the `InstrumentRegistry`. The
 * builder populates this section itself, so it is always `fresh` for a
 * known `instrumentId`.
 */
export interface InstrumentSectionData {
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
  readonly sessionTemplate: SessionTemplate;
  readonly quantityUnit: QuantityUnit;
}

export interface PriceSectionData {
  readonly last: number;
  readonly bid?: number;
  readonly ask?: number;
  /** Bid-ask spread in price units, if bid + ask are both present. */
  readonly spread?: number;
  /** Percent change vs. the previous session close (e.g. 1.25 for +1.25%). */
  readonly changePct?: number;
  readonly volume?: number;
}

/** Direction of the primary trend in the trader's operating timeframe. */
export type TrendDirection = "up" | "down" | "sideways";

/** Coarse volatility bucket. Precise numbers live in `data.value`. */
export type VolatilityBucket = "low" | "normal" | "high";

export interface TrendSummary {
  readonly direction: TrendDirection;
  /** Confidence in `[0, 1]`. */
  readonly strength: number;
}

export interface MomentumSummary {
  /** Signed momentum score. Sign encodes direction. */
  readonly value: number;
  readonly window: string;
}

export interface VolatilitySummary {
  readonly bucket: VolatilityBucket;
  /** Realized-volatility annualised, in percent, if available. */
  readonly annualisedPct?: number;
}

export interface TimeframeSignal {
  readonly timeframe: string;
  readonly signal: "long" | "short" | "flat";
  readonly score: number;
}

export interface TechnicalSectionData {
  readonly trend: TrendSummary;
  readonly momentum: MomentumSummary;
  readonly volatility: VolatilitySummary;
  readonly supportLevels: readonly number[];
  readonly resistanceLevels: readonly number[];
  readonly timeframeSignals: readonly TimeframeSignal[];
}

export interface RateExpectations {
  /** Implied policy rate at horizon, percent. */
  readonly impliedRatePct: number;
  /** Horizon label, e.g. `"3m"`, `"1y"`. */
  readonly horizon: string;
  /** Number of 25 bps hikes/cuts priced in over horizon. Negative = cuts. */
  readonly hikesPriced: number;
}

export interface MacroSectionData {
  /** US dollar index. */
  readonly dxy?: number;
  /** US 2-year Treasury yield, percent. */
  readonly us2y?: number;
  /** US 10-year Treasury yield, percent. */
  readonly us10y?: number;
  /** 10-year TIPS-derived real yield, percent. */
  readonly realYield?: number;
  readonly rateExpectations?: RateExpectations;
}

export interface CrossAssetSectionData {
  readonly gold?: number;
  readonly silver?: number;
  readonly platinum?: number;
  readonly copper?: number;
  readonly oil?: number;
}

export interface CotReport {
  /** Net position of the reported cohort (long − short). */
  readonly net: number;
  readonly long: number;
  readonly short: number;
  readonly reportedFor: Date;
  /** Cohort — for CFTC: `commercials`, `noncommercials`, `nonreportables`. */
  readonly cohort: string;
}

export interface PositioningSectionData {
  readonly cot?: CotReport;
  readonly openInterest?: number;
}

/** Rolling-window flows in a single ETF or basket. */
export interface EtfFlow {
  readonly symbol: string;
  readonly window: "1d" | "5d" | "20d";
  readonly netFlowUsd: number;
}

export interface FlowsSectionData {
  readonly etfFlows: readonly EtfFlow[];
}

/** Per-warehouse or per-exchange inventory reading. */
export interface InventoryReading {
  readonly venue: string;
  readonly units: string;
  readonly amount: number;
}

export interface InventorySectionData {
  /** Legacy COMEX registered + eligible stockpile total, if reported. */
  readonly comexInventory?: number;
  /** Per-venue readings (any exchange, LBMA, SHFE, LME, …). */
  readonly exchangeInventory: readonly InventoryReading[];
}

export type CalendarEventImpact = "low" | "medium" | "high";

export interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly impact: CalendarEventImpact;
  readonly startsAt: Date;
  readonly country?: string;
  readonly category?: string;
}

export interface CalendarSectionData {
  readonly upcomingEvents: readonly CalendarEvent[];
  readonly nextHighImpactEvent?: CalendarEvent;
}

export type NewsSentiment = "positive" | "neutral" | "negative" | "mixed";

export interface NewsHeadline {
  readonly id: string;
  readonly title: string;
  readonly publishedAt: Date;
  readonly url?: string;
  readonly source?: string;
  readonly sentiment?: NewsSentiment;
}

export interface NewsSectionData {
  readonly sentiment: NewsSentiment;
  readonly headlines: readonly NewsHeadline[];
  readonly riskFlags: readonly string[];
}

export interface BrokerPositionSummary {
  readonly quantity: number;
  readonly avgPrice: number;
  readonly unrealizedPnl?: number;
}

export interface BrokerOpenOrderSummary {
  readonly id: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
  readonly orderType: string;
  readonly limitPrice?: number;
  readonly stopPrice?: number;
}

export type BrokerAccountEnvironment = "paper" | "live";

export interface BrokerStateSectionData {
  readonly position?: BrokerPositionSummary;
  readonly openOrders: readonly BrokerOpenOrderSummary[];
  readonly buyingPower?: number;
  readonly accountEnvironment: BrokerAccountEnvironment;
}

// ---------------------------------------------------------------------------
// Mapping key → data type. Used by provider typing so a given provider's
// `load()` result is checked against the section it claims to own.
// ---------------------------------------------------------------------------
export interface SectionDataByKey {
  readonly instrument: InstrumentSectionData;
  readonly price: PriceSectionData;
  readonly technical: TechnicalSectionData;
  readonly macro: MacroSectionData;
  readonly crossAsset: CrossAssetSectionData;
  readonly positioning: PositioningSectionData;
  readonly flows: FlowsSectionData;
  readonly inventory: InventorySectionData;
  readonly calendar: CalendarSectionData;
  readonly news: NewsSectionData;
  readonly brokerState: BrokerStateSectionData;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Top-level immutable market-context payload. Deep-frozen by
 * `MarketContextBuilder` before it leaves the process.
 *
 * `overallStatus` reflects only the ten *data* sections; the
 * `instrument` section is metadata and is always fresh for a known
 * `instrumentId`. See `computeOverallStatus` in `./freshness.ts`.
 */
export interface MarketContextSnapshot {
  readonly instrumentId: string;
  readonly generatedAt: Date;
  readonly validUntil: Date;
  readonly overallStatus: OverallStatus;
  readonly warnings: readonly string[];
  readonly sections: MarketContextSections;
}

export interface MarketContextSections {
  readonly instrument: Section<InstrumentSectionData>;
  readonly price: Section<PriceSectionData>;
  readonly technical: Section<TechnicalSectionData>;
  readonly macro: Section<MacroSectionData>;
  readonly crossAsset: Section<CrossAssetSectionData>;
  readonly positioning: Section<PositioningSectionData>;
  readonly flows: Section<FlowsSectionData>;
  readonly inventory: Section<InventorySectionData>;
  readonly calendar: Section<CalendarSectionData>;
  readonly news: Section<NewsSectionData>;
  readonly brokerState: Section<BrokerStateSectionData>;
}
