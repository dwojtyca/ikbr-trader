# PR15.5C — Reproducible ES dataset foundation — IMPLEMENTATION PLAN (r1)

Status: implemented; independent hostile review approved

Date: 2026-09-15

## 1. Goal

Create an isolated, reproducible, fail-closed dataset foundation for ES
research. A finalized dataset must have a durable identity, exact contract and
calendar provenance, and a SHA-256 fingerprint that is identical after the
same source bundle is imported into a new clean database.

This PR does not run the ES compatibility experiment. It does not enable a
futures strategy, enable ES execution, contact IBKR, or perform a Paper E2E
attempt.

## 2. Prerequisite and fixed decisions

- PR15.5B is shipped as `bcf0344`; CI run `34998202271` is green.
- The only allowed research database for this stage is
  `ikbr_trader_backtest_pr15_5a`.
- `ikbr_trader_backtest` is explicitly forbidden as a PR15.5C research source
  or target.
- The durable dataset identity is `provenanceId + fingerprint`. The numeric
  PostgreSQL `datasetId` remains runtime-local and must not appear in a
  manifest or fingerprint input.
- Acquisition method 1 from PR15.5A is selected: an immutable, versioned import
  bundle. PR15.5C will not extend `HistoricalClient` and will not call IBKR.
- A new dataset version may only be imported into a new, empty, explicitly
  approved research database. The fixed database in this PR holds exactly one
  finalized dataset version and is never reset.

If an approved real ES bundle is unavailable, PR15.5C may prove the machinery
with a committed synthetic fixture, but its data-readiness verdict remains
`INCONCLUSIVE` and PR15.5D stays blocked.

## 3. Source bundle contract

The importer accepts one local directory containing exactly:

```text
manifest.json
candles-1m.ndjson
```

It performs no network access. Unknown files and unknown keys in either
supported file are rejected so that extra or misspelled input cannot silently
disappear from provenance.

### 3.1 Manifest schema

`manifest.json` is UTF-8 JSON and must contain:

- `schemaVersion`: exactly `pr15.5c-es-dataset-v1`;
- `provenanceId`: stable non-empty identifier, limited to
  `[A-Za-z0-9._-]+`;
- `instrument`: exactly `ES`;
- `timeframe`: exactly `1m`;
- `dateFrom` and `dateTo`: UTC timestamps at minute precision, inclusive;
- `source`: object with non-empty `provider`, `artifactId`, `version`, and the
  lowercase 64-hex `candlesSha256` of the exact `candles-1m.ndjson` bytes;
- `aggregationAlgorithmVersion`: exactly `research-cme-aggregate-v1`, the
  session-aligned implementation used to derive higher timeframes;
- `rollPolicy`: versioned object defining the ordered contracts, each
  contract's inclusive validity interval, and transition timestamp;
- `sessionPolicy`: `template`, `timezone`, and `calendarVersion`, which must
  resolve to the PR15.5B CME calendar configuration used during validation;
- `contracts`: the complete contract universe, with `conId`, `localSymbol`,
  `symbol`, `tradingClass`, `exchange`, `currency`, `expiry`, `lastTradeAt`,
  `validFrom`, `validTo`, `multiplier`, and `minTick`.

For v1, all contracts must be `symbol=ES`, `tradingClass=ES`, `exchange=CME`,
`currency=USD`, `multiplier="50"`, and `minTick="0.25"`. Contract validity
ranges define the selected continuous-contract series and must be ordered,
non-overlapping, and gap-free across the manifest range. Raw candles for
declared contracts may overlap around a roll; a later research loader may use
only the contract selected by the validity range at a given timestamp.
`expiry`, `lastTradeAt`, validity boundaries, and roll transitions are explicit
UTC timestamps; none may be inferred from a symbol.

### 3.2 Candle schema

Each LF-terminated NDJSON line is one JSON object with exactly these keys and
types:

```json
{"symbol":"ES","conId":"123","ts":"2026-06-01T22:00:00.000Z","openTicks":"24000","highTicks":"24004","lowTicks":"23996","closeTicks":"24001","volume":"125"}
```

- `conId` is a positive canonical base-10 integer string
  (`[1-9][0-9]*`); tick values use `0|-?[1-9][0-9]*`; volume uses
  `0|[1-9][0-9]*`.
- timestamps use exactly `YYYY-MM-DDTHH:mm:00.000Z`;
- prices are integer counts of the contract's `minTick`, never JSON floats;
- OHLC invariants, non-negative volume, strict one-minute ordering per
  contract, uniqueness of `(symbol, conId, ts)`, declared-contract membership,
  manifest range, and CME session membership are validated before a database
  write;
- each line must already be sorted by `ts` ascending and then numeric `conId`
  ascending. Non-canonical source ordering is rejected, not normalized.

Using integer ticks freezes OHLC encoding and avoids JavaScript/PostgreSQL
floating-point text differences. Database prices are derived as
`ticks * minTick`; the original ticks are also persisted for fingerprint
reconstruction.

## 4. Frozen SHA-256 canonical byte format

The dataset fingerprint is SHA-256 over the following UTF-8 byte stream. Every
record ends with a single LF byte (`0x0A`); CRLF and a missing final LF are not
canonical.

1. Literal header:
   `IKBR-TRADER-ES-DATASET-FINGERPRINT-V1\n`
2. One dataset JSON record.
3. Contract JSON records sorted by numeric `conId` ascending.
4. Candle JSON records sorted by `ts` ascending, then numeric `conId`
   ascending.

Records are produced with `JSON.stringify` from objects constructed in the
exact key order below. There is no whitespace outside JSON strings, no BOM,
and no Unicode normalization. All schema strings are restricted to printable
ASCII, so equivalent Unicode spellings cannot hash differently.

Dataset record key order:

```text
type, schemaVersion, provenanceId, instrument, timeframe, dateFrom, dateTo,
sourceProvider, sourceArtifactId, sourceVersion, sourceCandlesSha256,
aggregationAlgorithmVersion, rollPolicyVersion, sessionTemplate,
sessionTimezone, calendarVersion
```

Contract record key order:

```text
type, conId, localSymbol, symbol, tradingClass, exchange, currency, expiry,
lastTradeAt, validFrom, validTo, rollAt, multiplier, minTick
```

The final contract has `rollAt:null`; all other `rollAt` values equal the next
contract's `validFrom`. Timestamp strings retain exactly UTC millisecond
precision (`.000Z`). Decimal contract values are canonical positive decimal
strings with no exponent, leading plus, leading zero, or trailing fractional
zero; therefore ES is exactly `"50"` and `"0.25"`.

Candle record key order:

```text
type, symbol, conId, ts, openTicks, highTicks, lowTicks, closeTicks, volume
```

All record values are strings except `rollAt`, which may be `null`. Numeric
`datasetId`, import timestamps, database names, derived aggregates, and the
fingerprint itself are excluded. The source file checksum is included as the
manifest's `sourceCandlesSha256`; the dataset fingerprint is a separate hash
over the normalized semantic records above.

The fingerprint is lowercase hexadecimal. Import finalization recomputes it
from rows read back from PostgreSQL using the same canonical encoder and
requires equality with the pre-import value before committing.

## 5. Database isolation and lifecycle

Add a dedicated configuration value for the research database URL. Before
database creation, schema initialization, import, reset, history fetch, or any
other dataset write, parse the URL and require the exact database name
`ikbr_trader_backtest_pr15_5a`. Reject an empty, malformed, shared, or
differently named database before opening a mutating connection.

The research database lifecycle is:

```text
absent/empty -> importing -> ready + finalized_at + fingerprint
```

- Import preflight verifies the database identity, empty-state invariant,
  source file checksum, complete manifest, contracts, candles, calendar
  coverage, and canonical ordering before `BEGIN`.
- One transaction inserts the dataset metadata, contracts, canonical 1m rows,
  derived higher-timeframe rows, and final fingerprint.
- Any error rolls back the whole transaction. A rejected import leaves no
  dataset, contract, candle, aggregate, or fingerprint row.
- Finalization is a one-way transition. `failed -> resume`, fingerprint
  invalidation, top-up, replacement, reset, and a second import are forbidden.
- Existing `/backtest/history`, `/backtest/history/symbols`, and
  `/backtest/history/resume` never create or mutate PR15.5C research data. If
  the server is configured against the protected research database, these
  routes return a fail-closed response before calling a repository write.
- The existing mutable `ikbr_trader_backtest` flow remains available only for
  non-research use and can never be accepted by the research importer/loader.

Database-level guards protect finalized dataset content from `INSERT`,
`UPDATE`, `DELETE`, and `TRUNCATE`, including direct repository calls. Protected
content comprises dataset metadata, 1m candles, all derived candle tables, FX
rates, instrument contracts, and futures contract metadata. Backtest run,
order, fill, state, and diagnostic tables are not dataset content and remain
writable for a later authorized experiment.

The candle key becomes `(symbol, conId, ts)` in the clean research schema so
adjacent/overlapping contract records cannot overwrite one another. Existing
stock behavior and loading by symbol remain compatible.

## 6. Proposed implementation surface

- `apps/backtest-engine/src/research-dataset-schema.ts`
  - strict Zod schemas and semantic validation;
  - no DB, network, or server boot.
- `apps/backtest-engine/src/research-dataset-fingerprint.ts`
  - frozen canonical record encoder and streaming SHA-256;
  - conversion between ticks and prices;
  - no DB or server boot.
- `apps/backtest-engine/src/research-dataset-importer.ts`
  - local bundle read, checksum, preflight, transactional import, read-back
    verification, and finalization.
- `apps/backtest-engine/src/research-dataset-cli.ts`
  - thin CLI wiring; explicit bundle directory and research DB URL only.
- `apps/backtest-engine/src/repository.ts`
  - additive dataset provenance/fingerprint columns, canonical tick storage,
    `(symbol, conId, ts)` identity, transaction support, protected-dataset
    guards, and exact manifest/read-back queries.
- `apps/backtest-engine/src/index.ts`
  - route guard preventing mutable history operations on the protected DB;
  - no research-run endpoint in this PR.
- `apps/backtest-engine/src/types.ts`, `config.ts`, package scripts,
  `.env.example`, and Docker configuration as required for the isolated URL.
- Unit fixtures contain synthetic ES-shaped data only. Real licensed market
  data is not committed unless its redistribution terms explicitly permit it.

No new general-purpose abstraction or strategy is introduced.

## 7. Tests and acceptance criteria

Unit tests must prove:

- exact canonical bytes for the dataset, contract, and candle records;
- a fixed golden SHA-256 value;
- numeric `datasetId` cannot affect the fingerprint;
- input order changes are rejected; deterministic in-memory construction still
  produces the same fingerprint;
- candle, contract metadata, source checksum, roll policy, session policy, or
  aggregation algorithm changes each change the fingerprint;
- invalid timestamp precision, decimal/tick encoding, OHLC, duplicate key,
  contract validity, roll sequence, date range, or out-of-session candle fails;
- generic `ES` resolution and all network/IBKR acquisition paths are absent.

An isolated PostgreSQL integration suite, using disposable PostgreSQL
instances configured with the exact approved database name and never the
developer's persistent research database, must prove:

- the shared database name is rejected before mutation;
- malformed bundle rejection leaves every dataset-content table empty;
- a valid import finalizes atomically;
- re-import of the identical or modified bundle is rejected with no row change;
- every supported repository mutation and each history endpoint is rejected
  after finalization;
- direct `INSERT`, `UPDATE`, `DELETE`, and `TRUNCATE` attempts against every
  protected content table fail after finalization;
- identical imports into two clean databases produce the same fingerprint;
- changing one candle or one contract field produces a different fingerprint
  in a separate clean database;
- concurrent import attempts permit at most one finalization;
- multiple ES contracts may coexist at the same timestamp without collision;
- read-back fingerprint matches the pre-import fingerprint and manifest;
- ordinary backtest run-output tables remain writable after finalization.

Required gates:

```text
pnpm --filter @ikbr/backtest-engine test
pnpm --filter @ikbr/backtest-engine test:integration
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm test:integration
git diff --check
```

No strategy backtest is run in PR15.5C. If a real approved bundle is present,
the import command may be run only against the exact isolated database after
all tests pass; otherwise the report records `INCONCLUSIVE` and the missing
bundle as the blocker.

## 8. Hostile review requirements

An independent reviewer must specifically attack:

- database-name validation ordering and URL parsing bypasses;
- writes that evade application guards or database triggers;
- partial commits and concurrent import races;
- mutable finalized metadata or fingerprint invalidation paths;
- JSON key order, line endings, timestamps, decimal representation, sort order,
  Unicode, and source-checksum ambiguities;
- numeric `datasetId` leaking into durable identity;
- multi-contract key collisions, gaps/overlaps, roll and expiry mismatches;
- calendar coverage and out-of-session acceptance;
- shared-database or `/backtest/history*` contamination;
- accidental IBKR calls, strategy activation, or Paper execution.

All blockers must be fixed and the review repeated before the report can mark
the implementation complete.

## 9. Explicit exclusions and safety state

PR15.5C must not:

- run the PR15.5D ES compatibility experiment or interpret strategy results;
- add `FUT` to momentum strategy implementations or profiles;
- set ES `executionEnabled=true`;
- invoke `HistoricalClient`, TWS, IB Gateway, or any broker operation;
- fetch generic `ES`, infer a front contract, or silently join contracts;
- use, reset, or mutate `ikbr_trader_backtest` for research;
- commit licensed market data without verified redistribution permission;
- change production signal, risk, proposal, or execution behavior.

The existing PR15.5 activation verdict remains `blocked`, and
`executionEnabled=false` remains mandatory.

## 10. Definition of done and next step

PR15.5C is complete only when:

- the frozen schema and canonical byte contract above are implemented without
  relaxation;
- all unit, PostgreSQL integration, repository-wide, and CI gates pass;
- independent hostile review returns approved;
- `PR15_5C_REPORT.md` records the fingerprint, provenance identity, exact
  contract universe and time range when a real bundle exists, or explicitly
  records `INCONCLUSIVE` when it does not;
- the Phase 2 roadmap is updated without claiming ES compatibility.

Only a finalized real dataset with a verified `provenanceId + fingerprint`
permits preparation of a separate PR15.5D experiment plan. Otherwise the next
step is obtaining and approving an immutable ES source bundle, not enabling
trading.
