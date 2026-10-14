# Broker stale observation recovery evidence

Date: 2026-10-14. [Accepted plan](BROKER_STALE_ALERT_RECOVERY_PLAN.md).
Initial release source-freeze status: implementation and documentation independently accepted; all required
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

## First release and operational follow-up

Commit `c293b7fbd56468fda152d5ef23508943749b4716` passed
[exact-commit CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/38556790070).
All 984 committed files matched the isolated image source context. The packaged
image was `sha256:fcbe2d143df16ab6348ca4c8d9f6e6a280a97f7b52b93aa31887afa8c082d120`.
The deployment paused new entries, confirmed fresh CLEAN state and zero exposure/
orders, saved a private configuration/database backup, and recreated the services.
The normal start preparation resumed Paper at 11:39 UTC; all four service image
identities matched. From 11:38:03 to 11:43:12 UTC there were zero new lifecycle
faults and no active faults. Initial captures were at most 232 ms; clock responses
were a few milliseconds. This does not prove the earlier remote clock cause.

Operational acceptance found that periodic deduplication had not activated.
PostgreSQL BIGSERIAL IDs are strings at runtime despite the repository's number
annotation. The new proof compared `Number(row.id)` to the unconverted run ID,
always denying reuse; the diagnostic emitter also omitted that run ID. An offline
production-predicate reproduction confirmed numeric 42 qualifies and string '42'
does not for otherwise identical evidence. The follow-up is limited to validated
run-ID normalization in the new proof/diagnostic boundaries, preserving accounting,
identity and age predicates. The initial release is operationally healthy but this
optimization is not accepted until the follow-up passes review, checks, CI and
runtime verification.

The run-ID amendment was independently accepted by `stale_alert_plan_review`
(Astra/high). `stale_clock_readonly` implemented six bounded reconciliation files
(Astra/high): canonical validator, proof and diagnostic boundaries, and their tests.
All 66 focused unit tests and the actual isolated PostgreSQL BIGSERIAL regression
passed, as did targeted lint/typecheck. There were no targeted repair attempts in
this amendment. The separate CLI hostile review accepted the follow-up, with 54 offline tests.
It did not independently run PostgreSQL/full suites/Docker or verify CI/deployment;
those checks remain separately required. Full follow-up validation results are recorded below. The operational clock measurements remain observations, not proof of the
original timeout's cause.

Follow-up independent CLI implementation review: **ACCEPT**, no findings;
54 focused offline tests passed independently. Requested gpt-6-astra/high is
confirmed in the launch header; backend telemetry remains unavailable. CLI token
counter: `51.542` (verbatim). Full follow-up lint, typecheck and unit tests passed:
3648 total, 3425 passed, 223 skipped, zero failures. Integration/build and clean
image validation remain pending at this point in the record.

Follow-up full integration passed: 2763 tests, 2763 passed, 0 failures,
0 skipped on isolated PostgreSQL. Full build passed. The eight-file
documentation/publication scope was independently accepted after status-label
clarifications. Clean image/CI/deployment remain outstanding at source freeze.

Follow-up clean Docker build (`--no-cache`) passed; focused proof, diagnostic and
scheduler tests inside the image passed with networking disabled. Final packaging
adds only this report. The follow-up commit must match the isolated source context;
exact-commit CI and observed periodic reuse are required release receipts after
this source freeze. No further implementation review findings or repairs occurred.

## Follow-up deployment and remaining completed-order incidents

Commit `798ff702e92162ba4c176181ca9a36907166357b` passed
[exact-commit CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/38559837416).
All 986 committed source files matched its image context. Four service images were
verified after deployment at 12:05 UTC. Six actual `recent_complete_capture` skips
with numeric run IDs were observed by 12:11 UTC, confirming the PostgreSQL fix.
However, two completed-orders timeouts recurred; each caused incomplete ordinary
coverage and downstream `ACCOUNTING_REPLAY_INCOMPLETE`, then recovered. These
unqualified incidents correctly remained deliverable. Periodic reuse therefore
works but does not establish resolution of all stale-alert causes.

Read-only source/cadence review found a fresh completed-orders socket on every
capture and one deadline spanning queue, connection, identity handshake and replay.
The current phase log cannot identify which internal wait failed. Connection churn
is observed, but its causal role is unproved. A separate accepted diagnostic
amendment is required before drawing a behavior-change conclusion; no coverage,
clock, timeout, cache or safety relaxation is justified by these observations.

Normal `pnpm start` after this deployment was independently blocked by
`RESEARCH_MARKETAUX_RESULT_LIMIT` for AAPL. Its existing private research configuration
allows 30 articles (3 per page, 10 pages) in the fixed 24-hour window; the response
exceeded that bound. Entries remain paused (revision 37 at 12:11 UTC), while broker
reconciliation was fresh CLEAN, observer healthy and positions/orders zero. This
is not described as successful trading activation. No research/AI gate was bypassed.
Private operational receipts are retained with the deployment backup.

The owner confirmed the free Marketaux entitlement (100 requests/day, 3 articles
per response); no paid upgrade is assumed or requested as a prerequisite without
evidence. A separate read-only code review is examining polling and pagination
efficiency. At 12:23 UTC entry pause revision 37 remained active, reconciliation
was fresh CLEAN, the observer healthy, and positions/orders zero. The subsequent
ten-minute phase summary showed 118 successful completed-order captures and one
8.005-second timeout, with ten actual periodic reuse skips. Clock responses remained
fast; this further supports localizing completed-order waits rather than changing
clock or safety thresholds.

## Completed-order timeout diagnostics follow-up

The accepted localization amendment adds optional bounded per-capture milestones
for queue wait, handshake, account validation, request call/local write attempt,
first decoded row, semantic end and confirmed shutdown. Initial read failures
and subsequent cleanup failures remain separate, with sanitized original SDK
name/code/message (including a string message with a separately supplied code).
The local capture ID is distinct from a broker request ID; the existing adapter
forwards the reconciliation run ID. No request/deadline/coverage, result, queue,
retry, cache, notification or trading policy changes are intended.

Plan author, independent plan reviewer and implementation worker were the existing
Astra/high agents; requested/actual route is inherited Astra/high, with backend
model telemetry unavailable. The lead identified one original-string-message gap
during implementation; it was repaired with a privacy regression before source
freeze. Worker focused validation passed 79/79 tests, scoped ESLint and execution
typecheck. An independent ephemeral Astra/high CLI reviewer and the full repository
checks are now running. Runtime stage evidence, clean image, publication, exact CI
and deployment remain outstanding; this instrumentation is not a timeout fix.
Available worker token usage and exact elapsed task time are unavailable.

The first independent CLI diagnostics review rejected two reproduced issues:
terminal diagnostics could reenter an unprotected finish transition, and missing
write telemetry could obscure a later validated-row stage. Both were repaired:
terminal state/abort cleanup precede terminal callbacks, and a decoded row takes
precedence while missing local write telemetry remains a separate bounded event.
Nine new regressions cover these cases; 88 focused tests, scoped lint/typecheck
and diff checks passed. The first reviewer also independently passed 79 tests;
its token counter was `65.234` (verbatim). One formal implementation repair round
so far; a fresh independent review and full final suites are running. The previous
full lint/typecheck/unit pass preceded this repair; its integration run was
intentionally stopped and is not counted as a completed validation.

Separate read-only Marketaux checks confirmed on-demand mode enabled and 47 local
reservations today, all HTTP calls recorded successful. A successful HTTP response
can still fail our local result-capacity validation. No observed article count was
retained by the older negative snapshot, so neither a specific increased cap nor a
paid upgrade is justified yet. A separately reviewed plan covers retaining that
numeric local-failure evidence without changing provider calls, budgets or eligibility.

The second independent diagnostics review rejected an active-stage reentrancy gap:
a diagnostic callback could abort/throw, finish cleanup, then the caller could
continue into connect or a request. Its 88 focused tests passed, but independent
hostile fixtures reproduced the gap. Token counter: `65.698` (verbatim). This
version was not deployed. A second repair round covers every active callback
boundary and subsequent queued loads. The second full validation again passed
lint/typecheck/unit before integration was intentionally interrupted for the repair.
Final validation must run on the accepted repaired source.

The second production repair added active-stage terminal checks and twenty emit/
privacy abort-and-throw regressions, including safe subsequent queued loads. The
worker passed 108 focused tests. Third independent review confirmed both production
repairs and passed fourteen additional terminal hostile cases, with no new
production blocker. It rejected one flaky privacy assertion: matching digits 987
across serialized durationMs falsely identified a broker ID. A test-only repair
retains structural field/scalar and payload checks while validating durations
separately; production timing is unchanged. Third review counter: `60.844`
(verbatim). This is a third formal repair round, limited to that test.

Fourth independent review **ACCEPTED** the final test repair, verified all scoped
production diffs unchanged from the preceding review, and passed 111 focused
offline tests plus ten intentional invalid privacy/duration mutations. Requested
Astra/high was confirmed by its CLI launch header; backend telemetry unavailable.
Token counter: `50.658` (verbatim). Full final integration/build and clean image
validation remain outstanding at this record point.

Final unit validation passed: 3705 tests, 3482 passed, 223 skipped, zero failures;
lint and typecheck passed. The first completed integration attempt failed one
existing Marketaux partial-budget provenance fixture (UNAVAILABLE vs VERIFIED),
outside changed source. That exact isolated PostgreSQL file then passed 27/27
without source changes; full integration/build are being repeated and the first
failure is retained in a private validation log. It is not counted as a pass.

Operational research review found no supported one-shot refresh for the current
RESULT_LIMIT HOLD. The validated runtime profile requires on-demand mode; toggling
scheduled mode would fail its configuration guard. Raising article caps creates a
new research manifest requiring disabled-write adoption and fresh whole-manifest
research, not a bounded single diagnostic retry. Neither operation was performed.
The configured pooled bot budget is 90/day, below the provider entitlement of 100;
47 local reservations leaves 43 locally, without proving external quota.

Final unchanged-source integration rerun passed: 2820/2820, zero skipped or
failed, on isolated PostgreSQL. Full build passed. Together with the recorded
3705-unit total (3482 passed, 223 skipped), lint/typecheck, all required repository
checks are now green. The unrelated first-run provenance failure remains disclosed
above. Independent documentation review accepted the exact eight-file scope,
all local links and status/repair claims; Marketaux proposal/plan and unrelated
backtest/signal changes are excluded. A clean scoped Docker build is running.

Clean scoped Docker build (`--no-cache`) passed, followed by the focused completed-
order, phase diagnostics and production adapter suites inside that image with
networking disabled. Final packaging adds the measured report only. This package
is accepted for publication; exact-commit CI, deployment and naturally observed
internal timeout stage remain required release receipts after source freeze.
Nothing in these offline checks proves the runtime timeout has been fixed.
