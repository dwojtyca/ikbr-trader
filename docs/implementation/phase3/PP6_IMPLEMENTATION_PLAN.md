# PP6 — headless diagnostics implementation plan and contracts

Date: 2026-10-04. Baseline: `85ed46aeeba660bd967a0818f696eede3624619e`.
Status: contract accepted by independent gpt-6-astra/high reviewer on 2026-10-04;
no blocking findings. Implementation and final independent source review complete;
validation/publication evidence is in the [report](PP6_IMPLEMENTATION_REPORT.md). No activation.
Normative scope: [delivery plan §10](PAPER_PRODUCTION_DELIVERY_PLAN.md#10-pp6--headless-diagnostics-deployment-and-recovery),
[roadmap](../ROADMAP.md), [routing](MODEL_ROUTING_GUIDE.md).

## Baseline and boundaries

PP0–PP3 and PP5 are delivered; PP4 implementation is delivered but actual complete
research remains blocked (latest PKO periodic report, complete issuer news/events,
model availability). Existing quote/completed-order/accounting limitations remain.
PP6 cannot certify them. Existing configured evaluation deliberately returns
`entryAllowed:false` with PP4 blockers; diagnostics must preserve this fact.
Do not touch UI or the 25 pre-existing dirty files (inventory hashed privately in
`/tmp/pp6-original-dirty.json`). Work on main; scoped publication only. No operational
stack startup, broker writes/refresh requests, providers or real alert recipients.
Fixtures and a separate Docker daemon/database provide operational evidence.

## PP6-C first: authoritative contracts

### Read model and evidence

Add a version 1 shared diagnostic contract. An event contains stable `id`, `code`,
`severity` (INFO/WARN/ERROR/CRITICAL), `service`, UTC `occurredAt` and `recordedAt`,
`reason`, Polish `message`, `impact`, `action`; explicit nullable `instrumentId`,
`conId`, `symbol`, `listing`, `implementationId`, `instanceId`, `revision`,
`configHash`, `evaluationId`, `traceId`, `proposalId`, `brokerOrderId`, `lifecycleId`,
`closeId`, `researchSnapshotId` and an authenticated relative `auditRef`.
No raw account ID, provider body/prompt, credentials or account balances belong in
this contract. Optional missing identifiers are null, never generated to suggest
an absent link. Event IDs identify source records/versions, not symbols. Mutable supervision/close snapshots do not
prove intermediate transitions; expose their last observed timestamp and mark
historical transition coverage partial.

`DiagnosticReport` contains schemaVersion, mode, generatedAt, interval (UTC from/to),
coverage records, events, typed sections (title plus labelled scalar fields),
counters, and explicit truncation. Coverage is COMPLETE/PARTIAL/UNAVAILABLE with
source, observedAt, earliestAvailableAt and reasons. COMPLETE only means the stated
bounded stored query is complete, never complete broker accounting or readiness.
No all-clear aggregate or trading authorization is introduced. Missing counters
are null; a complete stored query may have zero matching records but does not
prove all scheduled evaluations occurred. Session reports state observation gaps.

Use existing authoritative persisted proposal/AI/research/attempt/fill/ownership/
close/reconciliation/fault/delivery records. Read projections attach their original
IDs, immutable config and stored research/source/document references. Reuse current
lifecycle and round-trip evaluators for safety status and currency-aware economics;
never calculate trading P&L in the formatter. Missing fees remain pending; mixed
currencies are separate. Submitted, broker acknowledged, filled, closed and accounting
complete remain distinct. Show both active and resolved critical episodes.

Persist scheduled instrument evaluation outcomes (including no-signal/skipped/error)
in a new diagnostic-only append store with stable cycle/instrument identity and
server insertion time. Existing audits remain authoritative. Instrumentation never
changes runtime outcome/guards or retries a broker action. Failure to record emits
a sanitized critical sink failure and coverage becomes unverified; it cannot claim
durability. Service heartbeat/generation records identify restarts and expected
loop interval/enabled status. Coverage gaps greater than two intervals, process
changes, missing sources and future/skewed timestamps are explicit. No-signal is
not synthesized from no rows. Legacy and configured scheduler paths are covered.

### Privacy and terminal contract

Routine reports are authenticated with the existing EXECUTION_API_TOKEN even when
writes are disabled. Add only read-only GET `/execution/diagnostics` (mode/events,
status,timeline,session), bounded UTC range <=31 days, limit <=1000, instrument,
severity/reason and decision/evaluation/proposal filters. No arbitrary SQL, URLs,
file paths or broker refresh. Account selection comes from the known allowed server account context; null/changed
account yields unavailable account evidence, never an all-account query. Historical
proposal queries must not expose another account. Parameters are validated and SQL
parameterized. Read errors use fixed codes; no exception/provider payload leakage.
Responses are bounded, with omitted source/row/interval information when capped.

Review clarification: an exact proposal/evaluation trace looks up only that
account-scoped identity and its linked close; it includes retained records outside
the default hour and explicitly reports the resulting evidence interval. This
avoids requiring the operator to guess the creation time. The 1000-event/response
caps (1000 events, 2 MiB) still apply; events/session/export time searches retain the 31-day ceiling.
Missing links and discarded old diagnostic copies remain explicit. This is a
read-only identity lookup, not a change to admission or accounting. The independent
original Astra/high plan reviewer accepted this clarification on 2026-10-04.

Shared privacy helpers use allowlisted projection, escape control/ANSI/bidi and
line injection, bound string lengths and redact known credential patterns. Account
IDs are omitted/masked before output. Untrusted source/model strings remain labelled
stored evidence, never instructions or terminal markup. URLs are restricted to safe
http(s) without credentials/query/fragment. Export additionally pseudonymizes
correlation identifiers consistently within a bundle and removes exact audit links
and sensitive monetary fields; it retains config/schema identity and omission info.
Exact audit references remain available only through authenticated local reports.

Add `pnpm paper:ops` in the existing paper-verify-stack tool, with Polish help:
`logs [--follow]`, `status`, `trace --proposal ID|--evaluation ID`,
`session --from UTC --to UTC`, `export --from UTC --to UTC --output PATH`.
Common filters: --instrument, --reason, --severity, --from, --to, --limit; --json
uses the same report data. Default last hour, 200 events; explicit timezone display
(default Europe/Warsaw). Follow polls every 5s, bounded memory/output per poll,
deduplicates stable IDs, overlaps reads to capture delayed/reordered events and
prints reconnection/gap limits. It never guarantees exactly-once transport or audit
completeness after a disconnect. Noncritical equal states compact with first/last
and count; critical/resolution never sampled. Session counts use persisted rows,
not compacted output. Unknown codes have a Polish fallback plus the original code.

Token loads from environment or explicit local dotenv file; never command-line
secret arguments, printed secrets, inherited arbitrary URLs or redirects. Default
execution URL is loopback; permitted explicit Compose service hostname is documented.
Strict origin validation prevents forwarding credentials to arbitrary hosts.
Export <=1 MiB, <=1000 events and <=31 days, mode0600, refuses existing files/symlinks;
text plus JSON selectable, clearly redacted and bounded, no claim of full audit.
Transport timeouts and maximum response bytes bound reads.

Explicit `control pause|resume|supervision|close|reconcile` wraps only existing PP5
endpoints. Mutations require explicit verb and existing server auth/guards. Pause/
resume require reason. Close uses the existing strict requestId/limitPrice body
with original lifecycle ID, caller-supplied stable UUID and price; no added reason.
No retry of any POST, no generated replacement IDs, no activation command. Failure
or timeout says outcome unknown; never suggests retrying. GET supervision is read-only.
Tests verify default operations cannot invoke mutating routes. No control is invoked
against the operator's actual stack during this delivery.

### Retention, deployment and recovery

Diagnostic copies: retain at most 30 days/100000 evaluation events, prune in bounded
batches at writer maintenance; record pruning watermark so earlier intervals show
PARTIAL. No pruning of ownership, attempts, original audits, research, pause, close,
fault or delivery evidence. Console uses Docker local driver rotation 10 MiB x3 per
service. Restore includes diagnostic metadata; absent metadata remains unavailable.

Deploy required services explicitly with UI stopped, pin image digest/code/config
hashes/migration list and retain secrets outside evidence. Never start recipient
transport with real credentials in drills. Keep writes disabled/entries paused and
lifecycle writes off while restoring/reconciling. A backup predates later broker
actions and cannot prove flat. Rollback uses a compatible writer preserving PP5
identity; no schema down migration, safety-row deletion, budget reset or old writer.
Run a disposable PG dump/restore drill that compares config/research/AI/attempt/
ownership/close/pause/fault/delivery evidence and runs existing admission/unknown
state tests against restored data. No operational DB fixtures.

Manual IBKR intervention is external. Pause only stops entries; exits may race it.
PP5 has no proven general manual takeover/quiescence protocol: document this limit,
require separately reviewed capability for seamless takeover, and retain HOLD for
manual sale/changed quantity/orphan protection/unknown attribution. Use supported
observation/reconciliation after owner action, never fabricate ownership or retry SELL.

## Delivery packets and gates

1. Lead A establishes this contract, reviews source and implements shared types/
privacy/query limits. Independent RA gpt-6-astra/high accepts plan before code.
2. PP6-A L gpt-6-luna/medium owns pure shared Polish message/format/filter helpers and
associated tests under the accepted contract. No persistence, safety or money logic.
3. PP6-B S gpt-6-sol/medium owns diagnostic source projections, scheduler persistence/
instrumentation and tests under the contract. Lead handles auth routes, CLI control
transport, redaction/export, Compose and recovery. Disjoint ownership is assigned in
delegation; ambiguous critical semantics return immediately to lead A.
4. Lead integrates. Different RA gpt-6-astra/high reviews complete implementation,
manual-race/unknown/hostile input/completeness cases and report. Repair to acceptance.
One failed focused noncritical repair escalates L->S->A per routing guide.
5. Mechanical gpt-5.6-luna/low (if unavailable disclose gpt-6-luna/low fallback) runs
required checks on clean scoped candidate; reviewed scoped commit/push main and
exact-commit CI. No broadened staging or source fixes by mechanical worker.

## Acceptance and evidence

- UI-off isolated operator walkthrough for PKO, AAPL and third configured stock:
why no trade, exact decision/trade history and required action understandable via
five terminal operations, Polish and JSON consistent.
- Meaningful unit/integration tests cover no signal vs error/reject/pause/session/
stale data/unknown broker; all lifecycle statuses; source outage/expiry; original
config/research links; mixed currencies/missing fees; duplicate/out-of-order/gaps,
retention/restart, sink failure; secrets/hostile control text/URLs; pagination/limits;
auth and read-only vs explicit controls. Manual sale racing close, changed quantity,
unrelated exposure and orphan protection use isolated existing PP5 adapters plus
new presentation assertions; unsupported results stay HOLD.
- Clean candidate excludes unrelated local files. Run pnpm9.5.0 lint, typecheck,
test, test:integration (only isolated TEST_POSTGRES_URL), build; clean no-cache
Docker build; isolated restore/UI-off drill. No strategy/simulator edits, so no new
strategy backtest required. Never count operational broker/provider evidence from
fixtures. Report limits plainly.
- Update roadmap/current state/delivery status and PP6 implementation report with
review results, commands, source SHA/CI URL, requested/dispatched models, repair/
escalation counts, elapsed time and unavailable token telemetry. Final completion
requires accepted review, all checks, scoped push and exact SHA CI success.

### Root terminal entry point — verification clarification

The documented `pnpm paper:ops` changes the child process working directory to
its workspace package. Relative `--env-file` and `--output` paths must resolve
against the caller's `INIT_CWD` when provided by pnpm, otherwise `process.cwd()`;
absolute paths remain unchanged. This affects file location only, not credentials,
authentication, host allowlists or trade controls. The isolated operator drill must
invoke the actual root `pnpm paper:ops` command with a relative private synthetic
environment file and relative export path, without inherited API credentials.
Keep the same seven read-only requests and three-instrument/five-view acceptance.
The original independent plan reviewer accepted this clarification before
implementation on 2026-10-04. Final source review and all required checks apply
to the corrected candidate.

The package Node invocation must terminate runtime option parsing with `--` before
the CLI script, so the operator's `--env-file` belongs exclusively to the CLI parser
and does not trigger Node environment preloading. The root-command drill covers
this boundary together with relative paths and original token precedence.
Accepted independently by the original plan reviewer on 2026-10-04 before the
package-script change. A subprocess test also exercises this root command with an
empty synthetic token, expecting the CLI's own token rejection before any HTTP.
