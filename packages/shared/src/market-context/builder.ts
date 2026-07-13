import type { Instrument } from "../instruments/types.js";
import type { InstrumentRegistry } from "../instruments/registry.js";
import {
  computeOverallStatus,
  computeSectionStatus,
  DEFAULT_FRESHNESS_POLICY,
  type FreshnessPolicy,
} from "./freshness.js";
import type {
  MarketContextProvider,
  ProviderLoadInput,
  SectionLoadResult,
} from "./provider.js";
import type {
  InstrumentSectionData,
  MarketContextSectionKey,
  MarketContextSections,
  MarketContextSnapshot,
  Section,
} from "./types.js";

export interface MarketContextBuilderOptions {
  readonly registry: InstrumentRegistry;
  readonly providers: readonly MarketContextProvider[];
  readonly freshnessPolicy?: FreshnessPolicy;
  /** Deterministic clock. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export interface BuildInput {
  readonly instrumentId: string;
  /**
   * Override the builder clock for a single build. Useful for
   * back-testing snapshots against a historical reference time.
   */
  readonly now?: Date;
  /**
   * Explicit `validUntil - generatedAt` window in milliseconds.
   * Default: `min(policy.ttls[key])` across sections with data;
   * `0` if no section has data.
   */
  readonly validityMs?: number;
}

/**
 * Composes multiple `MarketContextProvider`s into a single
 * `MarketContextSnapshot`.
 *
 * Contract:
 *   - Runs every supported provider in parallel.
 *   - Enforces `provider.timeoutMs` per call. Timed-out providers
 *     produce an `unavailable` section + a warning; the underlying
 *     promise is left to complete/reject in the background.
 *   - Isolates provider errors: a single rejection produces an
 *     `unavailable` section + a warning, never a build-level throw.
 *   - Throws ONLY on unknown `instrumentId` or on constructor
 *     misconfiguration (e.g. missing registry).
 *   - Returns a deep-frozen snapshot (see `Object.freeze` transitively
 *     applied to every section object, tag/warning array, etc.).
 *   - If multiple providers claim the same section, the FIRST one to
 *     resolve successfully wins; every subsequent success is ignored
 *     and recorded as a snapshot-level warning.
 *
 * TODO(architecture): split `MarketContextBuilder` into three focused
 * pieces once a second consumer appears:
 *   - `ProviderRunner`   — parallel execution + timeout + error isolation,
 *   - `SnapshotAssembler` — section envelope construction, collision handling,
 *     overall status + validUntil computation,
 *   - freeze utilities   — cycle-safe deep-freeze extracted to its own module.
 * Not done in this PR: no second consumer yet, and the split would produce
 * three files with a single caller.
 */
export class MarketContextBuilder {
  readonly #registry: InstrumentRegistry;
  readonly #providers: readonly MarketContextProvider[];
  readonly #policy: FreshnessPolicy;
  readonly #now: () => Date;

  constructor(options: MarketContextBuilderOptions) {
    if (!options.registry) {
      throw new Error("MarketContextBuilder: registry is required");
    }
    this.#registry = options.registry;
    this.#providers = [...options.providers];
    this.#policy = options.freshnessPolicy ?? DEFAULT_FRESHNESS_POLICY;
    this.#now = options.now ?? (() => new Date());
  }

  async build(input: BuildInput): Promise<MarketContextSnapshot> {
    const instrument = this.#registry.getInstrumentOrThrow(input.instrumentId);
    const now = input.now ?? this.#now();
    const warnings: string[] = [];

    // Bootstrap: instrument section is filled from the registry, not
    // by any provider. It is always fresh for a known instrument.
    const instrumentSectionData = buildInstrumentSectionData(instrument);
    const sectionsMutable: MutableSectionsMap = createEmptySections(
      instrument.id,
      instrumentSectionData,
    );

    // Execute providers in parallel.
    const eligibleProviders = this.#providers.filter((p) =>
      p.supports(instrument),
    );
    const runs = eligibleProviders.map((provider) =>
      runProvider(provider, { instrument, now }),
    );
    const results = await Promise.all(runs);

    // Track which sections already have a resolved winner so
    // later resolutions do not overwrite them.
    const filled = new Set<MarketContextSectionKey>(["instrument"]);

    for (let i = 0; i < eligibleProviders.length; i += 1) {
      const provider = eligibleProviders[i];
      const outcome = results[i];
      const section = provider.section;

      switch (outcome.kind) {
        case "ok": {
          if (filled.has(section)) {
            warnings.push(
              `provider "${provider.id}" produced section "${section}" but ` +
                `it was already provided by an earlier provider; result ignored`,
            );
            continue;
          }
          const providerSection = buildSectionFromProvider(
            section,
            outcome.value,
            this.#policy,
            provider.freshnessTtlMs,
            now,
          );
          sectionsMutable[section] = providerSection;
          filled.add(section);
          break;
        }
        case "timeout": {
          const warning =
            `provider "${provider.id}" timed out after ` +
            `${provider.timeoutMs}ms`;
          appendSectionWarning(sectionsMutable, section, warning);
          warnings.push(warning);
          break;
        }
        case "error": {
          const message =
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error);
          const warning = `provider "${provider.id}" failed: ${message}`;
          appendSectionWarning(sectionsMutable, section, warning);
          warnings.push(warning);
          break;
        }
      }
    }

    const overallStatus = computeOverallStatus(sectionsMutable);

    const generatedAt = now;
    const validityMs =
      input.validityMs ??
      computeDefaultValidityMs(sectionsMutable, this.#policy);
    const validUntil = new Date(generatedAt.getTime() + validityMs);

    const snapshot: MarketContextSnapshot = {
      instrumentId: instrument.id,
      generatedAt,
      validUntil,
      overallStatus,
      warnings,
      sections: sectionsMutable as MarketContextSections,
    };
    return deepFreeze(snapshot);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type MutableSectionsMap = {
  -readonly [K in MarketContextSectionKey]: Section<unknown>;
};

type ProviderOutcome =
  | { readonly kind: "ok"; readonly value: SectionLoadResult<MarketContextSectionKey> }
  | { readonly kind: "timeout" }
  | { readonly kind: "error"; readonly error: unknown };

// TODO(abort): once providers gain real I/O (HTTP, IBKR sockets), thread an
// `AbortController` through `ProviderLoadInput` and abort it here on timeout so
// upstream requests are actually cancelled instead of being left to run to
// completion. Not implemented in this PR — no provider does I/O yet.
async function runProvider(
  provider: MarketContextProvider,
  input: ProviderLoadInput,
): Promise<ProviderOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<ProviderOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "timeout" }),
        provider.timeoutMs,
      );
    });
    const workPromise: Promise<ProviderOutcome> = provider
      .load(input)
      .then(
        (value): ProviderOutcome => ({ kind: "ok", value }),
      )
      .catch(
        (error: unknown): ProviderOutcome => ({ kind: "error", error }),
      );
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function buildInstrumentSectionData(
  instrument: Instrument,
): InstrumentSectionData {
  return {
    id: instrument.id,
    displayName: instrument.displayName,
    assetClass: instrument.assetClass,
    broker: instrument.broker,
    brokerSymbol: instrument.brokerSymbol,
    exchange: instrument.exchange,
    currency: instrument.currency,
    primaryExchange: instrument.primaryExchange,
    conId: instrument.conId,
    localSymbol: instrument.localSymbol,
    tradingClass: instrument.tradingClass,
    sessionTemplate: instrument.session.sessionTemplate,
    quantityUnit: instrument.risk.quantityUnit,
  };
}

function createEmptySections(
  _instrumentId: string,
  instrumentData: InstrumentSectionData,
): MutableSectionsMap {
  const empty = <T>(): Section<T> => ({
    status: "unavailable",
    observedAt: null,
    source: null,
    data: null,
    warnings: [],
  });
  return {
    instrument: {
      status: "fresh",
      observedAt: null,
      source: "instrument-registry",
      data: instrumentData,
      warnings: [],
    },
    price: empty(),
    technical: empty(),
    macro: empty(),
    crossAsset: empty(),
    positioning: empty(),
    flows: empty(),
    inventory: empty(),
    calendar: empty(),
    news: empty(),
    brokerState: empty(),
  };
}

function buildSectionFromProvider<K extends MarketContextSectionKey>(
  section: K,
  loadResult: SectionLoadResult<MarketContextSectionKey>,
  policy: FreshnessPolicy,
  providerTtlOverrideMs: number | undefined,
  now: Date,
): Section<unknown> {
  const effectivePolicy =
    providerTtlOverrideMs !== undefined
      ? {
          ttls: {
            ...policy.ttls,
            [section]: providerTtlOverrideMs,
          },
        }
      : policy;
  const status = computeSectionStatus(
    loadResult.observedAt,
    section,
    effectivePolicy,
    now,
  );
  return {
    status,
    observedAt: loadResult.observedAt,
    source: loadResult.source,
    data: loadResult.data,
    warnings: loadResult.warnings ? [...loadResult.warnings] : [],
  };
}

function appendSectionWarning(
  sections: MutableSectionsMap,
  key: MarketContextSectionKey,
  warning: string,
): void {
  const current = sections[key];
  sections[key] = {
    status: current.status,
    observedAt: current.observedAt,
    source: current.source,
    data: current.data,
    warnings: [...current.warnings, warning],
  };
}

function computeDefaultValidityMs(
  sections: Readonly<Record<MarketContextSectionKey, Section<unknown>>>,
  policy: FreshnessPolicy,
): number {
  let min = Number.POSITIVE_INFINITY;
  for (const [key, section] of Object.entries(sections)) {
    if (section.data === null) continue;
    const ttl = policy.ttls[key as MarketContextSectionKey];
    if (ttl < min) {
      min = ttl;
    }
  }
  if (!Number.isFinite(min)) {
    return 0;
  }
  return min;
}

function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Object.isFrozen(node)) {
      // Already frozen — still recurse in case children contain unfrozen
      // objects (frozen parents can legally reference mutable children).
      for (const child of Object.values(node as Record<string, unknown>)) {
        walk(child);
      }
      return;
    }
    for (const child of Object.values(node as Record<string, unknown>)) {
      walk(child);
    }
    Object.freeze(node);
  };
  walk(value);
  return value;
}
