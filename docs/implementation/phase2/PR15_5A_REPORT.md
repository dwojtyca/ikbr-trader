# PR15.5A — ES compatibility prerequisite closure — REPORT

Status: implementation complete locally; awaiting commit/push/green CI

Date: 2026-09-15

## Outcome

The static compatibility prerequisite is closed with terminal result
`INCONCLUSIVE`. No research result was produced and no activation was
authorized.

Both active momentum profiles now declare only the asset classes supported by
their concrete implementations: `STK` and `IND`. An app-level contract test
checks every active profile against its registered implementation and reports
all mismatches in one failure.

## Static audit evidence

1. `BacktestRepository.resetHistoricalData()` truncates datasets, candles, FX
   rates, runs, orders, fills, strategy state, and signal diagnostics with
   `RESTART IDENTITY CASCADE`; it does not truncate instrument contracts.
2. Candle tables have global `(symbol, ts)` primary keys and no `dataset_id`.
3. History symbol/resume endpoints extend or mutate the current dataset.
4. Numeric dataset IDs are database-local sequence values and can be reused
   after reset.
5. Historical contract resolution retains the first IBKR contract-details
   response; watchlist overrides cannot identify an explicit expired contract.
6. The acquisition path therefore cannot deterministically assemble a
   multi-contract ES history with a frozen roll policy.
7. The simulator supports a notional multiplier but uses equity-oriented
   per-share/bps commissions and has no explicit 0.25 ES tick model or complete
   expiry/roll semantics.
8. Higher timeframes use epoch/UTC buckets rather than CME session-calendar
   boundaries.
9. Backtest-engine has no `test` script and is skipped by root
   `pnpm test --if-present`.
10. Future research validation must keep pure request validation separate from
    manifest and PostgreSQL loading.

These critical gaps prohibit a credible ES compatibility experiment in this
PR. Remediation belongs to PR15.5B and PR15.5C before any PR15.5D experiment.

## Changed paths

- `docs/implementation/phase2/PR15_5A_ES_COMPATIBILITY_PLAN.md`
- `docs/implementation/phase2/PR15_5A_REPORT.md`
- `docs/implementation/phase2/PR15_5A_ES_DECISION_RECORD.md`
- `docs/implementation/phase2/PR15_5_PLAN.md`
- `docs/implementation/phase2/PHASE_2_ROADMAP.md`
- `packages/shared/src/strategy-profiles.ts`
- `packages/shared/src/strategy-profiles.test.ts`
- `apps/signal-engine/src/strategies/strategy-profile-contract.test.ts`

## Verification

| Gate | Result |
| --- | --- |
| `pnpm --filter @ikbr/shared test` | pass — 345/345 |
| `pnpm --filter @ikbr/signal-engine test` | pass — 418/418 |
| `pnpm lint` | pass — 0 errors, 3 pre-existing unused-disable warnings |
| `pnpm typecheck` | pass |
| `pnpm test` | pass — 1213 total, 0 failed |
| `pnpm build` | pass |
| `git diff --check` | pass |

## Hostile review

The independent reviewer required three corrections before approval:

1. The audit said `resetHistoricalData()` reset the whole database, although
   `backtest_instrument_contracts` is retained. The plan and report now name
   the exact reset scope.
2. The shared regression test initially protected only IDs, secTypes, and
   enabled flags for unaffected profiles. It now explicitly protects every
   behavior-bearing profile field, including regimes, thresholds, factors,
   early-exit flags, and symbol scopes.
3. This report still contained verification/review placeholders. Actual gate
   results and review resolutions are now recorded here.

The corrected diff was returned to the same reviewer. Final independent
verdict: **APPROVED**, with no remaining findings.

## Safety confirmation

- No backtest or data pull was run.
- No backtest-engine or runtime wiring was changed.
- No strategy implementation gained futures support.
- No seed or policy changed `executionEnabled`.
- No Paper E2E or broker operation was performed.

## Next step

Prepare, review, and approve
`docs/implementation/phase2/PR15_5B_FUTURES_BACKTEST_MODEL_PLAN.md`. Do not
implement PR15.5B under this report.
