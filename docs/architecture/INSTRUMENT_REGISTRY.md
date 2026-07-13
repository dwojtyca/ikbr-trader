# Instrument Registry

> **Status:** implemented in `packages/shared/src/instruments/`.
> **Consumers:** none yet — the registry is intentionally introduced
> ahead of any migration so the surface can be reviewed in isolation.
> Execution-engine / signal-engine / backtest migration will follow in a
> separate PR.

## 1. Purpose

The Instrument Registry is the **single source of truth** for every
tradable instrument in the platform. It centralises:

- broker contract identity (symbol, exchange, currency, conId, trading
  class, local symbol, …)
- per-instrument feature flags (trading, signal generation, AI analysis,
  monitoring)
- per-instrument risk envelope (position size cap, spread/slippage
  ceilings, overnight policy, leverage cap)
- session profile (RTH-only flag, IANA timezone, named session template)
- futures roll policy (strategy + calendar offset)
- metadata for search / grouping (tags, sector, description)

Every module that today keeps its own list of symbols — the ingestion
watchlist, the strategy filters, the backtest universe, hardcoded
contract stubs in `tws-execution-client` — is a future consumer of this
registry.

**Registry additions must go through the definitions file. No process is
allowed to hold or synthesise instruments outside the registry.**

## 2. Architecture

```mermaid
flowchart LR
  DEF[definitions.ts<br/>readonly Instrument[]] --> REG[InstrumentRegistry]
  REG -->|getInstrument| EXEC[execution-engine]
  REG -->|listSignalEnabled| SIG[signal-engine]
  REG -->|listMonitoringEnabled| ING[ingestion]
  REG -->|listAiEnabled| LLM[llm-agent]
  REG -->|listAll| UI[ui]
  REG -->|listAll| BT[backtest-engine]
```

- Definitions live in
  [packages/shared/src/instruments/definitions.ts](../../packages/shared/src/instruments/definitions.ts)
  as an ordered `readonly Instrument[]`.
- `InstrumentRegistry` (in
  [packages/shared/src/instruments/registry.ts](../../packages/shared/src/instruments/registry.ts))
  is instantiated once at module load as `defaultInstrumentRegistry`.
- Type contracts are in
  [packages/shared/src/instruments/types.ts](../../packages/shared/src/instruments/types.ts).
- Everything is re-exported through
  [packages/shared/src/index.ts](../../packages/shared/src/index.ts).

The registry is pure data + O(1) lookups: no I/O, no side effects, no
broker calls. Broker adapters translate registry output into their own
contract representations, **never** the other way around.

## 3. Responsibilities

### 3.1 What the registry OWNS

- Canonical `Instrument` shape and asset-class taxonomy.
- Uniqueness invariants (id, full `BrokerContractKey` tuple).
- Structural invariants (futures must have `roll`, non-futures must not).
- Lookup surface (`getInstrument`, `getByBrokerSymbol` →
  `readonly Instrument[]`, `getByBrokerContract(key)` → single match,
  list filters).
- Compile-time-safe access to per-instrument flags.
- **Runtime immutability** (deep-freeze) so a rogue consumer cannot
  corrupt the registry graph shared with everyone else.

### 3.2 What the registry does NOT do

- **Contract resolution against IBKR.** `conId` may be pre-populated in
  a definition, but registry does not call `reqContractDetails`.
  Broker adapters resolve missing fields at runtime.
- **Session-window computation.** `sessionTemplate` is a label; the
  Market Context Engine (planned) resolves it to concrete open/close
  timestamps.
- **Risk enforcement.** `risk.maxPositionSize` etc. are the *policy*;
  the Risk Engine enforces them.
- **Persistence.** The registry is in-memory only. Definitions live in
  source; a database-backed catalogue is out of scope for Phase 1.
- **Runtime mutation.** Instruments are `readonly`. Flags cannot be
  toggled through the registry API.

## 4. Public API

```ts
import {
  defaultInstrumentRegistry,
  type Instrument,
  type BrokerContractKey,
} from "@ikbr/shared";

class InstrumentRegistry {
  constructor(instruments: readonly Instrument[]);

  // Lookups
  getInstrument(id: string): Instrument | undefined;
  getInstrumentOrThrow(id: string): Instrument;
  getByBrokerSymbol(broker: Broker, brokerSymbol: string): readonly Instrument[];
  getByBrokerContract(key: BrokerContractKey): Instrument | undefined;

  // Filtered lists (returned snapshots are frozen)
  listAll(): readonly Instrument[];
  listExecutionEnabled(): readonly Instrument[];
  listSignalEnabled(): readonly Instrument[];
  listMonitoringEnabled(): readonly Instrument[];
  listAiEnabled(): readonly Instrument[];
}
```

- `getInstrument` returns `undefined` on miss. Use
  `getInstrumentOrThrow` in bootstrap paths where a missing id is a
  programming error.
- `getByBrokerSymbol` returns a **frozen list of every match**. Futures
  roots (e.g. `SI`, `ES`) are shared across expirations, so a single
  broker symbol legitimately maps to N contracts. Missing symbol → the
  same frozen empty array on every call.
- `getByBrokerContract(key)` returns the **single** instrument matching
  a fully-qualified `BrokerContractKey`. Every disambiguator on the key
  (`conId`, `localSymbol`, `tradingClass`) must match exactly. Missing
  on both key and definition also counts as a match, which lets the
  registry model "root front-month" entries with no calendar override.
- `getByBrokerSymbol` (and every list method) is **case-sensitive** on
  the broker symbol. Broker symbols are canonicalised at definition
  time; callers should pass exactly what the broker returned.
- All list methods return references to frozen arrays cached at
  construction time. They are safe to iterate hot-path without
  triggering allocation.

### 4.1 `BrokerContractKey`

```ts
interface BrokerContractKey {
  broker: Broker;              // "ibkr"
  brokerSymbol: string;        // "SI"
  exchange: string;            // "COMEX"
  currency: string;            // "USD"
  tradingClass?: string;       // rarely needed for futures/stocks
  localSymbol?: string;        // "SIZ26"
  conId?: number;              // 651111111
}
```

`(broker, exchange, currency, brokerSymbol, tradingClass, localSymbol, conId)`
is the **registry uniqueness tuple**. Two definitions colliding on the
whole tuple throw at construction time; any difference in `conId`,
`localSymbol` or `tradingClass` is a legitimate multi-contract entry
(e.g. front-month + back-month silver).

## 5. `Instrument` shape

Full contract in
[types.ts](../../packages/shared/src/instruments/types.ts). Grouped:

```ts
interface Instrument {
  // Identity
  id: string;                // unique registry id, e.g. "gc_front"
  displayName: string;
  assetClass: AssetClass;    // "future" | "stock" | "etf" | "index" | "forex" | "option" | "crypto"

  // Broker contract
  broker: Broker;            // "ibkr"
  brokerSymbol: string;      // symbol used by the broker (e.g. "GC")
  exchange: string;
  currency: string;
  primaryExchange?: string;
  conId?: number;
  localSymbol?: string;
  tradingClass?: string;

  // Feature flags
  trading: {
    executionEnabled: boolean;
    signalGenerationEnabled: boolean;
    aiAnalysisEnabled: boolean;
    monitoringEnabled: boolean;
  };

  // Risk envelope
  risk: {
    // Integer count — NOT a notional dollar value.
    // For futures: number of contracts. For equities: number of shares.
    maxQuantity: number;
    quantityUnit: "contracts" | "shares";
    maxLeverage: number;
    allowOvernight: boolean;
    maxSpread: number;
    maxSlippage: number;
  };

  // Session
  session: {
    useRegularTradingHours: boolean;
    timezone: string;        // IANA
    sessionTemplate: SessionTemplate;
  };

  // Roll — required iff assetClass === "future"
  roll?: {
    rollStrategy: "none" | "calendar" | "volume_and_oi";
    rollDaysBeforeExpiry: number;
  };

  // Metadata
  metadata: {
    tags: readonly string[];
    sector?: string;
    description?: string;
  };
}
```

## 6. Invariants (enforced at construction)

The `InstrumentRegistry` constructor throws on any of the following:

1. **Duplicate `id`** across definitions.
2. **Duplicate `BrokerContractKey` tuple** — the full
   `(broker, exchange, currency, brokerSymbol, tradingClass, localSymbol, conId)`
   must be unique. Two definitions sharing only `brokerSymbol` (e.g.
   two `SI` futures with different `localSymbol`) are allowed.
3. **Future without `roll`** — a `future` asset class must specify how
   it rolls, even if `rollStrategy === "none"`.
4. **Non-future with `roll`** — guards against copy-paste bugs where an
   equity accidentally inherits a futures roll policy.

Because the singleton is constructed at module load, any of these
errors surface **at boot**, not at trade time.

### 6.1 Runtime immutability (deep-freeze)

The `readonly` markers on `Instrument` are TypeScript-only and disappear
at runtime. To guarantee that a shared reference cannot be mutated by
one consumer and corrupt another's view, the constructor:

1. **Defensively clones** each input (including every nested section:
   `trading`, `risk`, `session`, `roll`, `metadata`, plus a fresh copy
   of `metadata.tags`). Post-construction mutation of the source
   literal has no effect on the registry.
2. **Deep-freezes** the clone: `Object.freeze` is applied to the
   instrument, every section object, and the `metadata.tags` array.
   Any assignment to a nested field or array push in strict mode
   throws `TypeError`.

The seed catalogue is `export const INSTRUMENT_DEFINITIONS: readonly
Instrument[]`, so the registry's cloned copies are the only mutable
graph — and it freezes them before returning any reference.

## 7. Seed catalogue (Phase 1)

`INSTRUMENT_DEFINITIONS` ships six IBKR futures:

| id         | Symbol | Exchange | Currency | Class      | Session template   |
| ---------- | ------ | -------- | -------- | ---------- | ------------------ |
| `si_front` | SI     | COMEX    | USD      | metal      | `cme_metals`       |
| `gc_front` | GC     | COMEX    | USD      | metal      | `cme_metals`       |
| `pl_front` | PL     | NYMEX    | USD      | metal      | `cme_metals`       |
| `hg_front` | HG     | COMEX    | USD      | metal      | `cme_metals`       |
| `es_front` | ES     | CME      | USD      | equity idx | `cme_equity_index` |
| `nq_front` | NQ     | CME      | USD      | equity idx | `cme_equity_index` |

All six ship with:

- `trading.executionEnabled = false` — the registry cannot, by itself,
  cause an order to be sent. Operators must opt in per instrument.
- `trading.signalGenerationEnabled = true`
- `trading.aiAnalysisEnabled = true`
- `trading.monitoringEnabled = true`
- `roll = { rollStrategy: "calendar", rollDaysBeforeExpiry: 7 }`

## 8. Extending the registry

### 8.1 Adding a new instrument

1. Append an `Instrument` literal to
   [definitions.ts](../../packages/shared/src/instruments/definitions.ts).
2. Choose an id: `<broker-symbol-lowercase>_<qualifier>`
   (e.g. `msft_us`, `si_front`, `es_dec2026`).
3. If it is a future, include a `roll` section.
4. If it is anything else, do **not** include a `roll` section.
5. Run `pnpm --filter @ikbr/shared test` and
   `pnpm --filter @ikbr/shared build` — both invariant violations and
   type mismatches surface here.

### 8.2 Adding a new asset class

1. Extend `AssetClass` in
   [types.ts](../../packages/shared/src/instruments/types.ts).
2. If the asset class needs a roll-like periodicity, extend the
   invariant in `InstrumentRegistry.#assertRollInvariant`.
3. Add a definition + regression test.

### 8.3 Adding a new broker

1. Extend `Broker` in
   [types.ts](../../packages/shared/src/instruments/types.ts).
2. Add a broker adapter that consumes registry output.
3. Registry lookups already namespace by broker, so mixed-broker
   catalogues work out of the box.

### 8.4 Adding a new session template

1. Extend `SessionTemplate` in
   [types.ts](../../packages/shared/src/instruments/types.ts).
2. Resolve the template in the Market Context Engine (planned) — the
   registry stores only the label.

## 9. Example: reading a definition

```ts
import { defaultInstrumentRegistry } from "@ikbr/shared";

// By registry id
const gold = defaultInstrumentRegistry.getInstrumentOrThrow("gc_front");
console.log(gold.brokerSymbol, gold.exchange); // "GC" "COMEX"

// By broker symbol — returns every contract sharing the symbol
// (front-month, back-month, ...). Case-sensitive.
const esContracts = defaultInstrumentRegistry.getByBrokerSymbol("ibkr", "ES");
for (const es of esContracts) {
  if (es.trading.executionEnabled) {
    // route to execution-engine
  }
}

// By fully-qualified contract key — exact single match.
const siFront = defaultInstrumentRegistry.getByBrokerContract({
  broker: "ibkr",
  brokerSymbol: "SI",
  exchange: "COMEX",
  currency: "USD",
});

// Ingestion watchlist:
for (const instrument of defaultInstrumentRegistry.listMonitoringEnabled()) {
  // subscribe to market data by instrument.brokerSymbol / instrument.exchange
}
```

## 10. Non-goals (deferred)

- **Contract-detail refresh (`reqContractDetails`).** The broker adapter
  resolves missing `conId` / `minTick` at runtime; the registry does
  not.
- **Session-window resolution.** Owned by the future Market Context
  Engine.
- **Database persistence** of the catalogue.
- **Runtime toggling of feature flags** (e.g. via UI). If needed, this
  will be layered as an **operator override table** on top of the
  registry; the registry itself remains an immutable defaults source.
- **Execution-engine migration.** A separate PR replaces the current
  hardcoded contract stubs with registry lookups.
