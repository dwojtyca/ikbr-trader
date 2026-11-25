# Ingestion contract-resolution failure diagnostics

Date: 2026-11-25. Status: ACCEPTED by independent critical reviewer
`diagnostics_plan_review` (Astra/high), after one plan repair round. No remaining
blocking findings; a different independent implementation reviewer is required.
Baseline: `9fbdb5729e9854de094640b7aca0543ea75c8143` on main.
Owner request: improve the code so the cause of unavailable PKO data is clear.
This bounded extension follows [continuous operation](CONTINUOUS_PAPER_OPERATION_PLAN.md),
[automatic recovery](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md) and the accepted
[sleep/wake contract](SLEEP_WAKE_RECOVERY_PLAN.md). It changes diagnostics and
corrects contract-request error decoding; it does not authorize deployment.

## Evidence and scope

The lead's read-only runtime observations at approximately 13:05 and 13:10 Warsaw
on November 25 show ingestion reconnecting, receiving `nextValidId`, reporting
farm availability, timing out PKO contract details after eight seconds, resolving
AAPL, and rejecting bootstrap with `INGESTION_SUBSCRIPTIONS_INCOMPLETE`. Recovery
continues with the existing five-minute backoff ceiling. These observations do
not identify why IBKR failed to return PKO details. New diagnostics cannot
retroactively establish missing request evidence.

Current `resolveContracts()` catches each resolution error, logs only a string
and returns the other subscriptions. The controller consequently retains only
the later incomplete-subscription error. The strict bound resolver discards the
original error object and has no response-count, end-marker or transport context.

The installed adapter is `ib` 0.2.9 (manifest `^0.2.8`):

- `lib/incoming.js` and `lib/controller.js` emit broker errors as
  `error(Error, { id, code })`. Both contract-details handlers currently expect
  positional `error(Error, code, reqId)`, unlike other paths using `ibErrorMeta`.
  Thus a matching broker error can be missed and appear as a timeout. This is an
  observed code defect, not proof that it caused the November 25 incident.
- `connected`, `server(version, connectionTime)`, `nextValidId`,
  `contractDetails`, `contractDetailsEnd` and `disconnected` are available events.
  Record observed milestones and numeric server version only; the broker's raw
  connection-time string and next-order-ID value are unnecessary.
- `reqContractDetails()` queues an SDK command and returns the IB object. Method
  return is not wire transmission, broker receipt or successful resolution.
  Raw `sent`, `received`, `all` and socket buffers must not be logged or hooked.

No deadline, retry/backoff, scheduling, pacing, transport-retirement, publication
fence, binding-verification, readiness, fallback, entry or broker-write policy
changes. No dependency/schema/configuration change, new endpoint, UI or persistent
diagnostic database. Leave the running bot and operational data untouched; tests
use fake emitters and isolated storage, with no broker/provider calls.

## Fixed implementation contract

### Request evidence and original cause

Add a small ingestion-local typed diagnostic representation, reusing shared
`captureResearchSourceError`, `sanitizeResearchSourceError`, `safeDiagnosticText`
and `DiagnosticPrivacy`. Do not introduce a generic telemetry framework.

For each contract-resolution request, record schema version, locally generated
attempt identity, request ID, captured transport generation, instrument identity
and allowlisted query fields (`conId`, symbol, secType, exchange, primaryExch /
primaryExchange, currency, localSymbol, tradingClass). Include wall timestamps
and monotonic elapsed milliseconds, configured timeout, observed matching detail
count and matching end-marker count, SDK invocation attempted/returned flags,
captured/current transport generations, local connected/retired/aborted flags,
and the connection milestone timestamps. Missing measurements are null. An
invalid/negative/nonfinite elapsed measurement remains null, never zero/success.

Use terminal categories `SUCCESS`, `TIMEOUT`, `BROKER_ERROR`, `SEND_THROW`,
`NO_DETAILS`, `AMBIGUOUS_DETAILS`, `INTERRUPTED`; retain the existing rejection
messages where practical for compatibility. `SUCCESS` means contract response
collection only, not verified binding, subscription, fresh candles or readiness.
Do not capture response payloads. A successful request requires the existing
end/count policy: exactly one for bound resolution; preserve legacy first-result
and override fallback semantics unchanged.

Normalize both installed metadata and supported positional error forms using the
existing decoder. Only a matching valid request ID on the captured transport can
be a request-specific broker error; unrelated IDs, absent IDs and global `-1`
events cannot be assigned as PKO's cause. Preserve sanitized original name, code
and message, including the separate metadata code, before wrapping the error.
If numeric normalization is unavailable, retain a bounded sanitized original
string code in the cause rather than replacing it with an invented numeric code.
Fixing the installed metadata shape may make an actual broker rejection terminate
immediately instead of timing out; this enforces the resolver's existing stated
semantics and is the sole intended behavior correction.

Timeout without a matching broker error states explicitly in Polish that the
broker-side cause is unknown. An internal timeout/abort code must never be
presented as an original broker error. A synchronous SDK exception is separately
identified as local, with its original sanitized cause; SDK invocation return
must never be described as transmission or receipt. A matching contract response
is evidence that this response was observed, without asserting wider farm health.

Observe the existing guards without adding calls that can trigger new continuity
invalidation. A diagnostic callback must not change settlement, retry, dispatch,
cleanup, pacing or publication. Exactly one terminal snapshot/event per attempt;
clean up timer/listeners on every result. Late/foreign/retired events cannot update
a terminal snapshot or become successor success/cause. Freeze/copy snapshots so
health/log consumers cannot mutate live request state. Preserve deadline checks
before event acceptance, including overdue buffered events before timeout fires.
Contain exceptions from the optional diagnostic callback so they cannot prevent
cleanup or change request settlement. An SDK invocation may synchronously emit a
terminal response/error before returning: freeze that terminal snapshot with
`sdkInvocationAttempted=true` and `sdkInvocationReturned=false`. A subsequent
return or throw must not mutate its evidence or cause a second terminal event.
Those flags describe observations at settlement, not a final SDK-call outcome.
Diagnostic snapshot/accessor functions must not call `continuous()` or any other
function that can invalidate a generation; inspect captured primitive state only.

### Connection context, bounds and privacy

Record observed socket-connected, server-handshake, nextValidId and disconnect /
local-retirement milestones on their own generation. A new generation starts
with empty milestones/global context. Snapshot prior evidence with its original
generation; never copy old farm status into a replacement connection.

Keep global broker/farm messages as a separately labeled bounded context list,
with code, observed timestamp, generation and sanitized original cause. They are
observations, not a diagnosis of a particular request or proof that every market
is reachable. Retain at most eight context messages per transport; retain at
most twenty terminal resolution snapshots overall plus the currently active
request. Expose truncation/count omissions when limits apply. Do not retain an
unbounded list of requests, errors, symbols, events or retired transports.
The core error listener runs before request listeners: capture sanitized global
context for codes 1100/1101/1102/1300 on the originating generation before its
existing synchronous retirement/abort. A pending request ends as `INTERRUPTED`,
with the global context separate; never relabel that event as PKO-specific error.

Reuse a single production privacy configuration for controller and TWS
diagnostics. Derive it using the existing `recoveryDiagnosticPrivacy` helper
where exported, or the same existing helper through its supported export; never
read or print `.env` for this task. Cover configured account IDs/allowlists,
secret/token/key/password variables and credential-bearing URLs. Shared helper
source changes are outside this plan; escalate if its export is inadequate.
Sanitize before retaining or logging, including names/codes/messages, labels,
query strings and global context. All free text is bounded (identity/query fields
at most 100 characters; error message at most 1000). Reject or redact accidental
JSON/array payload fragments and credential-bearing URL strings rather than
copying them into a diagnostic. No error stack, raw object spreading, accounts,
financial records, host endpoints, authentication headers or provider payloads.
Retained diagnostics must contain only approved primitive fields and arrays of
approved records. Privacy tests inspect both logs and serialized health output.

### Production logs and health

Add structured Polish request-start/terminal logs through a typed optional TWS
diagnostic callback wired to Fastify's structured logger. A normal request emits
one start and one terminal event; count responses without per-response logs.
Replace affected raw contract-failure/core-broker-error logging with sanitized
equivalents so the same original cause cannot leak through the old string path.
Do not refactor unrelated historical/tick logging in this package.

Add a read-only `contractResolution` section to existing `/health`, containing
bounded request/transport diagnostics, with active versus retained historical
attempts clearly distinguished. Preserve existing health fields and their
semantics. During incomplete bootstrap, expose the specific failed instrument,
request category and original cause alongside the generic controller error.
Supplement `automaticBootstrap` diagnostics with the captured incomplete-attempt
failure detail (or carry its safe cause through the existing failure object),
without replacing unrelated failures by an old contract failure. Snapshot the
correct attempt before existing invalidation/disconnect clears active state.
Maintain a separate current-bootstrap failure list, scoped to its attempt, with
at most twenty entries plus an omitted-failure count and truncation flag. This
list is independent of the twenty-request history ring: an early PKO failure
must survive more than twenty subsequent successful resolutions. Retain the
first twenty failures in that attempt; count every further failure as omitted,
without creating an unbounded instrument map. Do not select AAPL's success as
PKO's cause. Successful later bootstrap
clears current failure attribution; retained prior attempts keep their terminal
status/time/generation and are visibly historical. Any binding mismatch remains
separately identified by the existing verification path, never relabeled timeout.
Starting a new bootstrap replaces the previous attempt's current failure list;
an unrelated newer bootstrap exception must not carry the old list as its cause.

## Permitted files and sequencing

Implementation files only:

- `apps/ingestion/src/tws-client.ts`
- `apps/ingestion/src/contract-resolution-diagnostics.ts` (new local types/helpers)
- `apps/ingestion/src/index.ts`
- `apps/ingestion/src/auto-bootstrap.ts` (additive diagnostic propagation only)
- `apps/ingestion/src/tws-client.contract-details.test.ts`
- `apps/ingestion/src/tws-client.wake.test.ts`
- `apps/ingestion/src/auto-bootstrap.test.ts`
- `apps/ingestion/src/contract-resolution-diagnostics.test.ts` (new)
- This plan and `INGESTION_CONTRACT_DIAGNOSTICS_REPORT.md` in this directory.

Read AGENTS.md, roadmap, linked contracts and relevant source before editing.
Independent Astra/high plan acceptance precedes implementation. A different
independent Astra/high agent reviews the integrated implementation, privacy,
failure attribution and hostile event ordering. The implementer may own this
coherent small package; avoid overlapping writers. Stop and update/review the
plan if a needed edit changes any excluded policy, shared API or file scope.

Preserve pre-existing backtest changes, `apps/signal-engine/src/signal-engine.ts`,
`AUTOMATIC_PAPER_STARTUP_RECOVERY_REPORT.md` and all other unrelated local work.
Validation/publication uses clean HEAD plus an explicitly selected package
overlay, not blanket copying/staging of the dirty tree. Work on main; no branch,
PR, runtime restart, deployment or operational database mutation.

## Acceptance and validation

1. Matching positional and installed `{ id, code }` errors preserve sanitized
   name/code/message and terminate the correct request. Concurrent wrong IDs,
   global farm messages, missing IDs and old-transport errors do not do so.
2. Zero-response timeout and partial-response/no-end timeout expose different
   counts, eight-second configured deadline, SDK-call evidence and unknown broker
   cause. Zero details with end, ambiguity, normal success, local synchronous
   throw and abort each produce exactly one accurate terminal record.
3. Buffered expired events, pre-aborted input, disconnect, manual stop and
   replacement transport preserve cleanup/fences and cannot publish late success
   or overwrite current attribution. Existing sleep/wake regressions still pass.
   Synchronous terminal emission followed by SDK return or throw freezes the
   original flags/result and emits once; throwing diagnostic callbacks cannot
   alter settlement, dispatch or cleanup.
4. Fixture PKO failure plus AAPL success yields the original PKO diagnostic in
   health and the incomplete-bootstrap diagnostic after invalidation; later
   success clears current failure. A newer unrelated bootstrap exception does
   not inherit old PKO attribution. Retry delays/readiness remain unchanged.
   An early PKO failure followed by more than twenty successes remains in current
   bootstrap failure attribution even after request history evicts it. More than
   twenty failures retain twenty records with exact omitted count/truncation.
5. Structured Polish logs and health redact fixture accounts, secrets (including
   encoded values), bearer text, credential URLs, control characters and payload
   fragments. Query/label/global/error fields all obey size limits. History and
   global rings remain bounded; consumers cannot mutate internal snapshots.
6. Production wiring supplies privacy and the diagnostic callback, shares the
   same accessor tested in fixtures, and does not enable raw SDK traffic logging.

Targeted: `pnpm --filter @ikbr/ingestion test`,
`pnpm --filter @ikbr/ingestion typecheck`, and scoped ESLint. Full release gates:
`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`.
Run integration with isolated PostgreSQL and valid test-only connection settings;
never use the operational database. A dedicated container network namespace may
provide `localhost:5432/ikbr_trader_ci` with `CI=true` for existing fixture guards.
No strategy/simulator behavior change means no additional backtest is required.
No deployment/configuration change is planned; a later authorized deployment
needs its own clean Docker build and operational evidence.

Write the report, inspect scoped diff/links, commit/push on main and verify CI
for the exact published commit. Report inability to access publication/CI rather
than declaring completion. Local `gh` is absent, but the lead verified that the
public GitHub Actions API is accessible; it may supply exact-commit CI evidence.
Passing fixture tests proves diagnostic behavior, not PKO market-data recovery
or the historical incident's broker-side cause.

## Routing record

Plan task: `diagnostics_contract`; critical privacy/read-fencing contract route A,
requested model/effort supplied by lead dispatch (record in final package report).
Actual model/effort telemetry and token usage: unavailable to this task.
Plan author recorded clock observation: 2026-11-25 12:15:54 UTC; complete elapsed
task time unavailable because no start measurement was captured. Repair count
at draft: zero; accepted after one review repair round, no escalation. Independent
review resolved synchronous SDK/callback evidence isolation and bounded current-
bootstrap attribution. Report actual review/repair and
validation evidence without inventing token or elapsed-time telemetry.
