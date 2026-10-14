# WSH freshness and bounded recovery — implementation evidence

Date: 2026-10-14. Status: independent implementation review ACCEPT and all local
release checks passed. This report records pre-deployment implementation evidence;
exact-commit CI and operational receipts are recorded separately.
Contract: [accepted plan and amendments](WSH_FRESHNESS_RECOVERY_PLAN.md).

## Result and boundaries

Regular WSH refresh remains every 15 minutes. An explicitly adopted source
configuration can retain a successful calendar for 24 hours; legacy manifests
keep their original 15-minute age and canonical identity. Transient refresh
failures preserve the original valid projection and record failure diagnostics
separately. Qualification/entitlement expiry, identity, permission, malformed
payload and unresolved publication remain effective gates.

A durable cycle permits initial acquisition plus two retries after 30 and 120
seconds from DB-recorded cleanup settlement. Every request retains its own budget
reservation. Retry counters survive restart. Cleanup receipts bind to the actual
unique transport session; raw local timestamps remain unchanged. Deadlines use
bounded monotonic bookkeeping and authoritative DB admission time. Unknown
cleanup permits only regular recovery when stable exact local closure is proved;
without that proof endpoint/issuer reuse remains fenced. Published valid content
keeps its original TTL. There is no reset API or cross-manifest calendar import.

Preflight starts after durable admission. A deferred acquisition performs no
runtime preflight; a claimed attempt briefly blocks cached admission until local
validation is confirmed. Failed hard-result publication leaves that durable
hold through restart. This is scheduled validation, not continuous runtime
configuration verification.

## Review and routing

| Work | Requested route | Worker/evidence |
| --- | --- | --- |
| Critical contract/shared persistence | gpt-6-astra/high | stale_alert_diagnosis_plan |
| Independent plan/amendment/rollout review | gpt-6-astra/high | stale_alert_plan_review, ACCEPT |
| Transport/refresh/scheduler | gpt-6-astra/high | stale_clock_readonly |
| Diagnostics/integration/release | Capable lead | root |
| Independent implementation review | gpt-6-astra/high | Separate ephemeral Codex reviewers; final ACCEPT after four repair rounds |

Initial plan review resolved two blockers: uncertainty must survive UNKNOWN
retirement and issuer exclusion spans endpoints/manifests. Additional accepted
contracts define actual socket closure, typed send-error codes, claimed-first
preflight and clock-domain/session-replay handling.

The first independent implementation review requested seven repairs: cleanup
reuse fencing, preflight uncertainty, bounded DB bookkeeping, reservation-account
binding, numeric typed 502 handling, preserved provider diagnostics and fair due
selection. These repairs were implemented and independently re-reviewed.
The second review identified terminal readback deadline renewal, a provider-code
phase mismatch and successful-publication concurrent-source preservation. Repairs
are implemented. The third review confirmed these repairs and identified one
remaining monotonic deadline gap in separate-connection publication readback.
The final repair passes the exact ticket through all four affected APIs; seven
focused shared tests cover expired and remaining budgets. The fourth review
identified positive-budget renewal during wall-clock handoffs; absolute numeric
monotonic deadlines now pass through connection and query timers, with 10 focused
shared tests including both rollback handoffs and late-connection destruction.
The fifth independent review accepted the final delta: 82 focused nonnetwork
tests (14 shared, 68 refresh/transport) and five separate offline deadline probes
passed. Compiled shared modules matched current source. The second review’s
preflight finding referenced
superseded prompt wording: the independent plan reviewer reconfirmed the accepted
claimed-first amendment. Deferred work performs no runtime preflight and creates
no new evidence; claimed validation failures remain durable holds. This does not
claim immediate detection of runtime configuration changes between refreshes.
All five CLI reviews identified gpt-6-astra/high. Their printed token counters
were `166.646`, `135.809`, `130.713`, `86.472`, and `71.602` respectively, preserved
verbatim. Four implementation repair rounds were required; no model downgrade
was used. Aggregate worker token usage and complete elapsed-time telemetry are
unavailable; no package-wide savings claim is made.

Lead checks additionally fixed retained-cache preparation during a pending retry,
an existing test's accidental command match inside a random temporary path, and
the migration-33 expectations in historical-upgrade fixtures. Transport fixture
expectations were corrected without relaxing actual local-close requirements.
A real approximately 14 ms host/DB offset motivated the reviewed timestamp
separation rather than clamping production audit values.

## Validation

Post-review focused checks passed (all repair-round additions included):

- Shared unit: 636 passed, with 25 PostgreSQL cases separately passing on isolated
  PostgreSQL at loopback port 55432. Final independent deadline/freshness checks: 14 passed.
- LLM refresh/transport: 68 passed; installed SDK loopback: 6 passed; app PostgreSQL:
  5 passed. Shared and LLM build/typecheck/scoped lint passed.
- Polish startup/status diagnostics: 58 passed; scoped lint passed.

Database regressions include authority/issuer/budget/head lock contention,
cleanup fencing across issuers, account mismatch without charging, fair selection,
concurrent other-source publication, actual binding/preparation holds, raw clock
offsets and session receipt replay/reuse. All provider tests use fakes or a local
SDK loopback peer, not IBKR or paid providers.

Final `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` against
isolated PostgreSQL, and `pnpm build` all exited 0 after the last code repair.
The clean no-cache Docker build also passed for the same runtime source.
The unchanged 20 ms model-worker test once failed under concurrent load
and passed separately and in the subsequent full unit run. An unchanged native
HTTP timeout fixture also failed its request-count timing assertion under the
concurrent clean build, then passed focused and full-unit reruns without edits.
No strategy/simulator change or backtest claim is included. Operational databases are excluded from
fixtures. Unrelated dirty backtest/signal-engine work is excluded from publication
and clean image context; six tracked file hashes were checked unchanged.

## Rollout

The separately reviewed rollout retains a private configuration/database backup,
pauses entries, stops producers, waits out old observations, checks quiescence,
and adopts the 24-hour manifest with execution writes disabled. It then restores
standard execution/ingestion and uses normal start for producers after preflight.
Two helper-review blockers were repaired: the adopted-state gate requires the new
attempt table, and the adoption overlay must exactly match disabled-write settings.
All four configured image pins and running images are checked separately. The
final rollout helper independently passed review after adding exact file/render
receipt checks and complete host-timed gate checks immediately before startup.

Existing history, budgets and unknown outcomes remain. New manifest adoption
requires fresh normal source acquisition; expiry is never extended by this TTL
change. Final image, commit/CI, private manifest and runtime evidence must be
recorded separately. Passing tests does not establish provider responsiveness,
broker cancellation acknowledgement, a Paper trade or unattended-operation
acceptance. No deployment has been performed from a rejected candidate.
