# PP7 F1: qualified TWS account-day accounting source

2026-10-06. **Independent critical plan review accepted after repair of two
blocking findings: first-account qualification and both-socket freshness fences.** Supplements F1 in
[the closure plan](PP7_CLOSURE_PLAN.md). This document does not qualify the actual
broker host or complete PP7-F. Requested route: Astra/high; actual model telemetry,
token usage and elapsed time are unavailable. No broker or paid-provider calls
were made while authoring this contract.

## 1. Decision and supported scope

Implement a dedicated, read-only `@stoqey/ib` accounting connection, using client
ID 0, to an explicitly qualified **TWS** host whose Master Client ID is 0 and Trade
Log is configured to show seven days. Keep broker writes on the existing `ib`
execution connection. Do not upgrade either SDK as part of F1. The installed
`@stoqey/ib` 1.6.10 supports legacy execution requests, commission callbacks and
pending-price-revision decoding; its execution filter does not support the newer
protobuf `lastNDays` field. The installed `ib` 0.2.9 advertises client version 62.

IBKR's current [execution introduction][executions] explicitly documents the
seven-day TWS setting and distinguishes IB Gateway's current-day limit. This is
the source of the retention guarantee. An execution request's requested start,
its end marker, process uptime or a configuration boolean cannot create that
guarantee. [Master 0 together with connected client 0][master] supplies documented
visibility of TWS, FIX and other API clients for the account. A filter containing
clientId 0 on the existing nonmaster connection is insufficient.

Support one exact allowlisted Paper account and one exact configured broker
host/port per source. The source endpoint must equal the execution endpoint;
reject an alternate hostname, port or account rather than silently resolving a
different source. Do not infer environment or host product from the port. Live
remains unsupported by this first source contract. Existing reconciliation keeps
its existing behavior when the source is unconfigured; it never gains positive
account-day certification from the old adapter.

Observed deployment prerequisites remain unresolved: master writes are disabled,
the configured endpoint was unavailable, and the owner has not yet identified the
actual Gateway/TWS product and version. If it is Gateway, this route requires an
owner-configured TWS host. Never switch hosts, change broker settings, bind manual
orders, or operate the broker UI automatically.

## 2. Honest qualification boundary

The API handshake provides a negotiated protocol version, not trustworthy TWS
product/build or Trade Log retention settings. Installed adapters do not expose
`reqConfigProtoBuf`. The newer official [API settings response][api-settings]
contains Master Client ID, but does not provide the seven-day Trade Log setting
or execution timestamp timezone. Its historical-data timezone option must not be
used as an execution timezone assertion. Adding this API is outside F1.

An authorized operator may supply facts about settings under their control, as
they already supply `EXECUTION_BROKER_TIME_ZONE`. They must explicitly attest to
those facts with dated local evidence. This is an **operator configuration trust
boundary**, not API attestation or an IBKR-signed certificate. Hashes establish
which evidence was accepted; they do not prove the contents truthful. No arbitrary
source URL, `coverage: true`, imported `certifiedFrom` or self-authored execution
list is accepted as evidence of broker completeness.

Unobservable settings can change without a callback. This implementation cannot
detect every intra-session Master/retention setting change. The operator must
pause entries before changing the host/settings and invalidate its qualification.
Finite settings expiry, fresh connection binding and replay checks reduce stale trust; they
do not remove this limitation. Review and operational acceptance must explicitly
accept this controlled-host assumption. A deployment requiring automatic detection
of every such change needs a separately reviewed host-settings reader or supported
new configuration API, and cannot claim that property from F1.

### 2.1 Private settings and attestation schema

Use a strict versioned JSON input, no unknown fields. Store outside the repository
in an operator-owned directory, directory mode 0700 and file mode 0600; reject
symlinks and nonregular evidence files. Do not print account IDs or file contents.
The exact input shape is:

```typescript
type SourceSettingsV1 = {
  schemaVersion: 1;
  sourceKind: "ibkr-tws-seven-day-v1";
  environment: "paper";
  accountId: string;
  endpoint: { host: string; port: number };
  sourceClientId: 0;
  executionTimeZone: "UTC" | "Europe/Warsaw";
};
type OperatorQualificationV1 = {
  schemaVersion: 1;
  sourceKind: "ibkr-tws-seven-day-v1";
  settingsSha256: string;
  inspectionId: string;
  operator: string;
  observedAt: string;
  product: "TWS";
  productVersion: string;
  productBuild: string;
  tradeLogDays: 7;
  masterClientId: 0;
  executionTimeZone: "UTC" | "Europe/Warsaw";
  confirmations: {
    exactEndpointAndAccount: true;
    evidenceBelongsToCurrentHostSession: true;
    noSettingsChangeSinceEvidence: true;
    pauseAndRequalifyBeforeSettingsChange: true;
  };
  artifacts: Array<{
    kind: "tws-product-build" | "tws-trade-log-seven-days" |
          "tws-master-client-zero" | "execution-timezone";
    relativePath: string;
    sha256: string;
    observedAt: string;
  }>;
};
```

All four artifact kinds are mandatory, exactly once. A dated screenshot or
operator-exported narrow settings excerpt is valid; a screenshot may be reused
for two kinds only if it actually shows both settings. Limit each artifact to
5 MB, total 20 MB; allow only PNG, JPEG and UTF-8 text. Resolve relative paths
strictly within the supplied private evidence directory. Do not OCR, fetch URLs
or automate the UI. The operator, not an image classifier, confirms the fields.
Reject future dates, empty/unbounded identity strings and mismatched settings.

Artifacts and attestation must be observed within the previous 30 minutes at
initial recording. The fresh inspection used to record qualification must be less
than ten seconds old. The supplied inspection ID anchors the inspected host and
configuration; it is not a freshness exemption. Settings qualification expires
exactly seven days after operator observation and is bound to settings hash,
product/build, negotiated protocol, source account and endpoint. It records the
initial inspected source session, but does not claim that socket lasts seven days.

Separately create an immutable **connection acceptance receipt** for each source
process session/connection generation. Reusing an unexpired settings qualification
requires exact account/endpoint/client/timezone/protocol matching, no revocation,
successful handshake/managed-account response, and a fresh full replay including
all required costs. Product/build/settings facts not API-readable remain the
operator's explicit unchanged-host assumption. Changed host/build/settings/account
requires new operator evidence even when protocol happens to stay unchanged.

Routine reconnect, process restart and Warsaw day rollover require new applicable
session/day captures and full replay, not new screenshots. Upstream reset on the
same local socket likewise invalidates all positive captures until full replay.
The seven-day settings validity is a bounded administrative trust period, not
seven-day accounting freshness. Every entry still requires evidence less than ten
seconds old. No recovery action retries an order.

### 2.2 Qualification observations

The service must already have its read-only collector running, with entries
ineligible until qualification succeeds. An inspection references durable source
observations from that exact connection: handshake/protocol, managed accounts,
broker clock, complete unfiltered execution replay, commission correlation and
source errors. Record historical corroboration as `OBSERVED` when a replayed
execution from a prior Warsaw account date within the previous five days has
matching finite commission/realized-P&L fields, otherwise `NOT_OBSERVED` with a
reason. A sample corroborates retention and delivery; it neither establishes
completeness nor is a prerequisite for qualification. Never fabricate a sample or
submit an order to manufacture one. If a relevant current-day execution lacks
required costs, the accounting capture still holds under section 6.

Reviewed documented retention, valid controlled-host settings evidence and a
successful complete fresh capture can qualify an empty or inactive Paper account
for its first entry. Obtain historical corroboration naturally during supervised
acceptance when available; absent history is an explicit observation, not failure.
Raw handshake time text is retained, but does not independently establish timezone.
Ambiguous or nonexistent Warsaw execution timestamps remain holds.

## 3. Safe command workflow

Add one execution-engine CLI script, exposed as
`pnpm --filter @ikbr/execution-engine accounting:source -- <command>`.
Commands use existing service configuration and authenticated operator access;
they require no new trading/API key and never print existing credentials. A
qualification record is a local administrative database write, **not** a broker
write or trading authorization. The CLI must explicitly report that distinction.

1. Operator configures private settings, sets
   `EXECUTION_ACCOUNTING_SOURCE_PATH` and its SHA-256 companion
   `EXECUTION_ACCOUNTING_SOURCE_SHA256`, and starts the disabled/entry-paused
   service. Unset both preserves the old behavior; partial configuration rejects
   startup. Validate Paper allowlist, endpoint equality, configured timezone and
   client-ID collisions before opening the source socket.
2. `inspect --out /private/path/inspection.json` requests one bounded read-only
   inspection on the service's existing accounting socket. It must not open a
   competing client 0. Return a redacted status plus private inspection reference;
   never derive readiness from a TCP probe alone. One timeout ends that command.
3. Operator reviews the actual current TWS settings and supplies the attestation
   JSON and private artifacts. `qualify --input /private/path/qualification.json
   --evidence-dir /private/path/evidence` obtains a fresh inspection on the same
   socket, validates the supplied inspection's immutable connection identity, and
   records qualification only if that connection is still current. The command
   prints qualification ID, expiry, settings hash and remaining holds. The old
   inspection's age must not be used to avoid the fresh inspection requirement.
4. `status` reads current qualification, connection acceptance, source generation, outstanding fee count,
   coverage/capture revision and named holds. `invalidate --reason <bounded-text>`
   revokes the qualification and positive certificates immediately. Neither
   command changes entry pause, master writes, orders or positions.

Implement the CLI via the existing authenticated operator/service boundary:
`GET /execution/accounting/source/status`,
`POST /execution/accounting/source/inspect`,
`POST /execution/accounting/source/qualify`, and
`POST /execution/accounting/source/invalidate`. Reuse the existing execution API
token/auth validation for all four. Inspection is POST because it records evidence;
the only broker effects are read requests. Qualification uploads bounded evidence
digests and validated metadata, not raw artifacts; the local CLI verifies bytes
before recording claims no stronger than operator attestation. No arbitrary filesystem
paths are resolved by the server. Require entries paused for operator qualification.
Allow authenticated invalidation while entries are running: atomically revoke the
settings qualification and advance the admission revision, with an immediate
in-memory dirty flag before awaiting persistence. Never require a prior pause to
perform revocation. Never use master-off as a substitute for pause or shut down exit
supervision. First disabled adoption additionally retains existing PP5 requirements.

The collector's socket facade exposes only connect/disconnect, event subscription,
managed accounts, current time and execution requests. It must not expose order
submission, cancellation, auto-binding, `reqAutoOpenOrders`, `reqOpenOrders`,
exercise, account-setting or UI methods. Inspection reconnects are bounded source
recovery operations; no unknown broker write is retried. Missing credentials or an
unavailable endpoint is a named failure, not a prompt to guess another port.

## 4. Durable source state and append-only evidence

Use new additive migrations and four narrowly scoped tables:

- `broker_accounting_sources`: stable source identity and current process/session,
  connection generation, monotonic semantic revision, qualification ID,
  received/persisted sequences and pending counts for both accounting and execution
  socket lanes, plus invalidation/gap state. This mutable control row is
  locked by every evidence append and final entry fence.
- `broker_accounting_qualifications`: immutable validated attestation metadata,
  settings/artifact digests, fixed contract version, referenced inspection, source
  identity, creation and expiry. Revocations are append-only observations, not
  deletion or editing of the attestation.
- `broker_accounting_observations`: append-only sequence, source/session/generation,
  request ID, callback kind, receive timestamp, original timestamp text, normalized
  broker identifiers, bounded original payload and canonical payload digest.
  Include connection/errors, snapshot start/end, execution/commission events,
  parsing failures, qualification/revocation and persistence recovery records.
  Connection acceptance receipts are immutable typed observations containing the
  settings qualification ID, both socket identities, handshake/account references
  and accepted replay observation/end references. Insert the receipt and first
  capture referencing it in the same publication transaction. Use the receipt's
  observation ID as its ID; no fifth
  table or mutable settings attestation is needed.
- `broker_accounting_captures`: immutable capture ID, qualification/source IDs,
  source observation revision and covered sequence interval, replay request/end
  references, normalized execution/fee mapping digest, account/date, source and
  execution connection identities, positions/reconciliation references, source
  clock anchors, covered interval, completion timestamp and canonical fingerprint.

Runtime role may INSERT and SELECT immutable tables, not UPDATE/DELETE them.
Administrative retention cannot erase evidence used by an active entry/lifecycle;
retention policy is separate from F1. Never modify previously released migration
files or repurpose mutable `broker_execution_fills` as the ledger authority.

Minimal repository operations are `beginSourceSession`,
`appendSourceObservationsAndAdvanceRevision`, `recordQualification`,
`revokeQualification`, `commitAccountingCapture`, `readLatestAccountingEvidence`
and `lockAndAssertAccountingRevision`. Append plus revision/gap update is one
transaction. Capture publication locks the same source row, verifies all referenced
observations and revisions, and never accepts caller-supplied positive bounds.

Before any callback awaits persistence it synchronously marks its in-memory source
revision dirty and ineligible. Persist in arrival order, with bounded buffering;
overflow or write failure holds immediately. A crash before persistence leaves no
reusable connection-qualified certificate. A new process starts with admission
held, validates any unexpired settings qualification and replays for a new receipt.
Publish only after all relevant writes complete. Do not hold a transaction
open while waiting for broker callbacks.

## 5. Replay and certificate construction

Listeners for executions, fees, connection and errors are installed before
connection readiness. One replay is active per source. Use a unique request ID,
exact account, clientId 0, and empty time/symbol/security-type/exchange/side filters.
Do not apply a symbol whitelist to acquisition. Validate every returned account;
foreign, missing or contradictory identity invalidates the whole capture.

Read broker time before requesting executions. Require an unambiguous UTC anchor,
local/broker clock difference at most two seconds, and a successful end marker for
the matching execution request. Use that preceding broker-time anchor as the
conservative `coveredThrough`; do not claim that receipt time extends the snapshot
interval. The seven-day qualified retention contract supports a deliberately
smaller 48-hour replay floor before the anchor. This floor is derived from the
qualified source guarantee, not from a requested filter. It must precede the exact
Warsaw midnight of the account date. Preserve DST-aware day-boundary calculation.

An unfiltered response may include older records; retain all observations, but only
the covered account-day execution set enters that day's loss calculation. Preserve
existing exposure/recovery coverage checks independently; F1's 48-hour floor cannot
resolve an older unknown submission or missing completed-order history. Existing
positions, all-open-orders and completed-orders acquisition must still pass.
If any observed account-day execution falls after `coveredThrough`, require a new
clock anchor and replay; do not publish a certificate that excludes known newer
activity. A clock anchor must belong to the same Warsaw date as admission.

Fee callbacks are keyed by exact execution ID and may arrive before or after
`execDetailsEnd`. That marker ends execution retrieval, not fee collection.
Publish only when every relevant execution has a matching finite commission,
supported currency and finite realized P&L. A bounded ten-second acquisition
deadline may yield a hold; it never fills missing values with zero. Because the
existing freshness rule is strictly less than ten seconds, a slow capture may
require another full read after costs become available. That is a read retry, not
an order retry. Avoid an unbounded tight retry loop.

Deduplicate identical execution/fee payloads, retaining their observation
references; do not increment the semantic invalidation revision merely because an
identical replay repeats them. Changed payloads, new executions, changed fees,
pending price revision, parse failures or source errors advance it and invalidate
published evidence. Store both acquisition sequence and semantic revision so an
identical refresh can produce a new immutable fresh capture without concealing
changes. A valid empty replay can publish zero only with qualification, matching
end, broker-time coverage, all other broker snapshots and unchanged source state.

The certificate DTO carries `captureId`, `qualificationId`, `connectionReceiptId`, `sourceId`,
`sourceProcessSessionId`, `sourceConnectionGeneration`, `observationRevision`,
`executionSessionId`, `executionConnectionGeneration`, `reconciliationRunId`,
`positionGeneration`, both lane persisted sequence barriers, `accountDate`, `periodStart`, `certifiedFrom`,
`coveredThrough`, `capturedAt`, observation/end references and canonical fingerprint.
These fields are created from persisted service evidence, never accepted as a
client certificate. The reader revalidates referential integrity and current
qualification/revision; a matching JSON fingerprint alone is insufficient.

## 6. Costs, corrections and accounting limits

IBKR documents execution and commission callbacks, but promises neither a fixed
commission delay nor immutable final costs in [the commission report contract][fees].
Therefore evidence represents complete observed executions with all currently
reported required costs as of the capture, not a promise against future broker
correction. Any later change immediately invalidates entry evidence and requires
fresh accounting. Do not use a grace timer to assert missing fees final.

Preserve current debit semantics: per execution add `max(0, -realizedPnl)` plus
`max(0, commission)` in its supported currency. No netting gains against losses,
currency conversion, opening-fill zero substitution or widening of supported
security/accounting types in F1. Broker unset/sentinel numbers, nonfinite values,
currency mismatch, orphan fees or contradictory rows hold. An opening execution
with unset realized P&L may prevent a second entry; this is an explicit operational
limitation to qualify before the separate two-position extension. Exit supervision
and supported closes remain available under their existing guards.

[Correction IDs][corrections] differ after their final period, and combination
identifiers can have additional segments. Do not assume numeric suffix ordering.
Retain every payload and identify a potential correction family conservatively;
any changed payload for an exact ID or plausible corrected/busted family in the
account day creates a durable `ACCOUNTING_CORRECTION_UNRESOLVED` hold. Replay must
not silently discard the original or sum both. Clearing that hold requires a
separately reviewed accounting resolution with retained audit evidence; restarting
the service is not resolution. A correction for older executions holds if its
account-day relevance cannot be determined.

## 7. Integration and entry fences

### 7.1 Two-connection semantic revision barrier

The existing execution callbacks in `index.ts` set `lastBrokerFillObservedAt` to
local receipt time for every execution and commission, including exact historical
duplicates. `paper-daily-loss.ts`, `readFreshAiRisk`, the research-context route and
`ExecutionRepository.assertPaperRiskUnchanged` currently use that time directly or
indirectly. Comparing it with a broker-time anchor preceding replay would reject
every positive replay. F1 must explicitly replace that comparison for qualified
accounting with the following shared evidence barrier, not move the watermark to
completion time or delete a safety check without replacement.

Maintain two ingress lanes, `accounting` and `execution`, under the same account
authority. Each callback synchronously increments its lane's received sequence and
pending count **before** any duplicate query or persistence await. Admission is
ineligible while either lane has unclassified or unpersisted callbacks. Append
observations through a per-account serialized writer that locks the source control
row. After canonical comparison with durable execution/fee evidence, atomically
advance that lane's persisted sequence and decrement its pending count. Only new
or changed information advances the shared semantic revision. An exact persisted
duplicate advances acquisition sequence but leaves semantic revision unchanged.
Failed persistence leaves the pending/gap hold latched. These checks are in addition
to existing exposure-generation invalidation, not a replacement for it.

Canonical duplicate classification compares normalized broker identity, execution
time, side/quantity/price, instrument/currency and all received fee/accounting values.
Never use callback receipt time as broker event time. SDK-specific absent optional
fields cannot clear authoritative pending-price/correction/unset-value flags; a
contradiction in a supplied field is a semantic change. Unknown account or orphan
fee identity remains held until exact execution association is established. The
existing mutable fill upsert completes before its lane is durable; it cannot be
used to erase a changed immutable source payload. Both socket lanes feed this
authority, including callbacks used by old `reqExecutionsSnapshot`.

At join, acquire the common control-row lock after both lanes have drained, record
both persisted sequence barriers, the shared semantic revision and both connection
identities, and verify that every observed relevant account-day execution and fee
is represented in the complete accounting replay with no contradictions. A new
execution or fee known only to the execution socket invalidates the join until the
accounting source includes it. Any execution later than the preceding broker-time
anchor requires a new anchored replay. The existing positions/reconciliation
generation must also match. Publish the capture only while those facts still hold.

At early risk, research-context issuance and final admission, require unchanged
semantic revision and connections, no gap/pending work, and current received
sequence equal to durable processed sequence on **each** lane. A later fully
persisted exact duplicate may advance both sequences beyond the saved barrier and
still use the capture; a new value, an unresolved duplicate comparison or a failed
write cannot. This lets old execution/fee replays after the watermark pass without
ignoring genuine post-capture changes. Preserve receipt timestamps for diagnostics
and existing unconfigured flows; they are not qualified accounting's completeness
fence. The durable fence and immediate in-memory pending/dirty check must both pass.

### 7.2 Consumers and final dispatch

Extend `reconciliation/broker-adapter.ts` with optional accounting source evidence.
`IbBrokerAdapter.capture` joins a qualified source capture with the existing
execution connection's broker-state capture. Source and execution sessions are
different identities: do not replace the existing execution session/generation
checks with the accounting generation or pretend both sockets have one session.
Cross-reference the immutable capture and reconciliation run only after both
connections and position generation remain unchanged. Failed joins remain holds.

`paper-daily-loss.ts` reads the new immutable source evidence and exact mapped
execution/fee records for the account day; it still verifies current CLEAN complete
reconciliation, account/session/generation, positions, timestamps, currencies,
counts and caps. Preserve its strictly-less-than-ten-seconds freshness test and
Warsaw day identity. The old mutable fill projection remains usable by existing
trades/audit views, but cannot erase conflicting source observations or prove
completeness. Keep the existing early AI/risk and final execution admission checks.

Wire the shared barrier into `paperDailyContext`, `readFreshAiRisk` before returning
evidence, the research-context route after its asynchronous reconciliation read,
`readPaperDailyLoss`/`assertPaperDailyLossUnchanged`, and the repository's final
`assertPaperRiskUnchanged`. Inspect every `lastBrokerFillObservedAt` consumer and
retain its old branch only for unconfigured accounting. No qualified route may
mix receipt-time comparison with the new broker-time watermark.

Within the final existing transactional entry fence, lock the accounting source
control row and assert capture/qualification identity, expiry, semantic revision,
no pending persistence/gap/correction, both connection generations and the existing
daily-loss fingerprint. Both in-process lane barriers and semantic revision must pass
immediately before broker dispatch, including callbacks queued during transaction
work. New data or disconnect wins over a prior clean read. This is the same bounded
fresh evidence model as existing risk checks, not atomicity between IBKR's remote
account and our transaction. Do not hold the SQL lock across a broker submission,
retry an unknown outcome or change the dispatch/close algorithms.

## 8. Named failure states and recovery

Use stable diagnostic codes, including:

| Code | Entry effect and recovery |
| --- | --- |
| `ACCOUNTING_SOURCE_UNCONFIGURED` | Old reconciliation continues; no certified accounting. |
| `ACCOUNTING_HOST_UNSUPPORTED` | Gateway/unqualified product; operator selects supported host. |
| `ACCOUNTING_SETTINGS_MISMATCH` | Endpoint/account/timezone/client conflict; repair explicit configuration. |
| `ACCOUNTING_QUALIFICATION_REQUIRED` / `EXPIRED` | Operator records or renews bounded source-settings evidence. |
| `ACCOUNTING_CONNECTION_UNACCEPTED` | New source connection requires verified identity and complete fresh replay. |
| `ACCOUNTING_SOURCE_GAP` | Disconnect/reset/1100/1300 invalidates; fresh full replay and new connection receipt when needed. |
| `ACCOUNTING_REPLAY_INCOMPLETE` | Missing end, timeout, error or wrong request; bounded fresh read. |
| `ACCOUNTING_FEE_PENDING` / `ACCOUNTING_VALUE_UNSET` | Wait for real matching report; never substitute zero. |
| `ACCOUNTING_CORRECTION_UNRESOLVED` | Durable hold; separate audited resolution contract. |
| `ACCOUNTING_PERSISTENCE_PENDING` / `FAILED` | No publication or admission until durable recovery. |
| `ACCOUNTING_IDENTITY_INVALID` | Whole capture invalid; no filtering away bad rows. |
| `ACCOUNTING_CLOCK_INVALID` | Explicit disabled-Paper `recover-clock` after fresh complete evidence; see the bounded recovery contract below. |
| `ACCOUNTING_TIMESTAMP_INVALID` | Repair configuration/evidence; clock recovery cannot clear this hold. |
| `ACCOUNTING_EVIDENCE_STALE` / `REVISION_CHANGED` | Fresh complete capture required. |

The [clock recovery plan](PP7_ACCOUNTING_CLOCK_RECOVERY_PLAN.md) adds only an
explicit authenticated `POST /execution/accounting/source/recover-clock` operation.
Server-owned Paper, disabled-write and effective-pause guards apply. A newly
instantiated accounting socket fences retired callbacks and accepts a clock only
after its request is armed. A valid clock plus complete replay/real costs is checked
against immutable observations, both clocks and the current source-row revision.
Retained non-clock contradictions, including previously overwritten ones, refuse
recovery. The immutable receipt and exact clock-hold clear commit together; gap
stays true, old captures stay invalid and qualification ID/expiry do not change.
Normal qualification and joined reconciliation remain separate entry requirements.
This operation cannot clear timestamp, identity, correction or persistence holds.

[IBKR reset messages][resets] allow delayed execution reports during upstream
outages. Neither 1101 nor 1102 closes an accounting gap. Always replay after
upstream restoration, even when market data is reported maintained. Never clear a
gap from callback silence. A new local source generation invalidates its predecessor's
connection receipt, but may use unexpired unchanged settings qualification.

## 9. File ownership, validation and release boundary

F1 owns new execution-engine accounting source/qualification/ledger modules and
tests, additive acquisition migrations, `reconciliation/broker-adapter.ts`,
`reconciliation/ib-broker-adapter.ts`, `paper-daily-loss.ts`, the existing final
repository fences, execution configuration/startup wiring, and this CLI's package
script/authenticated routes. Coordinate shared DTO changes first. Preserve dirty
files and avoid strategy, research, close algorithm and order-routing edits. A
reviewed implementation plan must enumerate exact files/migration numbers before
concurrent authors work. Contract drafting was documentation-only; runtime work
uses the separate bounded packet below.

### F1 implementation packet

One Astra/high implementation owner owns this coherent critical package. Integrate
the internal DTOs first and report their shape to the lead before wiring consumers.
No concurrent author edits these paths:

- New `apps/execution-engine/src/accounting/types.ts`, `config.ts`,
  `source-store.ts`, `source-collector.ts`, `source-service.ts`, `source-cli.ts`,
  `routes.ts` and matching unit/integration test files in that directory.
- New `infra/sql/migrations/000027_broker_accounting_source.sql` (latest released
  migration is 000026). Additive four-table storage and append-only enforcement;
  released migrations stay unchanged.
- Existing `apps/execution-engine/src/reconciliation/broker-adapter.ts`,
  `ib-broker-adapter.ts` and their tests; `paper-daily-loss.ts` and tests;
  `repository.ts` solely the qualified accounting reader/final fence integration;
  `index.ts` solely both execution callback lanes, accounting startup/shutdown,
  authenticated source routes and early/research/final accounting checks;
  `config.ts` and tests for the two optional source settings variables and
  validation; `package.json` for the source CLI script.
- Existing `apps/execution-engine/src/write-guard-exemptions.ts` and tests, only
  exact authenticated/account-guarded POST exemptions for source `inspect`,
  `qualify` and `invalidate` while master writes are disabled. No prefix exemption;
  qualification still requires pause and revocation remains available immediately.
  `reconciliation/runner.ts` and tests may pass the already-created run ID and
  actual position generation to the capture join; never guess the latest run.
- Existing `apps/execution-engine/src/tws-execution-client.ts` and tests only if
  retaining the original execution timestamp and currently discarded accounting
  fields is required by the accepted cross-SDK canonical comparison. No order
  construction, routing, retry or close semantics changes.

The lead owns deployment/example environment documentation and release reporting
after reviewing the worker's exported interfaces. No new external dependency or
shared research schema is planned. Stop and escalate if required semantics,
cross-service contracts, client capabilities or file scope differ from this
contract. Do not resolve a positive test by weakening holds or fabricating costs.
No actual broker connection, settings adoption, provider call, operational database
mutation, staging or publication belongs in the worker's task. Synthetic socket
and isolated database tests exercise production collector/service/repository code.
The lead supplies an isolated test database URL; never infer it from `.env`.

Worker validation is targeted Node test runner, package typecheck/lint, new
PostgreSQL integration cases and a concise changed-files/evidence report. The
lead performs required repository checks, clean Docker build, separate hostile
implementation review, scoped publication and exact-commit CI. Final reviewer
must be different from the plan reviewer and implementation owner.

Required pure/isolated tests cover a positive production-wired first empty account
with no historical trade (`NOT_OBSERVED` corroboration), a complete filled day,
natural prior-day corroboration, all-origin sample
mapping, UTC/Warsaw/DST boundaries, older returned rows, duplicate callbacks,
late/missing/unset fees, corrections/bust ambiguity, pending price revisions,
foreign account, client collision, artifacts/settings tampering, expired and
replayed qualification, wrong endpoint/protocol/session, clock skew, failed end,
disconnect after end, callback before persistence, database failure, restart/replay,
cross-socket generation drift, current-state join failure and capture tampering.
Explicitly prove positive old execution and old fee duplicates received after the
broker-time anchor on either socket; deny while either duplicate is unpersisted;
deny a new execution during replay until a new anchored complete join; deny changed
fees or execution data between join, early risk, research-context creation and
final transaction/dispatch. Verify local reconnect/day rollover reuses unexpired
settings only with new required capture/receipt; changed settings or expiry require
operator renewal. Prove revocation during running entries invalidates the final
fence immediately. Positive tests must exercise the actual
source adapter and certificate reader, not inject `certifiedFrom` directly.

Integration tests use isolated PostgreSQL and prove append-only constraints,
atomic revision/capture publication and competing append/final-fence ordering.
Run all checks required by AGENTS.md, including lint/typecheck/tests/integration/
build and clean Docker build for deployment changes. Have an independent Astra/high
plan reviewer accept this contract before code, and a different independent
Astra/high reviewer examine implementation and hostile cases. Record findings,
repairs, actual route and available telemetry in the implementation report.

Rollback disables the source path and pauses entries; it restores old
reconciliation behavior without positive accounting. Keep additive tables and all
evidence; do not down-migrate or delete acquisitions. Database rollback is not a
broker action. Continue supported exits and protection under existing controls.

Code acceptance proves the positive mechanism and failure invariants. Operational
acceptance separately requires actual supported host/settings, historical replay
corroboration status recorded honestly, a qualified current source connection, fresh production capture,
real account state, real-source hostile/reconnect evidence and the existing Gate A
checks. First PKO entry still uses the normal proposal/AI/risk flow and separately
authorized trading scope. Do not claim F complete from fixtures, an empty database,
`/ready`, a generated settings file, or documentation alone.

[executions]: https://www.interactivebrokers.com/docs/tws-api/doc/order-management/execution-details/introduction
[master]: https://www.interactivebrokers.com/docs/tws-api/doc/order-management/client-id-0-and-the-master-client-id
[api-settings]: https://www.interactivebrokers.com/docs/tws-api/protobuf/api-settings-config
[fees]: https://www.interactivebrokers.com/docs/tws-api/doc/order-management/commission-and-fees-report
[corrections]: https://www.interactivebrokers.com/docs/tws-api/doc/order-management/execution-details/exec-id-behavior
[resets]: https://www.interactivebrokers.com/docs/tws-api/doc/error-handling/system-message-codes
