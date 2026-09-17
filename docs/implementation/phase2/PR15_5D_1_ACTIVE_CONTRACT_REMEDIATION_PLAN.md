# PR15.5D.1 — Active-contract projection remediation — PLAN

Status: owner-approved Stage A implemented and under final verification; Stage B
is not authorized and no new real experiment has started

Date: 2026-09-17

## 1. Goal

Correct the research-only data boundary that made the first PR15.5D attempt
terminally `INCONCLUSIVE`, then run one newly registered ES compatibility
experiment without changing the strategy, economics, dataset, roll policy, or
acceptance thresholds.

The remediation answers the same economic question as PR15.5D only after it
proves that the simulator receives the registered sequence of active futures
contracts instead of every overlapping raw contract row.

This is a new experiment, not a rerun or resume of
`pr15.5d-es-momentum-breakout-long-v1`.

## 2. Fixed baseline

- baseline commit: `fa066e5e025ee8f9309dd8d07e4c3b3eb355dd18`;
- baseline CI: run `35263493924`, green;
- failed implementation identity:
  `d833146b4a16228d364b082193b7d7ddd891f7ad`;
- terminal v1 specification SHA-256:
  `4afee9646d4f8aea18f35effca741c2cc80c82195b5519f6a88161077a65dff6`;
- terminal v1 result SHA-256:
  `efedef18335d2e471023879ea4ffe968a833928f840883f658274c2c30808a45`;
- real database: `ikbr_trader_backtest_pr15_5a` only;
- provenance: `ibkr-es-20250622-20260831-e39a59790324`;
- immutable raw fingerprint:
  `6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026`;
- raw candle SHA-256:
  `9d40e586a77c29f036cf0df270f71ef59bcd36ea3f7625941cd81c99fbef7ca3`;
- raw one-minute rows: 483,608;
- contracts: `ESU5`, `ESZ5`, `ESH6`, `ESM6`, `ESU6`.

The old experiment claim, failed run, canonical result, and result hash are
immutable audit evidence. PR15.5D.1 must neither update nor recover them into a
different state. The old endpoint must continue to expose the old terminal
artifact and reject another v1 attempt.

## 3. Root cause and bounded correction

`runResearchEsExperiment()` used the generic
`BacktestRepository.loadBacktestData(["ES"])`. That loader returns every raw
row for the symbol ordered by timestamp. The research dataset intentionally
contains overlapping outgoing and incoming contract history around rolls, so
the simulator received duplicate ES timestamps and correctly failed its
futures preflight before processing the first candle.

The correction is a research-only active-contract projector. It must not
change the generic loader or any ordinary bot/isolated backtest behavior.

For every contract, a candle is selected exactly when:

```text
candle.symbol = ES
AND candle.conid = contract.conid
AND candle.ts >= contract.valid_from
AND candle.ts <= contract.valid_to
```

The bounds are inclusive. The registered schedule remains gap-free and
non-overlapping: each next `valid_from` is exactly one minute after the prior
`valid_to`, and `roll_at` equals the next `valid_from`.

The resulting series is a sequence of active contracts with existing
per-`conId` indicator isolation. It is explicitly not a stitched,
back-adjusted, ratio-adjusted, or price-offset continuous futures series.
Indicators and warm-up restart after a roll for the incoming contract. Changing
that choice requires a different research model and a separate plan.

## 4. Frozen projection identity

The projector must produce exactly 423,300 one-minute rows with 423,300 unique
timestamps and no duplicate active row. The frozen per-contract projection is:

| conId | Contract | Rows | First selected timestamp | Last selected timestamp |
| --- | --- | ---: | --- | --- |
| `637533641` | `ESU5` | 83,463 | `2025-06-22T22:00:00.000Z` | `2025-09-15T20:59:00.000Z` |
| `495512563` | `ESZ5` | 89,223 | `2025-09-15T22:00:00.000Z` | `2025-12-15T21:59:00.000Z` |
| `649180695` | `ESH6` | 86,224 | `2025-12-15T23:00:00.000Z` | `2026-03-16T20:59:00.000Z` |
| `649180678` | `ESM6` | 88,982 | `2026-03-16T22:00:00.000Z` | `2026-06-15T20:59:00.000Z` |
| `649180671` | `ESU6` | 75,408 | `2026-06-15T22:00:00.000Z` | `2026-08-31T20:58:00.000Z` |

The observed contract transitions are exactly:

- `ESU5` at `2025-06-22T22:00:00.000Z`;
- `ESZ5` at `2025-09-15T22:00:00.000Z`;
- `ESH6` at `2025-12-15T23:00:00.000Z`;
- `ESM6` at `2026-03-16T22:00:00.000Z`;
- `ESU6` at `2026-06-15T22:00:00.000Z`.

The canonical active-series SHA-256 is:

`741220af6e99c90a85d73f28c5c9ab40784b91f44a2079f4bad7a50e71251411`

Its byte format is UTF-8, one LF-terminated row per selected candle, no header,
ordered by `ts ASC, conid::numeric ASC`, with tab-separated fields:

```text
symbol
conid
timestamp as YYYY-MM-DDTHH:mm:ss.SSSZ
open_ticks
high_ticks
low_ticks
close_ticks
volume_units
```

The fields above are on one line in the listed order. The final line also ends
with LF. Numeric tick and volume fields use their exact stored decimal text;
there is no floating-point price formatting in this hash.

### Known omissions and inactive-only raw timestamps

The CME calendar contains 423,360 expected active-contract minutes. The
projection contains 423,300, so 60 active minutes are absent. Completeness is
99.9858276643991%, the maximum consecutive gap is one minute, and no open
session is entirely missing. The exact missing pattern is bound by the raw
fingerprint and active-series hash.

The immutable raw table has 423,306 distinct timestamps. At six of the 60
missing active minutes, an inactive-contract raw row exists even though the
active-contract candle is absent:

- `2025-09-04T13:30:00.000Z`;
- `2025-09-09T13:30:00.000Z`;
- `2025-12-09T14:30:00.000Z`;
- `2026-06-03T13:30:00.000Z`;
- `2026-06-08T13:30:00.000Z`;
- `2026-06-17T20:59:00.000Z`.

PR15.5D.1 must not fill, copy, synthesize, or substitute any of the 60 missing
active candles. Their absence is already inside the approved PR15.5C.1 quality
envelope: selected-contract completeness at least 99.9%, no gap longer than
five consecutive open minutes, and no entirely missing selected-contract CME
session. The expected/present counts, maximum gap, six inactive-only raw
timestamps, and active-series hash are additional fail-closed identities. Any
difference is `INCONCLUSIVE` before a claim is created.

## 5. Higher-timeframe semantics

The research path must never read the immutable pre-aggregated 5m/1h/4h/12h/
1d/1w tables. Every higher timeframe is rebuilt deterministically from the
verified 423,300-row active 1m projection. A research-only simulator option or
equivalent explicit boundary must force this behavior for v2 while preserving
the current generic bot/isolated backtest behavior.

Required semantics:

- aggregate separately per `conId`; no candle may mix two contracts;
- retain the simulator's current `conId` filtering, so incoming pre-roll raw
  history is not visible and warm-up restarts after each roll;
- align 5m, 1h, 4h, and 12h buckets to the CME session open, not Unix epoch;
- aggregate 1d by CME trade-date session;
- aggregate 1w by CME trade week and complete it at the close of the final
  tradable session of that week;
- derive open/high/low/close/volume only from selected 1m rows;
- omit empty buckets; never fill gaps;
- expose a bucket only after its calendar-derived completion time;
- cap intraday completion at session close;
- respect DST, full closures, and early closes from the frozen calendar;
- do not expose a dataset-end partial bucket early.

`CmeSessionCalendar` and the futures aggregation helper may be extended to
cover all six higher timeframes. If `Candle.ts` alone cannot represent both a
bucket start and its safe visibility time, add an internal completion-time map
or equivalent research/simulator metadata rather than changing shared candle
meaning globally.

Although the registered strategy declares only `1m`, `1h`, `4h`, and `1d`,
the legacy `SignalEngine.runForSymbol()` fetches all six higher timeframes and
uses them while building indicators/regime context. Therefore returning stale
or raw-database 5m/12h/1w data is forbidden.

### Frozen higher-timeframe identities

Stage A must derive structural identities from the real projected 1m series
without instantiating the strategy or calculating any performance result. For
each of `5m`, `1h`, `4h`, `12h`, `1d`, and `1w`, it must record:

- canonical row count;
- canonical SHA-256;
- per-contract row counts and first/last bucket/completion timestamps.

Each canonical row is UTF-8 and LF-terminated, ordered by timeframe, bucket
start, and numeric conId, with tab-separated fields:

```text
timeframe<TAB>symbol<TAB>conid<TAB>bucket_start_utc<TAB>completed_at_utc<TAB>open_ticks<TAB>high_ticks<TAB>low_ticks<TAB>close_ticks<TAB>volume_units
```

Timestamps use `YYYY-MM-DDTHH:mm:ss.SSSZ`; numeric fields use exact decimal
text. Each timeframe is hashed separately, including the final LF.

The first implementation pass calculates these values through the production
pure aggregator during the read-only Stage A preflight. The values are then
inserted into the registered v2 specification and tests. The full preflight is
rerun and must reproduce every count/hash before the Stage A commit. The final
v2 specification hash therefore binds the complete real input view consumed by
SignalEngine, not merely the 1m source and an algorithm version.

Until all six real-data identities are frozen, `BACKTEST_RESEARCH_IMPLEMENTATION_SHA`
stays empty and the v2 POST must be unavailable. Stage B additionally rederives
and verifies these identities before claim and after scenario execution. Any
HTF mismatch is `INCONCLUSIVE`; it cannot be resolved by selecting the better
result or changing aggregation after seeing performance.

## 6. Architecture and implementation scope

### Research-only projector

Add a dedicated module, expected as
`apps/backtest-engine/src/research-active-contract-projector.ts`, that:

- opens the fixed research database with `search_path=public`;
- reads in a read-only, repeatable-read transaction;
- validates the already registered dataset/manifest identity;
- streams raw 1m rows in deterministic order;
- selects only rows inside their own contract validity window;
- computes the canonical active-series hash and audit summary;
- returns immutable selected 1m rows plus projection evidence, with no
  pre-aggregated database timeframe content;
- performs no INSERT, UPDATE, DELETE, TRUNCATE, DDL, broker, HTTP, or file I/O.

The general `BacktestRepository.loadBacktestData()` remains unchanged.

Add or extend one pure CME aggregation helper for 5m/1h/4h/12h/1d/1w. The v2
research simulator path uses that helper to derive every higher timeframe from
the projected 1m rows and must reject any attempt to fall back to database
aggregates. Existing generic futures behavior remains unchanged unless covered
by explicit parity tests; PR15.5D.1 is not a generic backtest migration.

### Fail-closed projection checks

Before any experiment claim:

1. the contract schedule must match the registered five-contract manifest and
   contain exactly one active contract definition for every minute in range;
2. no selected timestamp may contain more than one candle;
3. every selected row must match its active contract and validity bounds;
4. timestamps must be strictly increasing and contract IDs may transition only
   in the registered order, never reappear, and switch at the registered roll;
5. exact expected/present totals, per-contract counts, first/last timestamps,
   60 calendar-derived missing active minutes, maximum gap, six inactive-only
   raw timestamps, and canonical active-series hash must match section 4;
6. calendar session, last-trade, tick-grid, multiplier, and currency checks
   must still pass;
7. every higher-timeframe count, hash, per-contract count, and first/last
   bucket/completion timestamp must match the frozen v2 specification;
8. the original raw fingerprint must match before projection and after every
   scenario;
9. no existing v1 experiment row or artifact may change.

The exact 60 calendar-derived missing active minutes are permitted only under
the frozen quality identity in section 4; six of them also have an inactive-only
raw row and are pinned separately. Any additional/different omission,
duplicate active candle, schedule ambiguity, 1m/HTF hash mismatch, or count
mismatch fails before claim.

### Versioned experiment boundary

Use a new identity:

`pr15.5d1-es-momentum-breakout-long-v1`

Add a new schema/spec version and a new canonical result version. Preserve the
v1 request/result implementation sufficiently to reproduce and expose its
existing canonical artifact. If common code is extracted, parity tests must
prove the v1 request hash and terminal result hash remain byte-for-byte
unchanged.

The v2 specification contains every frozen PR15.5D input plus:

- active projection policy/version;
- raw row count;
- projected total and per-contract counts;
- 60-missing-minute count, maximum gap, and six inactive-only raw timestamps;
- active-series SHA-256;
- higher-timeframe aggregation/completion policy version;
- per-timeframe canonical counts and SHA-256 values for 5m through 1w;
- per-timeframe/per-contract counts and first/last bucket/completion times.

The strategy parameters, risk values, execution economics, scenarios, date
range, contracts, calendar, roll policy, and acceptance gates remain exactly
those in PR15.5D. No observed performance value may be used to change them.

Prefer a distinct endpoint such as:

`POST /backtest/research/es-compatibility-v2`

with a matching GET status endpoint. It accepts only the exact new request.
The old endpoint remains bound to the v1 artifact. Both endpoints remain
research-database-only.

The route order is:

```text
strict v2 request validation
-> process-local reservation
-> raw dataset identity verification
-> full active projection verification
-> atomic PostgreSQL claim for the new experiment ID
-> primary
-> stress
-> primary reproduction
-> canonical result
```

The reservation is reset if identity/projection preflight fails, without a
durable claim. The verified immutable projection is passed directly to all
three scenarios. The runner must not call the generic loader. The existing
advisory lock plus durable primary key must permit exactly one new claim across
processes.

Startup recovery must be version-aware. It may recover an abandoned v2 claim
only after proving the former lock owner is gone. It must never rewrite the
finished v1 claim or attribute v2 work to the v1 implementation/specification.

## 7. Frozen economic experiment

PR15.5D.1 preserves the PR15.5D experiment verbatim:

- strategy: `momentum_breakout_long_v1`, research-only FUT adapter;
- direction: long only;
- starting equity: USD 100,000;
- target/max risk per trade: 0.50%;
- maximum open positions: 1;
- research exposure/notional ceiling: 400%;
- multiplier 50, tick size 0.25;
- primary commission USD 2.50 per contract per side and 1 tick slippage;
- stress commission USD 3.50 per contract per side and 2 ticks slippage;
- same-bar collision: stop wins;
- limit-entry mode: touch;
- TTL: 2 one-minute candles;
- cooldown: 12 hours;
- minimum warm-up: 220 candles;
- synthetic spread: 2 bps, maximum 12 bps;
- minimum confidence: 0.55;
- volume filter off, minimum-stop overlay 0 bps, entry buffer 0 bps;
- no pyramiding, no fractional quantity, USD base, no FX conversion.

The acceptance gates also remain unchanged: at least 30 closed primary trades,
positive primary net P&L, primary profit factor at least 1.20, primary mean net
expectancy above zero, drawdown no worse than USD -10,000, positive stress net
P&L, stress profit factor at least 1.05, no lifecycle residue or invariant
violation, no permanent strategy disablement, unchanged data identity, and an
identical primary reproduction.

## 8. Tests

### Unit tests

Add tests for:

- inclusive `valid_from`/`valid_to` boundaries and the one-minute handoff;
- genuine outgoing/incoming raw overlap before and after a roll;
- inactive contract prices and volume never affecting any projected timeframe;
- strict ordering, unique selected timestamps, exact transition order, and no
  retired-contract reappearance;
- unknown contract, overlapping schedule, multiple selected active rows, extra
  omission, wrong count, wrong hash, and wrong per-contract boundary failing;
- the 60-missing-minute count, one-minute maximum gap, and six inactive-only
  raw timestamps passing only under the frozen quality envelope;
- deterministic active-series hashing independent of database page size;
- deterministic HTF hashes independent of database page size and map/row
  insertion order;
- OHLCV correctness and `conId` isolation for 5m/1h/4h/12h/1d/1w;
- CME-session bucket alignment, DST, holiday, early close, weekly completion,
  roll boundary, and dataset-end partial-bucket visibility;
- warm-up reset after roll and absence of incoming pre-roll context;
- generic backtest loader behavior remaining unchanged;
- old v1 request/result hashes remaining unchanged;
- exact v2 request identity and every mismatch failing before claim;
- economic assumptions and acceptance gates matching PR15.5D exactly.

### Disposable PostgreSQL integration

The execution fixture must contain both contracts at the same timestamps on
both sides of a roll. It must prove:

- raw overlap is preserved in immutable tables;
- projection yields one ordered active row per available active minute;
- exact selection and roll boundaries are correct;
- all higher timeframes exclude inactive values and obey completion times;
- raw and active-series hashes are unchanged before and after execution;
- projection failures create no v2 experiment or run row;
- primary, stress, and reproduction each complete once;
- deterministic reproduction, orders, fills, commissions, slippage, roll
  exits, diagnostics, and terminal artifact remain auditable;
- concurrent POSTs create exactly one v2 claim;
- abandoned v2 recovery is safe and leaves v1 unchanged;
- the old v1 claim/artifact remains byte-for-byte unchanged and does not block
  the new experiment ID;
- a global network trap proves no IBKR, execution-engine, llm-agent, broker, or
  external HTTP access.

### Real-dataset Stage A preflight

Before a Stage A commit, run the production projector read-only against the
real research database and verify only structural evidence from sections 2–5.
Do not instantiate the strategy, create a claim/run, calculate P&L, or expose
trade counts. The first pass must reproduce the 423,300 count and active-series
hash, calculate all six higher-timeframe identities, and freeze them in the v2
specification. A second clean pass must reproduce the complete frozen 1m and
HTF identity set exactly.

## 9. Staged execution and approvals

### Stage A — remediation only

1. implement the versioned projector, aggregation/completion logic, v2
   request/result boundary, route, recovery, and tests;
2. preserve all v1 evidence and production strategy boundaries;
3. run the synthetic and disposable-PostgreSQL suites;
4. run the read-only real-dataset structural preflight, freeze every HTF
   identity in the v2 specification, then rerun the preflight against those
   frozen identities;
5. run all repository quality gates;
6. perform an independent hostile review;
7. commit and obtain green CI;
8. record the exact implementation commit SHA and derived v2 specification
   SHA-256 in a Stage A report;
9. stop.

Approval of this plan authorizes Stage A only.

### Stage B — one new operational experiment

Stage B requires a separate owner approval naming the exact Stage A commit and
v2 specification hash. After approval:

1. prove HEAD and the built image contain the approved implementation;
2. prove v1 durable evidence is unchanged;
3. verify raw and projected identities before claim;
4. send exactly one v2 POST;
5. run primary, stress, and primary reproduction exactly once;
6. verify raw and projected identities after each scenario;
7. persist the canonical result and result SHA;
8. perform a second independent hostile review;
9. update the decision record, report, and roadmap;
10. stop before activation.

An interrupted v2 attempt may be recovered only from its durable state under
the existing lock rules. A terminal failed attempt is not resumable or
rerunnable. Another attempt would require another new experiment identity,
plan, specification hash, implementation identity, and approval.

## 10. Required gates

```text
pnpm --filter @ikbr/signal-engine test
pnpm --filter @ikbr/backtest-engine test
pnpm --filter @ikbr/backtest-engine test:integration
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
git diff --check
```

The PostgreSQL suites must run against disposable databases. The production
database is read-only during Stage A preflight and Stage B except for new v2
run/experiment audit rows; all dataset-content tables remain immutable.

## 11. Explicit exclusions

PR15.5D.1 must not:

- change or repair any raw candle, contract, manifest, calendar, roll, or
  fingerprint data;
- fetch replacement/history data from IBKR or another provider;
- back-adjust, ratio-adjust, splice prices across contracts, or carry indicator
  history across a roll;
- tune strategy thresholds, risk, commissions, slippage, acceptance gates, or
  date range after the v1 outcome;
- modify the generic backtest loader's behavior;
- reuse, resume, delete, overwrite, or relabel the v1 attempt;
- add FUT to the production strategy/profile/registry;
- set `executionEnabled=true` or change Paper/Live configuration;
- call ingestion, execution-engine writes, llm-agent, TWS, IB Gateway, or any
  broker order API;
- begin Paper E2E, production activation, or Live readiness work.

## 12. Definition of done

PR15.5D.1 is complete only when:

- Stage A local gates, independent review, commit, and CI are green;
- the exact v2 implementation SHA and specification SHA are owner-approved;
- one authorized v2 claim produces completed primary, stress, and primary
  reproduction scenarios;
- reproduction is deterministic;
- raw and active projection identities remain unchanged;
- v1 evidence remains unchanged;
- the canonical v2 result contains exactly one permitted verdict;
- final independent hostile review approves the evidence;
- the decision record, report, and roadmap are updated;
- production FUT remains disabled and no broker operation occurred.

If the new attempt terminates `INCONCLUSIVE` before completing those criteria,
the attempt is closed and reported, but PR15.5D.1 is not described as complete.

After approval, implement Stage A only and stop at the renewed Stage B hold
point.
