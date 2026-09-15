# PR15.5A - ES Compatibility Prerequisite for momentum_breakout_long_v1 - IMPLEMENTATION PLAN (r7)

Status: approved on 2026-09-15; implementation authorized
Date: 2026-08-17

## 0. Purpose (r7)

Purpose of PR15.5A (r7):
- execute controlled prerequisite closure based on confirmed static-audit evidence,
- record a single terminal decision,
- block unsafe or non-deterministic ES compatibility execution in current conditions.

Hard constraints (unchanged):
- `executionEnabled=false`,
- no broker operations,
- no Paper E2E,
- no execution-policy deployment.

## 1. Confirmed static-audit findings (authoritative)

The following are confirmed facts and not hypotheses:
1. `resetHistoricalData()` performs `TRUNCATE ... RESTART IDENTITY CASCADE`
   across datasets, candles, FX rates, runs, orders, fills, strategy state, and
   signal diagnostics; the separate instrument-contract table is not reset.
2. Candle tables are global and do not have `dataset_id`; PK is `(symbol, ts)`.
3. `/backtest/history/symbols` and `/backtest/history/resume` mutate an existing dataset.
4. Numeric `datasetId` is local/non-durable and can be reused after sequence reset.
5. `HistoricalClient` takes first contract detail; watchlist overrides do not support `expiry`, `lastTradeDateOrContractMonth`, `localSymbol`, `includeExpired`.
6. Current path is insufficient for deterministic acquisition and roll of many expired ES contracts.
7. Simulator handles multiplier but lacks complete futures model (futures commission per contract per side, explicit tick rounding 0.25, full expiry/roll semantics).
8. Higher-timeframe aggregation uses simple UTC buckets, not CME session boundaries/calendar.
9. `apps/backtest-engine/package.json` has no `test` script; root `pnpm test` uses `--if-present`, so backtest-engine tests are skipped now.
10. A module is not pure if it reads manifest files or queries PostgreSQL itself.

## 2. Terminal result (r7)

Confirmed critical gaps trigger the existing Critical-gap protocol.

Terminal result for current PR15.5A:
- `INCONCLUSIVE`.

In current PR15.5A, it is forbidden to:
- build a research-only seam,
- extract a shared strategy evaluator,
- run ES backtests,
- fetch ES data,
- interpret strategy outcome metrics,
- add `FUT` to production strategy support,
- run Paper E2E,
- execute broker operations.

## 3. Exact scope of current PR15.5A (controlled prerequisite closure)

Current PR15.5A includes only:
- static compatibility audit documentation,
- one consolidated report,
- one decision record with exactly `INCONCLUSIVE`,
- profile narrowing:
  - `momentum_breakout_long_v1` -> `STK`, `IND`,
  - `momentum_breakdown_short_v1` -> `STK`, `IND`,
- profile-implementation contract test,
- shared profile test,
- updates of parent status documents,
- hostile review included in the consolidated report.

Exact list of eight planned paths in current PR15.5A:
1. `docs/implementation/phase2/PR15_5A_ES_COMPATIBILITY_PLAN.md`
2. `docs/implementation/phase2/PR15_5A_REPORT.md`
3. `docs/implementation/phase2/PR15_5A_ES_DECISION_RECORD.md`
4. `docs/implementation/phase2/PR15_5_PLAN.md`
5. `docs/implementation/phase2/PHASE_2_ROADMAP.md`
6. `packages/shared/src/strategy-profiles.ts`
7. `packages/shared/src/strategy-profiles.test.ts`
8. `apps/signal-engine/src/strategies/strategy-profile-contract.test.ts`

Out of scope in current PR15.5A:
- any backtest-engine code changes,
- any data ingestion/import changes,
- any runtime strategy wiring changes,
- any production activation changes.

## 4. Required updates in parent status documents

Required update for `docs/implementation/phase2/PR15_5_PLAN.md`:
- PR15.5 activation remains `blocked`,
- PR15.5A result is `INCONCLUSIVE`,
- remove outdated action "next allowed action: create PR15.5A plan",
- set next allowed action to: prepare, review, approve `docs/implementation/phase2/PR15_5B_FUTURES_BACKTEST_MODEL_PLAN.md`,
- still no activation, no Paper E2E, no broker operations.

Required update for `docs/implementation/phase2/PHASE_2_ROADMAP.md`:
- PR15.4: `shipped 53213fe`,
- PR15.5: `blocked`,
- PR15.5A: controlled prerequisite closure with terminal `INCONCLUSIVE`,
- PR15.5B: next stage,
- PR15.5A must not be marked as shipped before implementation, tests, hostile review, and report completion.

## 5. Mandatory order of subsequent PRs

The sequence is mandatory and cannot be skipped:
1. PR15.5B futures backtest model plan and PR,
2. PR15.5C isolated reproducible ES dataset foundation plan and PR,
3. PR15.5D ES compatibility experiment plan and PR,
4. only after credible `ACCEPTED_FOR_ES`: separate production activation PR.

Planned future plan paths (do not create now):
- `docs/implementation/phase2/PR15_5B_FUTURES_BACKTEST_MODEL_PLAN.md`
- `docs/implementation/phase2/PR15_5C_ES_DATASET_FOUNDATION_PLAN.md`
- `docs/implementation/phase2/PR15_5D_ES_COMPATIBILITY_EXPERIMENT_PLAN.md`

## 6. Deferred mandatory scope for PR15.5B (futures backtest model)

PR15.5B must include:
- ES multiplier 50,
- tick size 0.25 and deterministic rounding of entry/exit/stop/target,
- quantity in whole contracts,
- futures commission per contract per side,
- explicit slippage model,
- gross/net P&L,
- CME session calendar, timezone, DST,
- overnight session handling,
- roll and expiry handling,
- roll-gap handling,
- same-bar stop/target collision,
- intra-candle ordering,
- look-ahead/leakage protection,
- unit tests and PostgreSQL integration tests.

Rule:
- this model remediation is not allowed in current PR15.5A.

## 7. Deferred mandatory scope for PR15.5C (dataset foundation)

PR15.5C must include:
- dedicated DB name fixed now: `ikbr_trader_backtest_pr15_5a`,
- strict ban on using `ikbr_trader_backtest`,
- fail-closed preflight validating DB name before reset/import/fetch,
- no `/backtest/history*` on shared DB,
- finalized dataset is unconditionally immutable,
- all write endpoints/methods fail-closed and reject mutation of finalized dataset,
- fingerprint invalidation to continue writing is forbidden,
- new dataset version requires a new clean isolated DB/dataset version,
- resetting finalized research DB is forbidden,
- integration test must prove no partial write after rejection,
- manifest must not use numeric `datasetId` as durable identity,
- numeric `datasetId` is runtime-local only,
- durable identity is `provenanceId` + `fingerprint`,
- manifest must include:
  - exact contract universe,
  - `conId`,
  - `localSymbol`,
  - `expiry`,
  - contract validity ranges,
  - roll policy,
  - session policy,
  - source,
  - time range,
  - aggregation algorithm version.

Fingerprint requirements for PR15.5C:
- SHA-256,
- input includes dataset metadata, contract metadata, and all 1m candles,
- contracts and candles sorted deterministically,
- timestamps encoded in UTC,
- before implementation, PR15.5C plan must freeze exact canonical byte format,
- that specification must define exact record/key order, UTC timestamp precision, and exact OHLCV encoding,
- phrase "deterministic encoding" alone is insufficient,
- SHA-256 excludes numeric `datasetId`,
- identical import into clean DB must produce identical fingerprint,
- any candle or contract metadata change must change fingerprint,
- research endpoint must reject non-finalized/non-ready datasets and fingerprint mismatches,
- PR15.5C implementation cannot start before acceptance of exact fingerprint specification.

## 8. Deterministic ES acquisition blocker (deferred to PR15.5C)

Confirmed blocker:
- current `HistoricalClient` cannot be used for deterministic multi-contract ES acquisition without separate remediation.

PR15.5C must choose exactly one method:
1. immutable versioned import source, or
2. client extension with explicit `conId`, `localSymbol`, `expiry`, `includeExpired` for each contract.

Forbidden:
- fetching generic `ES` and taking first contract detail,
- treating front contract as full history,
- mixing contracts without explicit roll policy,
- starting fetch when source and exact contracts are not approved.

If deterministic source is unavailable:
- stage result remains `INCONCLUSIVE`.

## 9. Future purity split for PR15.5D

In PR15.5D:
- `apps/backtest-engine/src/research-run-request.ts`:
  - Zod schema,
  - pure validator over arguments,
  - no file I/O,
  - no DB I/O,
  - no server boot.
- `apps/backtest-engine/src/research-dataset-loader.ts`:
  - manifest read,
  - repository access,
  - provenance/fingerprint loading.
- `apps/backtest-engine/src/index.ts`:
  - wiring only: loader -> pure validator -> scheduler.

`apps/backtest-engine/src/research-run-request.test.ts` in PR15.5D:
- fixture-based,
- no server start,
- no DB connection.

## 10. Current test requirements for profile corrections

`apps/signal-engine/src/strategies/strategy-profile-contract.test.ts` must:
- use all active profiles from `listStrategyProfiles()`,
- build implementations via local `createStrategy()`,
- validate all active profiles,
- validate every profile secType is supported by implementation secTypes,
- collect all mismatches and fail with one aggregated error,
- assert both momentum profiles do not include `ETF`, `CMDTY`, `FUT`,
- preserve dependency direction (no shared -> signal-engine dependency).

`packages/shared/src/strategy-profiles.test.ts` must:
- assert exact `secType` equals `['STK', 'IND']` for both momentum profiles,
- assert `enabledInBot=true` for both,
- assert no semantic changes in remaining profiles,
- use explicit assertions (not brittle whole-file snapshots).

## 11. Current quality gates (exact commands)

Current PR15.5A gates:
- `pnpm --filter @ikbr/shared test`
- `pnpm --filter @ikbr/signal-engine test`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `git diff --check`

Gate results are recorded in:
- `docs/implementation/phase2/PR15_5A_REPORT.md`.

Backtest-engine tests remain deferred requirements of PR15.5B/PR15.5C.

## 12. Definition of Done (r7)

Current PR15.5A is done only when all are true:
- static-audit evidence documented,
- decision record contains exactly `INCONCLUSIVE`,
- no data pull and no result-producing runs,
- momentum profiles corrected to `STK` and `IND`,
- required shared and signal-engine tests for changed packages are green,
- `pnpm typecheck` passes,
- `pnpm test` passes,
- `pnpm build` passes,
- `git diff --check` passes,
- hostile review recorded,
- consolidated report completed,
- next stage explicitly set to PR15.5B,
- `executionEnabled=false` unchanged,
- no broker operations and no Paper E2E.

## 13. Status and gates (r7)

Status:
- `approved; implementation authorized`.

Gate model has three separate gates:
- Git push gate,
- CI gate,
- plan approval gate.

Satisfied evidence:
- Git push gate: `2bbc24f`, `53213fe`, and `8a2f923` are on `origin/main`,
- CI gate: GitHub Actions run `34979744641` for `8a2f923` completed with
  `success` on 2026-09-15,
- plan approval gate: approved by the project owner on 2026-09-15.

Working-tree note:
- plan documents in this track are currently untracked and require explicit add before formal handoff,
- this update does not stage or commit anything.

## 14. Final gating statement (r7)

Documented green CI and separate approval of r7 authorize only the controlled
prerequisite closure defined in section 3.

Until then, this plan does not permit:
- ES dataset acquisition,
- ES backtest execution,
- research seam implementation,
- strategy evaluator extraction,
- production activation,
- Paper E2E,
- broker operations.

## 15. Findings -> resolution (r7)

| Finding | Resolution in r7 |
| --- | --- |
| Version markers needed full update from r6 to r7 | Updated version markings in title, purpose, terminal result, DoD, final gating statement, and findings section. |
| Controlled closure wording was inconsistent with real scope | Replaced documentation-only/closure phrasing with controlled prerequisite closure language matching docs + profile + tests scope. |
| Report artifacts were fragmented | Consolidated reporting into `docs/implementation/phase2/PR15_5A_REPORT.md` and kept separate `docs/implementation/phase2/PR15_5A_ES_DECISION_RECORD.md`. |
| Current PR file list needed exact closed set | Defined exact list of eight current PR15.5A paths and removed non-required roadmap path from that list. |
| Parent status docs needed explicit update directives | Added exact update requirements for `docs/implementation/phase2/PR15_5_PLAN.md` and `docs/implementation/phase2/PHASE_2_ROADMAP.md`. |
| Current profile-test requirements were underspecified | Added precise requirements for contract test aggregation, active-profile coverage, momentum secType exclusions, and shared-profile assertions. |
| Current quality gates needed exact commands | Replaced generic gates with exact command list for shared/signal-engine tests, lint, typecheck, test, build, and diff-check. |
| Immutability policy allowed ambiguity | Replaced alternate policy with unconditional immutability and fail-closed mutation rejection, plus no partial-write integration guarantee. |
| Fingerprint section lacked pre-implementation canonical spec freeze | Added mandatory canonical byte-format freeze before PR15.5C implementation, including key/order/timestamp precision/OHLCV encoding details. |
| Final gate statement conflated blocked state with authorization | Recorded separate Git, CI, and owner-approval evidence and limited authorization to the exact section 3 scope. |
| Required constraints had to remain unchanged | Preserved terminal `INCONCLUSIVE`, no backtest/data pull/research seam/Paper E2E/broker ops, mandatory PR15.5B -> PR15.5C -> PR15.5D order, and `executionEnabled=false`. |
