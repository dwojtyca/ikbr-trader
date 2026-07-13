import type {
  MarketContextSectionKey,
  OverallStatus,
  Section,
  SectionStatus,
} from "./types.js";

/**
 * Per-section time-to-live, in milliseconds. A section whose
 * `observedAt` is older than its TTL is classified as `stale`.
 *
 * The `instrument` section is metadata and effectively never stales —
 * its TTL is `Number.POSITIVE_INFINITY`.
 */
export interface FreshnessPolicy {
  readonly ttls: Readonly<Record<MarketContextSectionKey, number>>;
}

/**
 * Sections that describe pure metadata (not market data) and therefore
 * do not participate in `overallStatus` computation. See
 * `computeOverallStatus` for the reasoning.
 */
export const METADATA_SECTIONS: readonly MarketContextSectionKey[] =
  Object.freeze(["instrument"]);

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Default freshness policy for a Phase-1 platform. Numbers are tuned to
 * the cadence at which each data class is realistically republished by
 * upstream sources — not the frequency at which we would like them to
 * be. Consumers can override on a per-builder basis.
 */
export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = Object.freeze({
  ttls: Object.freeze({
    instrument: Number.POSITIVE_INFINITY,
    price: 30 * MS_PER_SECOND,
    technical: 5 * MS_PER_MINUTE,
    macro: 15 * MS_PER_MINUTE,
    crossAsset: 5 * MS_PER_MINUTE,
    positioning: 7 * MS_PER_DAY,
    flows: 24 * MS_PER_HOUR,
    inventory: 24 * MS_PER_HOUR,
    calendar: 6 * MS_PER_HOUR,
    news: 15 * MS_PER_MINUTE,
    brokerState: 30 * MS_PER_SECOND,
  }),
});

/**
 * Return a new policy identical to `base` except for the entries
 * present in `override`. Never mutates either argument.
 */
export function mergeFreshnessPolicy(
  base: FreshnessPolicy,
  override?: Partial<Record<MarketContextSectionKey, number>>,
): FreshnessPolicy {
  if (!override) {
    return base;
  }
  const merged: Record<MarketContextSectionKey, number> = { ...base.ttls };
  for (const [key, value] of Object.entries(override)) {
    if (typeof value === "number") {
      merged[key as MarketContextSectionKey] = value;
    }
  }
  return { ttls: Object.freeze(merged) };
}

/**
 * Classify a single section's freshness.
 *
 *   observedAt = null  → "unavailable"
 *   age <= ttl         → "fresh"
 *   age  > ttl         → "stale"
 *
 * `now.getTime() - observedAt.getTime()` is expected to be
 * non-negative in real usage; a small negative age (e.g. clock skew)
 * is treated as `fresh`.
 */
export function computeSectionStatus(
  observedAt: Date | null,
  section: MarketContextSectionKey,
  policy: FreshnessPolicy,
  now: Date,
): SectionStatus {
  if (!observedAt) {
    return "unavailable";
  }
  const ttl = policy.ttls[section];
  if (ttl === Number.POSITIVE_INFINITY) {
    return "fresh";
  }
  const ageMs = now.getTime() - observedAt.getTime();
  if (ageMs <= ttl) {
    return "fresh";
  }
  return "stale";
}

/**
 * Aggregate section statuses into a single overall status.
 *
 * The metadata sections (see `METADATA_SECTIONS`) are excluded so that
 * the overall status reflects the availability of *market data*, not
 * the presence of static registry information — otherwise a snapshot
 * for a known instrument with no provider hits would falsely read as
 * "fresh".
 *
 * Rules over the remaining data sections:
 *   - every section fresh                      → "fresh"
 *   - every section unavailable                → "unavailable"
 *   - every section stale (no fresh, no unavail) → "stale"
 *   - anything else (mixed)                    → "partial"
 */
export function computeOverallStatus(
  sections: Readonly<Record<MarketContextSectionKey, Section<unknown>>>,
): OverallStatus {
  const excluded = new Set<MarketContextSectionKey>(METADATA_SECTIONS);
  const statuses: SectionStatus[] = [];
  for (const [key, section] of Object.entries(sections)) {
    if (excluded.has(key as MarketContextSectionKey)) {
      continue;
    }
    statuses.push(section.status);
  }
  if (statuses.length === 0) {
    return "unavailable";
  }
  const allFresh = statuses.every((s) => s === "fresh");
  if (allFresh) return "fresh";
  const allUnavailable = statuses.every((s) => s === "unavailable");
  if (allUnavailable) return "unavailable";
  const allStale = statuses.every((s) => s === "stale");
  if (allStale) return "stale";
  return "partial";
}
