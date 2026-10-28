# Automatic accounting capability contract (D0)

Status: independently accepted by `automatic_startup_plan_review` (Astra/high), 2026-10-28. This is the bounded
D package under [the startup/recovery plan](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md).
Author: `automatic_source_capabilities`, requested/actual `gpt-6-astra` / high.
This contract authorizes implementation only after review acceptance. Research
downloaded public SDK source into temporary storage. A separately authorized
bounded read-only capability probe then read managed accounts and API settings;
it made no execution/order request, runtime deployment, configuration write or
paid-provider call.

## Outcome and boundaries

Replace recurring manual accounting qualification with generation-scoped API
evidence. Keep existing TypeScript accounting normalization, storage, barriers,
reconciliation and risk semantics. Introduce one narrowly bounded official SDK
child as the accounting read transport. Do not replace the order execution
adapter, expose order methods, modify TWS settings or weaken unknown-order holds.
Unsupported or contradictory evidence blocks accounting certification and entries;
the independent synchronization/recovery/diagnostic loop continues.

Historical v1 qualifications, artifacts and hashes remain readable and immutable.
New automatic qualification has its own version/source kind and does not renew,
reinterpret or overwrite old operator receipts. Removing a seven-day timer alone
is not qualification. TWS product/build is diagnostic metadata, not a recurring
human gate when actual required protocol behavior is established.

## Verified dependency and protocol

The official [download index](https://download2.interactivebrokers.com/installers/tws-api/index.html)
advertises SDK 1051.01. The inspected
[Mac/Unix source archive](https://interactivebrokers.github.io/downloads/twsapi_macunix.1051.01.zip)
has SHA-256
`50a459ed09f0030df25125a177e57b69bdf576ec3a89fcb1f81fdff95bbf6316`.
Its `IBJts/source/pythonclient/ibapi/__init__.py` identifies package `1051.1`;
`setup.py` requires `protobuf==5.29.5`. The SDK uses Python match/case and
requires Python>=3.10; the approved Docker base is `node:24-bookworm-slim` with
Debian Python3.11, replacing Bullseye Python3.9. Source and generated modules carry
GPL-3.0-or-later notices. Preserve those notices and corresponding SDK source and
license with the dependency/image; do not describe this dependency as permissive
or claim that subprocess separation removes license obligations.

Use a fixed archive URL and verified checksum in a reproducible Docker dependency
stage. Extract only the official Python distribution and required license/source
material; install into an isolated venv with the pinned protobuf dependency.
The checked-in Python requirements lock verifies official protobuf Linux arm64,
Linux amd64 and universal-wheel hashes. Do not download dependencies on bot startup.
The production child runs an absolute, image-owned interpreter and script path.
No `pip install ibapi` from an unrelated/unverified PyPI package, shell launcher,
editable host SDK, wildcard extraction path or caller-supplied executable.
Local development uses the same documented version/checksum installation. The
clean Docker build must prove imports and fixtures without connecting to IBKR.

The inspected `server_versions.py` establishes these minimum server protocols:

| Feature | Minimum | Meaning for this package |
| --- | --- | --- |
| Millisecond broker clock | 197 | `reqCurrentTimeInMillis` / matching callback |
| Parameterized execution days | 200 | `lastNDays` and `specificDates` encoded |
| Protobuf protocol | 201 | Official SDK handles changed framing |
| UTC date/time Z suffix capability | 214 | Parser support; not proof every time is UTC |
| Configuration read | 219 | `reqConfigProtoBuf` / `configResponseProtoBuf` |
| Configuration write | 221 | Excluded from this child |

Require negotiated server protocol at least 219 for automatic qualification. SDK
maximum is 226. A prior private inspection negotiated 193 through the installed
adapter, so it does not establish the server's maximum. Private host metadata
reports TWS 10.51.1b. The authorized 2026-10-28 probe subsequently established
actual negotiated protocol226, expected Paper-account membership, and a correlated
config response with explicitly present masterClientId0. The configured endpoint
port matched; the response's historical-data timezone was `operator`. Only
startApi271, managedAccounts217 and configRead308 were sent. Disconnect, stopped
decoder thread and process exit0 were observed. The sanitized private receipt is
`.local/paper-runtime/research-diagnostics-20261028/official-sdk-capability-probe.json`.
No execution request or timestamp was observed by that probe, so this proves
configuration-read feasibility without claiming historical replay acceptance.

Installed `@stoqey/ib` 1.6.10 caps negotiation at 193 and encodes only the old
execution filter fields. Raising that constant or adding an ignored JS property
is not an implementation. In the SDK, `client.py:reqExecutions` encodes the new
fields, `client_utils.py:createExecutionRequestProto` sets the protobuf fields,
and `comm.py` handles length-prefixed binary message IDs. Configuration request
is outbound 108+200; response is inbound 110+200. Use the official implementation,
not a second homegrown high-version wire codec.

## Minimum machine evidence

Each acquisition is bound to settings hash, account, explicit Paper environment,
endpoint, owner process/session and connection generation. Never infer Paper
from port. Required evidence is obtained from the same child connection:

1. Successful handshake, SDK/dependency identity, negotiated protocol, and the
   configured account in the managed-account response. Client ID remains zero.
2. Correlated config response with present `api`, present `api.settings`, and
   explicitly present `masterClientId == 0`. Protobuf defaults are not presence:
   `HasField` checks are mandatory at every relevant level. Project only needed
   settings; do not store the complete config response, trusted IPs or unrelated
   order defaults. Record read-only/port fields only when present; missing master
   field, error or mismatched value is a precise capability failure.
3. A validated millisecond broker clock followed by an explicitly parameterized,
   account-scoped execution request and its matching completion callback. The
   request uses `clientId=0`, configured `acctCode`, all-symbol/security/exchange/
   side scope, `lastNDays=7`, and an explicit UTC `time` lower bound formatted
   `YYYYMMDD-HH:mm:ss`. `specificDates` is empty in production: it would add an
   unnecessary calendar-day restriction. Serialization tests also cover that
   supported field, without confusing it with the production interval.
4. Another successful config read after replay and before certification; master
   scope must still match. Unsolicited execution/commission callbacks remain
   observed and persisted, with both existing accounting lanes drained. Capture
   freshness, semantic revision and concurrent generation checks remain active.

Choose the replay lower bound before sending, rounded down to whole UTC seconds.
It must be no later than both the current Warsaw account-day start and the
required recovery floor. A normal 48-hour overlap is permitted as a requested
interval, not an inferred one. If the required floor predates the available
seven-day request window, emit an explicit historical coverage gap; do not clamp
the floor forward. `certifiedFrom` is the persisted request lower bound;
`coveredThrough` is the validated pre-request broker clock. Subsequent records
outside that certified interval may still be persisted but do not widen it.
Change both service construction and store verification: the current
`brokerTime - 48h` assertion must not independently manufacture evidence.

The [official execution-filter contract](https://www.interactivebrokers.com/docs/tws-api/protobuf/execution-filter)
documents parameterized days and an explicit UTC lower bound. The SDK retains an
older docstring about opening the Trade Log beyond 24 hours, and generic execution
documentation describes legacy retention. Do not claim that installed old-client
empty replay proves seven-day retention. This new source explicitly relies on
the documented parameterized request semantics on a supporting server, successful
request completion and no rejection/truncation/error indication. Operational
acceptance records those actual parameters and server responses. Any observed
counterexample (including a known retained execution missing from its requested
window) invalidates the capability; do not silently fall back to legacy replay.
The API is the source of truth, not an independent proof of every broker-internal
storage operation. No local test is labeled actual historical broker acceptance.

Unfiltered client scope follows the official SDK default: `ExecutionFilter()`
sets `clientId=0`, and `createExecutionRequestProto` emits that zero. The official
[execution documentation](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/execution-details)
describes the empty filter as all previous executions; the
[master-client contract](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/master-client-id)
requires connecting as configured Master0 for TWS/FIX/all API-client visibility.
A fixture checks the actual SDK serializes the default zero. This is distinct
from assuming every ordinary non-master connection sees other clients.

The [config API](https://www.interactivebrokers.com/docs/tws-api/doc/setting-management)
replaces the master-client screenshot. It cannot prove arbitrary settings never
change between two samples. Fresh per-capture reads, the continuous execution
stream, replay and ordinary disconnect/change invalidation are the operating
contract; do not claim atomicity across the broker's config and execution APIs.

## Timestamp contract

Keep the exact broker time string in private accounting evidence; diagnostics
only show its bounded format classification and sanitized failure cause. SDK
`decoder_utils.py:decodeExecution` passes `execution.time` through unchanged.
`Execution.proto` calls it server time and does not guarantee UTC. Protocol 214's
name alone does not establish the timezone of an actual record.

The automatic source accepts explicitly zoned execution times: compact IB date
plus time with `Z`, `UTC`, `GMT` or a numeric offset, and strict ISO-8601 with
`Z`/numeric offset. Define exact accepted regexes and validate calendar components,
offset range and roundtrip, including leap dates; do not use permissive JS date
parsing. Preserve fractional milliseconds only when present and valid. Normalize
to UTC and then derive the Warsaw accounting date. A time with an explicit zone
is interpreted by that zone, not overridden by configured Europe/Warsaw.

Naive timestamps do not become UTC merely because protocol is >=214. Independent
review accepts an explicit adapter configuration for them: a required
`UTC` or `Europe/Warsaw` timezone, accepted by the owner and included in the
settings hash. The owner confirmed Europe/Warsaw for this installation. Persist
`CONFIGURED_ZONE` provenance plus that hash for naive timestamp interpretation;
never describe it as an API-observed setting. This is ordinary configured adapter
semantics, not a recurring manual qualification and has no seven-day renewal.

Explicit zones always take precedence and are recorded as `EXPLICIT_ZONE`.
A valid explicit offset differing from the configured Warsaw offset is not a
contradiction. Strict naive parsing must reject invalid calendar dates, DST gaps
and DST-ambiguous local times; do not guess either occurrence. Existing time,
account and generation contradiction checks remain mandatory. Missing/unsupported
configuration or ambiguous records produces a precise timestamp error while
synchronization continues. Configuration changes invalidate old qualification
and captures. Empty completed replay needs no fabricated timestamp sample.

The inspected local `jts.ini` timezone and encrypted TWS config are not proof of
current per-callback timezone; this fallback explicitly relies on configured
adapter semantics. Add fixtures for naive Warsaw normal time, DST gap and fold,
UTC naive time, explicit-offset precedence and configuration hash changes.

The [API timezone setting](https://www.interactivebrokers.com/docs/tws-api/protobuf/api-settings-config)
`sendInstrumentTimezone` documents historical data only. It must not be used as
proof of execution timestamp timezone.

Bounded research of the official changelog, execution documentation and downloaded
SDK found no assertion that protocol214 makes every execution timestamp UTC/Z.
The accepted configured-zone interpretation above is an explicit configuration
trust decision. It does not require recurring owner screenshots and does not
claim machine observation of the active TWS timezone setting.

## Child transport and NDJSON v1

The child is part of execution-engine accounting, not a new service. TypeScript
owns DB, authentication, canonical hashes, reservations and authority. The child
only connects, reads and projects permitted callbacks. Spawn with `shell:false`,
minimal environment (no `.env`, provider tokens, DB credentials or execution API
token), fixed paths, no inherited extra file descriptors, and bounded stdio.
This read-only command boundary is not an OS sandbox claim: the installed SDK
contains write methods, but they are never dispatched or exposed by this wrapper.
Tests assert the exact SDK calls and zero write calls.

Every line is one strict JSON object with `{v:1, sessionId, generation, seq, type}`.
Session ID is a fresh parent nonce; generation is a positive safe integer; `seq`
is strictly increasing independently in each direction, starting at one. Parent
rejects duplicates, skips, stale identity, unknown type/fields and invalid payload.
There is at most one pending command of each uncorrelated callback family and
one execution replay. IB request IDs are positive monotonically allocated values
within a child, never reused. Request-bearing messages include `commandId` and
`requestId`; responses must match both the registered operation and generation.

Permitted parent commands and projected child events are:

| Command | Payload / response |
| --- | --- |
| `connect` | Exact configured host/port/clientId0/account; emitted `connected` contains SDK/protobuf version, serverVersion and handshake time string |
| `managedAccounts` | `managedAccounts` response; account IDs remain private data |
| `clock` | `clock` response with safe integer epoch milliseconds; only one pending clock; late unsolicited clock cannot satisfy another request |
| `config` | Correlated `config` response with master field presence/value and selected settings projection |
| `executions` | Exact bounded filter; `execution` records, `commission` records and matching `executionsEnd` |
| `close` | Stop all dispatch, disconnect, bounded `closing` acknowledgement; actual process exit is retirement proof |

No arbitrary method name/eval/import/file command, config update, order request,
`reqOpenOrders`, `reqAutoOpenOrders`, place/modify/cancel/global cancel or reconnect
loop exists in the child. Handshake `startApi` and normal SDK protocol negotiation
are permitted. Only wrapper callbacks needed above plus readiness/error/disconnect
are emitted. Map unsolicited executions as explicit live events, not replay
members; never mislabel their request ID. Commission events are keyed by execId
and may arrive after execution-end. Existing complete commission joins remain
mandatory; execution-end does not certify commissions complete.

Use presence-aware protobuf callbacks for execution/commission/end/config to
avoid SDK default zero values disguising omitted required fields. Do not emit
both protobuf and compatibility callbacks for the same event. Official 1051.1
uses `commissionAndFeesReport` and `commissionAndFees`; map to the existing
canonical commission field. Preserve omitted/UNSET/nonfinite financial fields
as unavailable, never zero. Decimal quantities are encoded as bounded decimal
strings over NDJSON and checked before canonical finite-number conversion.
Preserve execution identifiers, corrections and pendingPriceRevision exactly;
canonical data and correction semantics remain TypeScript responsibilities.

Limits: each input line <=16 KiB, each output line <=64 KiB, total queued output
<=1 MiB, no more than 32 outstanding commands (normally one), and a 30-second
command deadline bounded further by the caller's existing shorter timeout. A
partial line at EOF, malformed UTF-8/JSON, size overflow, invalid event shape,
unmatched end or child exit during a request fails the entire capture. Backpressure
must be bounded; overflow disconnects instead of dropping accounting events.
Parent applies the same limits to a faulty child; child applies input limits to
a faulty parent. SDK raw-frame logging and stdout diagnostic printing are disabled.

`error` includes originating request/command when known, origin (`ibkr`, `sdk`,
`bridge`), sanitized original name/code/message (message <=512 characters), and
stable internal classification. Do not emit raw broker frames, full config,
advanced reject payload or unfiltered exception locals. Preserve unavailable
original details as null. Known informational farm codes retain the existing
allowlist; all other request/global errors invalidate active evidence unless an
explicit tested mapping establishes otherwise. Warning text about partial or
unsupported data cannot be ignored merely because an end callback follows.

## Lifecycle, ownership and freshness

Parent validates the current DB owner/generation immediately before dispatch and
on every callback/publication. Losing ownership closes stdin and invalidates
all child data immediately. Child stdin EOF disconnects and exits. `close` and
stdin EOF have a 2-second graceful shutdown deadline; parent then signals only its
tracked child object with SIGTERM, then SIGKILL after another 2 seconds. Await the
child `exit`/`close` lifecycle; a JSON acknowledgement alone is not physical closure.
No PID from DB, process enumeration, host supervisor, TWS kill or Docker socket
is needed. Abnormal child death is a source gap and triggers the bounded existing
automatic reacquisition policy. Never reconnect within the same child generation.

On timeout of an uncorrelated clock/accounts family, retire the generation before
another such request so an old callback cannot satisfy a new request. New children
get fresh nonce/generation. Uncertain kill/exit remains an explicit transport
retirement diagnostic; database generation fencing prevents stale publication.
The read-only successor policy follows package A/B's accepted ownership contract,
without extending that policy to unknown order submissions.

Qualifications record source contract version, SDK checksum/version, protocol,
presence-aware master evidence, exact execution filter/request/end observations,
timestamp mode and generation. Validity has no recurring operator expiry; it
depends on fresh same-generation capture evidence. Retain existing 10-second
capture TTL, broker/DB clock checks, Warsaw account-date checks, both lane drains,
commission joins, position/reconciliation identity and semantic revision.

## File scope and acceptance

Implement disjoint transport files under `apps/execution-engine/src/accounting/`
(suggested `official-sdk-bridge.ts`, `official-sdk-protocol.ts` and associated
tests), a Python reader/test under `apps/execution-engine/python/`, and pinned
dependency/bootstrap metadata in that directory. Modify root Dockerfile only for
the reproducible reader runtime. No source vendor tree is copied into repository.
Coordinate `source-collector.ts`, `source-service.ts`, `source-store.ts`, `types.ts`,
`config.ts`, `execution-time.ts`, and their tests with the lead/core author before
editing: those shared integration files currently have another owner. Add a
distinct additive migration for v2 qualification only after checking next number;
never edit historical migrations or v1 evidence bytes. CLI/diagnostics expose
precise automatic qualification failures without secret/account payload output.

Required targeted verification, using offline/fake SDK only:

- SDK import/version/checksum verification; Python unit tests exercise actual
  protobuf objects and golden request serialization, including protocol199/200,
  213/214 and218/219 boundaries. Assert lastNDays, UTC filter, specificDates,
  reqId, master absence versus explicit zero, binary framing and clock callback.
- Node native-runner bridge tests cover split/coalesced lines, duplicate/stale
  identity/sequence, malformed input, oversized/unterminated lines, bounded queues,
  stderr redaction, child crash, command timeout, EOF shutdown, SIGTERM/SIGKILL,
  exit acknowledgement, late callbacks and exact zero-write SDK call allowlist.
- Timestamp tests cover compact Z, UTC/GMT, ISO/numeric offsets, Warsaw DST
  boundary accounting dates, invalid/naive/ambiguous dates, fractional time and
  explicit zone taking precedence. Modern naive records must never pass through
  the legacy fallback unnoticed.
- Collector/service/store tests cover complete empty replay, explicit lower
  bound, replay past retention floor, missing end, truncation/error then end,
  wrong account/client/master, omitted protobuf financial fields, fee callback
  rename, corrections and pending prices, late fees, both lane barriers,
  config change mid-capture, owner/generation turnover and historical v1 reads.
- Isolated PostgreSQL integration tests prove v2 evidence validation and capture
  interval verification reject invented coverage, mismatched hashes/generations,
  mutated persisted request filters and replay/end mismatch.

Run Python `unittest` with the pinned SDK, targeted Node tests, then the repository
required lint/typecheck/test/isolated integration/build and clean Docker build.
Independent hostile implementation review must differ from the author. Commit,
push and exact-commit CI remain the lead's reviewed publication responsibility.

Operational acceptance is separate: an authorized read-only probe must record
actual serverVersion>=219, present master zero, correct managed-account identity,
exact parameterized execution request, matched completion and timestamp formats
actually observed, without raw private output. No fabricated fill is required
for an empty account. If an existing known execution is in range, verify its
presence and timestamp/commission mapping. A current server capability or data
failure is reported precisely and leaves sync running; it does not justify a
manual timer renewal, fabricated coverage, SDK downgrade, TWS restart or entry.

## D operational read-only probe

After focused bridge/collector tests and a clean Docker build, the actual
production bridge completed a bounded client0 replay on 2026-10-28: protocol226,
expected Paper account, master0 before/after, millisecond clock, explicit UTC
lower bound, lastNDays7, matching replay-end and acknowledged transport closure.
The replay returned zero executions/fees. This establishes request completion,
not a real fill timestamp example or independently observed cross-client fill.
The private sanitized receipt is
`.local/paper-runtime/research-diagnostics-20261028/official-sdk-replay-probe.json`.
No order, configuration-write, WSH or paid-provider call was made.
