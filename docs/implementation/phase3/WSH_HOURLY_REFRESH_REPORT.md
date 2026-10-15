# WSH hourly refresh delivery report

Date: 2026-10-15. Status: implementation, independent review, required local checks and clean Docker build passed. Publication/CI and operational acceptance remain separate.

The owner requested ordinary WSH refresh once per hour, with successful calendars
usable for 24 hours and the existing bounded failure retries retained. The
[accepted plan](WSH_HOURLY_REFRESH_PLAN.md) scopes this change. The preceding
[freshness/recovery package](WSH_FRESHNESS_RECOVERY_REPORT.md) remains the baseline.

## Intended behavior

New hourly manifests use `refreshIntervalMs=3600000` and `maxAgeMs=86400000`.
Legacy manifests preserve their exact bytes, hashes and 15-minute cadence.
Database cycle deadlines survive restarts and configuration changes; moving to
hourly cadence waits an hour from the preceding regular start, and moving back
cannot shorten an existing hourly deadline. Retries retain their original cycle,
30s/120s delays, maximum attempt count and cleanup requirements.

The additive migration permits both exact supported durations and checks new
cycle identity against the stored canonical source and current authority. It
preserves historical records. Exact source hashing uses PostgreSQL `json`
extraction of existing canonical text, never reconstructed `jsonb::text`.

## Review and routing

| Work | Requested / actual model and effort | Evidence |
| --- | --- | --- |
| Critical plan/shared implementation | gpt-6-astra/high | `stale_alert_diagnosis_plan` |
| Independent critical plan review | gpt-6-astra/high | `stale_alert_plan_review`, ACCEPT after one identity/hash clarification |
| Scheduler integration/tests | gpt-6-astra/high | Existing `stale_clock_readonly` worker reused with bounded file scope |
| Independent implementation review | gpt-6-astra/high | `hourly_final_review`, ACCEPT; distinct from plan reviewer and authors |

Plan review clarified exact source/issuer identity, current authority, ledger
binding and byte-preserving source-hash verification in SQL. No general JSON
serializer or source-qualification renewal subsystem is part of this package.
Initial implementation review found two bounded repairs: combine finite cleanup
and cadence deadlines when reporting a transition to hourly refresh, and verify
the historical cycle constraint definition before replacing it. Both repairs and the completed hostile/historical fixtures passed final review.
One production repair round; fixture-only corrections preserved existing guards.
This resumed implementation/review/check work took approximately33 minutes
(08:22–08:55 UTC); publication and operational work are separate. Token usage is unavailable.

## Validation and publication

Focused scheduler/regression tests passed67/67. Shared hourly PostgreSQL cases
passed13/13; existing WSH PostgreSQL cases passed25/25. Independent reviewer ran
13 shared and51 app unit tests successfully and accepted the final14-file scope.

First full lint/typecheck passed. The first full unit run failed an unchanged
150ms native HTTP timeout fixture (`research-fetch.test.ts`, server calls0 vs1)
while parallel fixture work was still finishing. Its isolated7-test file then
passed without source changes. The full rerun after worker freeze passed `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm test:integration` and `pnpm build` (all exit0). Integration
used isolated PostgreSQL on port55432, never operational fixtures.
A clean Docker `--no-cache` build passed from `git archive HEAD` plus only
the14 reviewed files. The final report is packaged into the same source context
before publication. Scoped commit/push and exact-commit CI follow this report;
the CI result must be verified for that published commit before declaring release
complete. Unrelated backtest and signal-engine working-tree
changes are excluded from this package and its deployment image.

## Operational state

At 2026-10-15T08:29:57Z the previously deployed bot had entries paused at revision43,
current CLEAN reconciliation, zero positions/open orders and a healthy observer.
This is a point-in-time observation, not hourly-release acceptance. The existing
private manifest still uses 15-minute refresh/24-hour data validity. Its WSH and
Marketaux qualification/entitlement dates have expired; this code change does not
renew them. Runtime startup and fresh source coverage remain separate checks.
