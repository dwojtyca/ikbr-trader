# Broker stale observation recovery evidence

Date: 2026-10-14. [Accepted plan](BROKER_STALE_ALERT_RECOVERY_PLAN.md).
Status: implementation and documentation independently accepted; all required
local checks and clean Docker build passed. Publication, exact-commit CI and
operational verification are pending at this source freeze.

## Incident and confirmed mechanism

The observer's independent 10s watchdog can become overdue while a refresh waits
for accounting. Repeated captures took about 8.08s, with missing accepted clock
evidence before timeout. A periodic capture also followed a forced observer capture
by about 0.8s. Ordinary reconciliation could still finish CLEAN because accounting
failure intentionally preserves ordinary broker evidence for exits.

The previous outbox retained resolved episodes as deliverable. Read-only evidence
over 20 minutes showed 19 episodes, all resolved and all delivered after resolution;
mean episode duration was 2.51s. This establishes the cause of spurious late messages.
It does not establish why IBKR's clock response was missing.

At 2026-10-14T10:43:16Z, the running pre-change release had entries unpaused,
fresh CLEAN reconciliation, zero positions/orders and a healthy observer. This is
one observation, not continuous health or broker trade acceptance.

## Contract

Safety remains immediate at the existing 10s watchdog threshold. A separate durable
notification checkpoint can qualify only current complete flat evidence with exact
process/connection/position identity and no local uncertain operations or other
faults. It never grants accounting readiness, CLEAN status or entry permission.

Qualified account-wide overdue episodes have one fixed 5s notification deadline.
Recovery within it may coalesce only a never-attempted PENDING row. Losing proof
makes delivery due; recovery after the deadline cannot erase it. Attempted delivery,
uncertain transport, probes and urgent/proposal-scoped faults keep their behavior.
History remains available, including individually recorded recurrent transients.

Periodic-only deduplication requires a fully qualified current capture whose
attempt began within 5s. Explicit/fresh requests still capture new evidence. Phase
diagnostics preserve sanitized original causes without raw payloads or accounts.
These changes reduce duplicate pressure and explain remaining waits; operational
evidence must establish whether clock stalls persist.

## Routing and independence

Plan author and critical checkpoint/notification implementer:
`stale_alert_diagnosis_plan`, requested/actual gpt-6-astra/high.
Independent plan reviewer: `stale_alert_plan_review`, requested/actual
gpt-6-astra/high, ACCEPT after one clarification round (original acquisition age,
pre-due proof checks, account-first lock ordering, fair multi-account claims and
conservative historical terminal-proof fallback).

Scheduler/accounting diagnostics implementer: `stale_clock_readonly`,
requested/actual gpt-6-astra/high. Its earlier task name describes the initial
read-only diagnosis; implementation was separately delegated after plan acceptance.
The collaboration tool refused creation of another reviewer at its thread limit.
A separate ephemeral read-only CLI review used gpt-6-astra/high (confirmed by
the CLI launch header). Its early source review identified five defects: unbounded
checkpoint persistence, proof expiring during validation, a busy account delaying
another account's urgent alert, successful-looking failed source phases, and an
incorrect configured secret name in redaction. All five findings were repaired with focused regressions. The CLI reported token usage as `108.516`;
the tool's counter formatting is retained verbatim rather than assumed comparable
with unavailable collaborator counters. The first frozen-source review rejected four further issues: contradictory completed-order economics, connection changes across awaited transaction writes, incidental outbox lock waits, and missing hostile race/production-predicate tests. Those were repaired under the independently accepted final-review plan amendment. The reviewer reported `129.397` tokens in its own formatting. The second review found one remaining contradiction: an ordinary execution could
match only an accepted execution ID while its quantity differed from the separate
final snapshot. It passed 99 focused cases but reproduced this gap. The independently
accepted amendment now requires exact accepted identity, role, quantity, price and
execution instant for every observed checkpoint execution; duplicate/unknown rows
deny eligibility. Distinct snapshot fixtures prevent aliasing from masking this.
The CLI counter was `150.294`. Third frozen-source critical review: **ACCEPT**, with 102 offline focused tests
and 63 independently constructed in-memory eligibility scenarios. CLI counter:
`78.351`. Requested gpt-6-astra/high is confirmed in launch headers; actual backend
model/effort telemetry is unavailable. There were three implementation repair rounds
(early five findings, first final four findings, second final one finding), no model
downgrade. A further local test caught prewrite compensation during round two. The lead performs
mechanical checks/publication because the recommended gpt-5.6-luna route is absent
from the agent selector. Token usage is unavailable unless recorded by the reviewer.

## Validation and release

Repaired focused validation: 63 scheduler/accounting/privacy tests, 62 notification
and isolated PostgreSQL tests, and 35 terminal-proof fixtures passed. Targeted lint
and execution-engine typecheck passed. Tests cover accepted historical economics,
completed-order contradictions and cancelled remainders, live identity changes
before/after writes and COMMIT, unknown COMMIT acknowledgement, active-query abort,
restart identity, due delivery races, and a locked outbox row versus another account.
One new test found a missing immediate fault after a prewrite connection change;
that defect was repaired before the final focused run.

The first full run passed lint, typecheck and unit tests (3590 total, 3368 passed,
222 skipped, no failures). Integration found a hardcoded expected migration list
ending at 31; it now includes migration 32, and that isolated PostgreSQL file passed
all four cases. Subsequent full attempts exposed existing timing-sensitive HTTP tests (7/7 passed
alone) and a Vite fixture cleanup ENOTEMPTY race (7/7 passed alone). These files
are unchanged; no assertions were weakened. Final repaired source: lint and typecheck passed; full unit run passed (3644 total,
3422 passed, 222 skipped, zero failures). Integration passed: 2759 tests, 2759 passed, zero failures/skips on isolated PostgreSQL.
`pnpm build` passed. All required local commands exited zero.
No safety thresholds, test assertions or database history guards were weakened.

The accepted transaction boundary is the final synchronous identity/expiry check
before submitting COMMIT. Known post-acknowledgement drift creates an immediate
fault. Broker socket and PostgreSQL cannot be atomically committed: unknown COMMIT
acknowledgement propagates without retry, and crash recovery uses the existing
startup/observer safeguards. No durable crash-safe compensation is claimed.

Use isolated PostgreSQL on port 55432 for destructive fixtures. Preserve
the unrelated backtest/ES and signal-engine work, excluding it from staging and
the clean release image. No strategy/simulator behavior changes are in this package;
no additional strategy backtest is required.

Migration 32 and its history must survive rollback. An older image unaware of
COALESCED is not a supported rollback target. Keep entries paused and deploy a
compatible reviewed fix; never relabel rows as delivered or overwrite newer broker
history with a database restore. See the
[supervision runbook](../../runbooks/PAPER_LIFECYCLE_SUPERVISION.md).

Elapsed time: total implementation/review time across continued context is unavailable;
no per-agent wall-time counter was exposed. Validation and deployment timestamps
are recorded separately where observed. No efficiency percentage is claimed.

Independent documentation/publication-scope review accepted the 31-file allowlist,
resolved documentation links and bounded claims after elapsed-time/readability
clarifications. Unrelated backtest/signal/phase2 files are excluded.

Clean scoped Docker build (`--no-cache`) passed, excluding unrelated dirty work.
Focused tests inside the built image passed with network disabled. Subsequent
packaging only incorporates this final report; committed source must hash-match
the clean context before publication. CI and deployment results are release receipts
after this source freeze, not inferred from the local build.
