# Closed-session historical readiness correction

Date: 2026-11-04. Status: independently accepted implementation; local validation complete.
Publication CI and runtime verification follow publication.
Baseline: `eb987f130bf425ee7f0aba1ee838900a3b398327`.

## Outcome and scope

The [accepted plan](SESSION_READINESS_SEPARATION_PLAN.md) corrects pre-opening
warmup assessment. When fresh, matching IBKR contract hours positively establish
CLOSED and historical preparation is complete, native candle assessment returns
`session_closed`, preserving real historical bounds and candle validation.
Terminal output describes normal waiting in Polish. Contradictory CLOSED hours
and an active historical interval produce an explicit diagnostic hold.

Strict current-coverage checks, the strategy runtime's `historyReady` flag,
execution guards, proposal/AI/risk flow, candle minima, refresh pacing and source
acquisition are unchanged. Current hours never manufacture historical sessions,
closed candles or permission to trade. The existing Monday PARTIAL contract stays
in force. No schema migration or configuration change is included.

## Observed runtime baseline

Before this correction, the November 4 14:20 UTC AAPL response was fresh but its
historical coverage ended November 3 at 21:00 UTC. Warmup reported complete
history with `session_schedule_coverage_missing`. The ordinary 14:30:06 UTC fetch
then obtained November 4 coverage; a read at 14:38:59 UTC found both AAPL and PKO
1m READY, including the current 14:37 UTC AAPL candle. This proves the existing
opening refresh worked in that observation. It is not new-package deployment
acceptance, proof of a trade, or proof of complete research readiness.

## Review and allocation

| Work | Requested / actual route | Evidence |
| --- | --- | --- |
| Bounded plan and shared implementation | gpt-6-astra / high, same actual | session_readiness_implementation |
| Independent plan review | gpt-6-astra / high, same actual | session_readiness_plan_review accepted after one repair round |
| Polish diagnostics, runbook, integration and release | Lead session model | Scoped edits and isolated validation |
| Independent hostile final review | gpt-6-astra / high, same actual | session_readiness_final_review accepted; no actionable findings |

The plan review kept the existing strict `historyReady` flag after identifying
its use in errors when evaluation crosses the close. It also required rejecting
contradictory CLOSED hours in the new assessment path. Plan reviewer elapsed time
was approximately seven minutes; no escalation. Per-agent token usage is
unavailable. Implementation repair count: zero; final review repair/escalation count: zero.
The final reviewer independently passed 301 focused tests and reported about five
minutes elapsed. Exact worker elapsed and independent token telemetry are unavailable.

## Validation and release

- Author focused checks: 238 passed; independent final reviewer: 301 passed
  including 63 terminal tests, zero failures or skips.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`: exit 0 in an isolated
  scoped export. Unit suite: 4,042 passed, 420 database tests skipped, zero failures.
- `pnpm test:integration`: exit 0 against isolated PostgreSQL 16, with 3,271 passed
  and zero failures/skips: shared 157, execution 2,272, backtest 18, llm-agent 85,
  ingestion 164, signal-engine 575. This was one uninterrupted complete run.
- Clean `docker build --no-cache`: exit 0; the resulting image ran the integration
  suite. Final release metadata/documentation are included in the pinned release
  image after publication. No strategy or simulator behavior changed, so no
  parameter tuning or additional strategy backtest was performed.
- Documentation links and scoped diff checks passed. All 25 pre-existing unrelated
  modified/untracked files retained their baseline hashes.

An initial local unit run could not open loopback fixture servers under the shell
sandbox. The authorized rerun then exposed a test-runner PATH missing Docker CLI.
Both were validation-environment failures, not accepted test passes; no source or
assertion changed. The full successful rerun used the required local fixture and
Docker capabilities. Dependency setup used the repository's pinned pnpm 9.5.0;
the globally installed pnpm and incomplete offline cache were not used for the
accepted checks.

Tests never used the operational database. Unrelated dirty backtest/ES work,
`signal-engine.ts` and the earlier recovery report are excluded from publication.
The reviewed production helper SHA-256 is
`c63bd9bfd3a2f13920390d509233621f99bb5fa22a95955cf8ffe6c011e33eb5`.

Publication, exact-commit CI, image pinning and authorized Paper rollout are
subsequent gates. Record their actual evidence in the private release audit and
delivery message; this pre-publication report does not claim they have passed.
A real pre-opening observation of the deployed package has not yet occurred;
fixtures establish that transition, while runtime verification must report the
market state actually observed. No trade or profit is guaranteed by data readiness.
