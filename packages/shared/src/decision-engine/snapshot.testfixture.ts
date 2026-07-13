import type {
  BrokerAccountEnvironment,
  BrokerStateSectionData,
  CalendarEvent,
  CalendarSectionData,
  MarketContextSections,
  MarketContextSnapshot,
  NewsSectionData,
  NewsSentiment,
  OverallStatus,
  PriceSectionData,
  Section,
  SectionStatus,
} from "../market-context/types.js";

/**
 * Test-only builders for `MarketContextSnapshot`. Kept out of the
 * production bundle via `tsconfig` exclude.
 */

const FIXED_INSTRUMENT_ID = "ctx_fut";
const FIXED_GENERATED_AT = new Date("2026-07-13T12:00:00Z");
const FIXED_VALID_UNTIL = new Date("2026-07-13T12:00:30Z");
const FIXED_OBSERVED_AT = new Date("2026-07-13T11:59:55Z");

function unavailableSection<T>(): Section<T> {
  return {
    status: "unavailable",
    observedAt: null,
    source: null,
    data: null,
    warnings: [],
  };
}

function freshSection<T>(data: T, source = "test"): Section<T> {
  return {
    status: "fresh",
    observedAt: FIXED_OBSERVED_AT,
    source,
    data,
    warnings: [],
  };
}

function staleSection<T>(data: T, source = "test"): Section<T> {
  return {
    status: "stale",
    observedAt: new Date(FIXED_OBSERVED_AT.getTime() - 60_000),
    source,
    data,
    warnings: [],
  };
}

function baseSections(): {
  -readonly [K in keyof MarketContextSections]: MarketContextSections[K];
} {
  return {
    instrument: {
      status: "fresh",
      observedAt: null,
      source: "instrument-registry",
      data: {
        id: FIXED_INSTRUMENT_ID,
        displayName: "Context Future",
        assetClass: "future",
        broker: "ibkr",
        brokerSymbol: "CX",
        exchange: "CME",
        currency: "USD",
        sessionTemplate: "cme_equity_index",
        quantityUnit: "contracts",
      },
      warnings: [],
    },
    price: unavailableSection<PriceSectionData>(),
    technical: unavailableSection(),
    macro: unavailableSection(),
    crossAsset: unavailableSection(),
    positioning: unavailableSection(),
    flows: unavailableSection(),
    inventory: unavailableSection(),
    calendar: unavailableSection<CalendarSectionData>(),
    news: unavailableSection<NewsSectionData>(),
    brokerState: unavailableSection<BrokerStateSectionData>(),
  };
}

export interface SnapshotOverrides {
  readonly instrumentId?: string;
  readonly generatedAt?: Date;
  readonly validUntil?: Date;
  readonly overallStatus?: OverallStatus;
  readonly warnings?: readonly string[];
  readonly price?: SectionOverride<PriceSectionData>;
  readonly news?: SectionOverride<NewsSectionData>;
  readonly calendar?: SectionOverride<CalendarSectionData>;
  readonly brokerState?: SectionOverride<BrokerStateSectionData>;
}

export type SectionOverride<T> =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "present";
      readonly status?: SectionStatus;
      readonly data: T;
      readonly observedAt?: Date;
      readonly source?: string;
      readonly warnings?: readonly string[];
    };

function applySectionOverride<T>(
  base: Section<T>,
  override: SectionOverride<T> | undefined,
): Section<T> {
  if (!override) return base;
  if (override.kind === "unavailable") {
    return unavailableSection<T>();
  }
  const status = override.status ?? "fresh";
  const observedAt =
    override.observedAt ??
    (status === "stale"
      ? new Date(FIXED_OBSERVED_AT.getTime() - 60_000)
      : FIXED_OBSERVED_AT);
  return {
    status,
    observedAt,
    source: override.source ?? "test",
    data: override.data,
    warnings: override.warnings ?? [],
  };
}

export function buildSnapshot(
  overrides: SnapshotOverrides = {},
): MarketContextSnapshot {
  const sections = baseSections();
  sections.price = applySectionOverride(sections.price, overrides.price);
  sections.news = applySectionOverride(sections.news, overrides.news);
  sections.calendar = applySectionOverride(sections.calendar, overrides.calendar);
  sections.brokerState = applySectionOverride(
    sections.brokerState,
    overrides.brokerState,
  );
  return {
    instrumentId: overrides.instrumentId ?? FIXED_INSTRUMENT_ID,
    generatedAt: overrides.generatedAt ?? FIXED_GENERATED_AT,
    validUntil: overrides.validUntil ?? FIXED_VALID_UNTIL,
    overallStatus: overrides.overallStatus ?? "fresh",
    warnings: overrides.warnings ?? [],
    sections,
  };
}

// Convenience shorthands used across multiple tests.

export function samplePriceData(
  partial: Partial<PriceSectionData> = {},
): PriceSectionData {
  return { last: 100, bid: 99.5, ask: 100.5, spread: 1, ...partial };
}

export function sampleNewsData(
  partial: Partial<NewsSectionData> = {},
): NewsSectionData {
  return {
    sentiment: "neutral" as NewsSentiment,
    headlines: [],
    riskFlags: [],
    ...partial,
  };
}

export function sampleBrokerData(
  partial: Partial<BrokerStateSectionData> = {},
): BrokerStateSectionData {
  return {
    accountEnvironment: "paper" as BrokerAccountEnvironment,
    openOrders: [],
    ...partial,
  };
}

export function sampleCalendarEvent(
  minutesFromNow: number,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id: overrides.id ?? "evt-1",
    title: overrides.title ?? "FOMC",
    impact: overrides.impact ?? "high",
    startsAt:
      overrides.startsAt ??
      new Date(FIXED_GENERATED_AT.getTime() + minutesFromNow * 60_000),
    country: overrides.country,
    category: overrides.category,
  };
}

export const FIXTURE_GENERATED_AT = FIXED_GENERATED_AT;
export const FIXTURE_INSTRUMENT_ID = FIXED_INSTRUMENT_ID;
