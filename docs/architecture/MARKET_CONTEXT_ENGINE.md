# Market Context Engine — Foundation (PR6)

> Status: **Phase 1, foundation only.** This document describes the
> `packages/shared/src/market-context/` module introduced in PR6.
> No consumer (ingestion, signal-engine, execution-engine, llm-agent,
> backtest-engine, ui) has been migrated yet — that is deferred to a
> later PR.

## Purpose

Provide a **single, immutable, structured snapshot** of everything a
downstream Decision Engine, Risk Engine or LLM needs to know about a
tradable instrument at a point in time. The snapshot fuses market
data, macro, positioning, flows, calendar, news and broker state into
one strongly-typed payload with per-source freshness metadata.

## Non-goals

The engine explicitly does **not**:

- fetch data from the internet in this PR (no HTTP / IBKR calls),
- know anything about strategies or trade decisions,
- know anything about execution — it never places, modifies or
  cancels orders,
- persist state or maintain a long-lived cache,
- migrate the existing `MarketRegimeDetector` in `signal-engine`
  (that lives in a later PR and will be adapted to consume the
  snapshot).

## Data model

### Snapshot

```ts
MarketContextSnapshot = {
  instrumentId: string;
  generatedAt: Date;
  validUntil: Date;
  overallStatus: "fresh" | "partial" | "stale" | "unavailable";
  warnings: readonly string[];
  sections: MarketContextSections;
}
```

The snapshot is **deep-frozen** before leaving `MarketContextBuilder.build()`.
Consumers may safely share the reference without defensive copies —
mutating any field, section, nested object or `warnings` array throws
a `TypeError` in strict mode.

### Sections

The snapshot has eleven sections, each wrapped in the same envelope:

```ts
Section<T> = {
  status: "fresh" | "partial" | "stale" | "unavailable";
  observedAt: Date | null;
  source: string | null;
  data: T | null;                // null iff status === "unavailable"
  warnings: readonly string[];
}
```

| Key            | Payload type                | Purpose                                                                      |
| -------------- | --------------------------- | ---------------------------------------------------------------------------- |
| `instrument`   | `InstrumentSectionData`     | Contract identity from `InstrumentRegistry`. **Metadata, always fresh.**     |
| `price`        | `PriceSectionData`          | Last, bid/ask, spread, change%, volume.                                      |
| `technical`    | `TechnicalSectionData`      | Trend, momentum, volatility, S/R, multi-timeframe signals.                   |
| `macro`        | `MacroSectionData`          | DXY, US 2y/10y, real yield, rate expectations.                               |
| `crossAsset`   | `CrossAssetSectionData`     | Cross-asset reference prices (metals, oil).                                  |
| `positioning`  | `PositioningSectionData`    | CFTC COT, aggregate open interest.                                           |
| `flows`        | `FlowsSectionData`          | ETF net flows over rolling windows.                                          |
| `inventory`    | `InventorySectionData`      | Physical inventory (COMEX, LBMA, SHFE, LME).                                 |
| `calendar`     | `CalendarSectionData`       | Upcoming economic events; next high-impact.                                  |
| `news`         | `NewsSectionData`           | Sentiment, headlines, risk flags.                                            |
| `brokerState`  | `BrokerStateSectionData`    | Read-only broker view: position, open orders, buying power, paper/live tag.  |

### Overall status

`overallStatus` is derived from the **ten data sections only** —
`instrument` is metadata and excluded (see
`METADATA_SECTIONS` in `freshness.ts`). Rules:

- every data section `fresh` → `fresh`
- every data section `unavailable` → `unavailable`
- every data section `stale` → `stale`
- mixed statuses → `partial`

A snapshot with only the `instrument` section populated is therefore
`unavailable`, not `fresh`.

## Freshness policy

Per-section TTLs (Phase 1 defaults, tuned to realistic upstream
cadence, not desired refresh rate):

| Section        | TTL     |
| -------------- | ------- |
| `instrument`   | ∞ (metadata, never stales) |
| `price`        | 30 s    |
| `technical`    | 5 min   |
| `macro`        | 15 min  |
| `crossAsset`   | 5 min   |
| `positioning`  | 7 days  |
| `flows`        | 24 h    |
| `inventory`    | 24 h    |
| `calendar`     | 6 h     |
| `news`         | 15 min  |
| `brokerState`  | 30 s    |

Overrides:

- **Per-builder:** pass a `FreshnessPolicy` (typically built via
  `mergeFreshnessPolicy(DEFAULT_FRESHNESS_POLICY, {...})`).
- **Per-provider:** a provider may set `freshnessTtlMs` to shrink or
  extend the TTL just for its contribution. Useful when one provider
  serves data known to be more reliable than others in the same
  section.

Freshness is classified from the provider-reported `observedAt`
(never from wall clock at fetch time), so cached upstream data with
an older timestamp is correctly flagged.

## Provider API

```ts
interface MarketContextProvider<K extends MarketContextSectionKey> {
  readonly id: string;
  readonly section: K;
  readonly timeoutMs: number;          // hard cap per load()
  readonly freshnessTtlMs?: number;    // optional per-provider TTL override
  supports(instrument: Instrument): boolean;
  load(input: ProviderLoadInput): Promise<SectionLoadResult<K>>;
}
```

### Provider rules

Providers MUST NOT:

- place, modify or cancel orders,
- talk to the execution-engine,
- persist state anywhere the builder is not aware of,
- throw for expected upstream failures — return a rejected promise
  instead so the builder can isolate and surface it.

Each provider owns exactly **one** section. Multi-section behaviour is
composed by supplying multiple providers, not by returning a wider
payload from one provider.

### Test providers

The module ships three test doubles for exercising the builder and
downstream integration tests:

- `StaticMarketContextProvider` — resolves immediately with a fixed
  `SectionLoadResult`.
- `FailingMarketContextProvider` — always rejects.
- `DelayedMarketContextProvider` — resolves after `delayMs`.

## Builder contract

```ts
new MarketContextBuilder({ registry, providers, freshnessPolicy?, now? })
  .build({ instrumentId, now?, validityMs? })
  .then((snapshot: MarketContextSnapshot) => ...)
```

Guarantees:

- Runs every supported provider **in parallel** — total build time is
  approximately the slowest provider, not the sum.
- Enforces `provider.timeoutMs` per call. Timed-out providers produce
  an `unavailable` section plus a warning; the underlying promise is
  left to complete/reject in the background (never awaited a second
  time).
- **Isolates provider errors.** A single rejection produces an
  `unavailable` section plus a warning and is recorded at snapshot
  level — never a build-level throw.
- **Throws only for configuration/lookup errors:**
  - unknown `instrumentId` (delegated to
    `InstrumentRegistry.getInstrumentOrThrow`),
  - missing `registry` at construction time.
- **First provider wins on section collision.** If two providers
  claim the same section, the first successful resolution keeps the
  slot; every subsequent success is discarded and recorded as a
  snapshot-level warning.
- Populates the `instrument` section directly from the registry — no
  provider is required.
- Returns a **deep-frozen** snapshot.
- `validUntil = generatedAt + validityMs`, where the default
  `validityMs` is `min(ttl)` across sections that currently hold
  data; `0` when no data section is populated.

## Registry integration

The `instrument` section is auto-populated from the
`InstrumentRegistry` supplied at construction time
(`packages/shared/src/instruments/`). Fields copied:

`id`, `displayName`, `assetClass`, `broker`, `brokerSymbol`,
`exchange`, `currency`, `primaryExchange`, `conId`, `localSymbol`,
`tradingClass`, `session.sessionTemplate`, `risk.quantityUnit`.

The section is marked `source: "instrument-registry"` and `status:
"fresh"` unconditionally for a known instrument.

## Future work (not in PR6)

The following are deliberately out of scope for this PR and left for
follow-up work:

- Real providers backed by ingestion (`price`, `technical`),
  execution-engine (`brokerState`), MarketAux (`news`), a macro data
  source (`macro`, `crossAsset`), CFTC (`positioning`), ETF flow
  vendors (`flows`), COMEX/LBMA/SHFE (`inventory`), and an economic
  calendar (`calendar`).
- Consumer migration — the `MarketRegimeDetector` in `signal-engine`
  is expected to consume `MarketContextSnapshot.sections.technical`
  once a real technical provider exists.
- Snapshot persistence / caching (Redis or Postgres); Phase 1 assumes
  callers build snapshots on demand.
- Decision Engine wiring — the snapshot is the *input* to a future
  Decision Engine, which is out of scope here.
