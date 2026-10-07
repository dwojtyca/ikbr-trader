# PP7 E1c — WSH contract findings and bounded offline preparation

Date: 2026-10-07. Baseline: `94f1cb7d908edf1cdac7f8d103e73f66be029fff`.
Status: **independent offline preparation accepted; G1 BLOCKED**.
Owner authorization now covers implementing the [parent plan](PP7_WSH_TO_FIRST_PAPER_PLAN.md).
It does not make its G1–G4 acceptance evidence available. This document records
which source guarantees are missing and proposes a strictly independent offline
preparation package. Acceptance of that package must not be described as G1 or G2.

## 1. Decision and boundary

Do not implement or wire a production WSH research adapter under the current
contract. There is no evidence-supported AVAILABLE or EMPTY path satisfying
parent §4. The public API specifies request fields and a callback, but the
reviewed evidence does not establish exhaustive issuer/event/window coverage,
non-truncation, window semantics or finite bounds for uncertain earnings dates.
A callback with three or fourteen rows is evidence of returned rows only.

Keep `ResearchEvidence.published` required, existing snapshot/manifest schema 1,
canonical hashing, report/news eligibility, AI binding and entry admission
unchanged. Do not substitute observation time for publication. Do not introduce
an adapter that always emits UNVERIFIED and call the requested adapter delivered.

Independent useful work is a pure offline inspection helper (§6): reproduce
request-shape violations and structural data gaps in synthetic/offline input,
with fixed redacted diagnostics. It cannot create research coverage, contact
IBKR, register an adapter, alter configuration or qualify a source. This is a
materially bounded preparation amendment requiring independent plan acceptance
before code. No runtime defaults or operational permissions change.

## 2. Evidence and exact limitations

The private inventory `/private/tmp/pp7-wsh-e1c/inventory.json` was prepared from
installed `@stoqey/ib` 1.6.10 and existing receipts. It names the source paths and
request scripts; it is not a qualification. Do not commit raw payloads, account
identifiers, credentials or licensed event text. Temporary evidence requires
private durable retention before operational acceptance, subject to permissions.

| Evidence | Established fact | Not established |
| --- | --- | --- |
| [Current request documentation](https://www.interactivebrokers.com/docs/tws-api/doc/wall-street-horizon/event-data/wsh-event-data-object) | Choose conId plus dates or filter; maximum totalLimit 100; only one event-type tag per filter request; explicit fill flags | Date inclusivity/time zone, result exhaustiveness or absence of hidden caps |
| [Current callback documentation](https://www.interactivebrokers.com/docs/tws-api/doc/wall-street-horizon/event-data/receive-event-data) | Callback has requestId and JSON string | A completion marker, expected count, pagination or verified EMPTY protocol |
| Installed SDK encoder/decoder | Date/limit fields require server version 173; callbacks decode requestId plus JSON; no WSH-specific end callback exposed | Provider business semantics or permission to infer completion |
| Prior request receipt | Protocol version 193; empty filter; all three fill flags false; dates 20261005–20261106; **totalLimit 1000**; 3 PKO / 14 AAPL rows | Current documented request contract compliance; 1000 exceeds documented maximum 100 |
| Prior identity inventory | Every returned row matched the requested conId and issuer ISIN | Exhaustive issuer coverage; semantics of every row having `filterSource=watchlist` |
| [WSH data dictionary](https://www.interactivebrokers.com/campus/wp-content/uploads/sites/2/2023/09/WSHEclassesandfieldsforIBAPI2022-12-23.pdf), pp. 3–4 | `wshe_ed` and `wshe_fq` distinguish CONFIRMED, UNCONFIRMED and INFERRED; announcement time describes company confirmation for earnings where supplied | Finite uncertainty bounds; publication values when absent; cancellation/version identity guarantees |
| Prior publication inventory | All three PKO and twelve of fourteen AAPL rows lack `announce_*` | Historical publication knowledge from event time, fetch time, `event_key` or access success |
| [WSH vendor page](https://www.wallstreethorizon.com/interactive-brokers) | Describes IBKR integration and model use; identifies vendor support | This account's durable retention, external AI disclosure, trial expiry or call quota |

The [older IBKR fundamentals page](https://interactivebrokers.github.io/tws-api/fundamentals.html)
requires metadata before events and disallows simultaneous WSH requests. Its
older filtering prose is not authority to ignore the current request page.
Metadata hash and SDK/protocol versions belong in qualification, but a hash of
an observed catalogue does not prove that catalogue covers every material class.
The observed metadata contained 24 event-type tags and 22 filters.

## 3. G1 blockers, positive cases and resolution evidence

| ID | Blocking guarantee | Evidence needed to close it |
| --- | --- | --- |
| S1 | Complete response, zero-result semantics, truncation and pagination | Applicable provider contract documenting terminal response semantics and exhaustive scope, including caps, omissions and how to recover a saturated query; qualified receipts implementing that contract |
| S2 | Date window, time zone and selection semantics | Meaning and inclusivity of request boundaries, occurrence/index-date relationship, multi-day intersections, confirmed IANA/offset rules; explain `filterSource=watchlist` with all fill flags false |
| S3 | Event universe and lifecycle | Supported material/earnings classification, metadata freshness, event-key stability, ed/fq relationship, revisions/conflicts/cancellation and disappearance semantics; unknown types remain visible and blocking |
| S4 | Uncertain dates | Finite provider-backed bounds covering actual occurrence, or a separately qualified source resolving the event; an estimated date far away does not prove no event near entry |
| S5 | Publication/knowledge | Reliable publication source for every required event, or a separately accepted complete prospective schema and durable observation design; first observation only resolves publication representation, not S1–S4 |
| S6 | Rights and entitlement | Applicable automated-use, fact/reference retention, external AI disclosure, trial/access expiry, quotas and ongoing cost evidence for the intended account/use |

**AVAILABLE acceptance example required after resolution:** a qualified issuer
request covering every local day intersecting the entry blackout horizon returns
one or more correctly identified events under a documented exhaustive-response
contract; all included material/earnings dates have qualified bounds, and all
required knowledge, rights and receipt checks pass. A complete calendar can still
prohibit entry because of blackout; coverage is not admission.

**EMPTY acceptance example required after resolution:** that same qualified
exhaustive request proves zero matching events in the complete required universe
and occurrence window, with no unresolved event/version carried from prior
observations. An empty JSON array, two equal reads or returned count below 100
alone is not this proof. No such positive proof exists in the present evidence;
these examples describe missing acceptance evidence, not implemented support.

Known identity checks do not repair these source limitations. Splitting into
smaller date windows is not an answer until boundary semantics, exhaustive query
behavior and deduplication/version semantics are established. A full page or any
saturated segment must never silently become complete.

Operational gates are separate: an otherwise valid source contract still needs
current account entitlement, bounded budget, fresh receipt qualification and
expiry, verified socket endpoint/client-ID ownership, and the Gate A/B broker,
model, alert, accounting and risk checks. Conversely, a working Paper socket or
operator trial activation cannot resolve S1–S5. Marketaux's exhausted 20-call
trial budget and the remaining one-off OpenAI allowance do not authorize regular
refresh or extra calls in this package.

## 4. Production design constraints retained for a later accepted contract

These are requirements on a future design, **not an approved implementation
packet or a permission flag which makes unknown provider behavior trusted**.

- Query candidate: conId mode, explicit start/end YYYYMMDD, empty filter,
  `fillWatchlist=false`, `fillPortfolio=false`, `fillCompetitors=false`,
  `totalLimit=100`; metadata first. No event-type filtering until the complete
  event universe is established. Exact dates derive from the qualified source
  zone and cover full days intersecting at least now ±24 h.
- All rows require configured instrument → broker-resolved conId → issuer ISIN
  equality. No ticker branches; foreign-issuer rows, absent expected conId,
  mismatches and malformed identities invalidate the acquisition. Additional
  listing conIds on a correctly identified issuer row are not foreign rows. No silently dropped unknown type/state.
- Earnings/material blackout is at least 24 h before and after the complete
  event interval. DATE retains qualified IANA zone and 23/25-hour days; INSTANT
  requires an explicit offset or equivalent source evidence. CET/EST or
  BEFORE/AFTER MARKET must not manufacture a precise time. Without qualified
  uncertainty bounds, UNCONFIRMED/INFERRED remain ineligible.
- A changed date/status/content is a new version. Preserve conflicting versions
  and their knowledge history; absence is not cancellation. Do not merge ed/fq
  using date similarity. Confirm their issuer/fiscal/event identity first.
- A prospective calendar representation would require a new explicitly versioned
  manifest/snapshot/evidence contract with publication explicitly unknown,
  distinct receipt time and durably established version-first-observation time.
  Eligibility cannot predate successful durable observation. Do not backfill
  historical knowledge or expand this exception to reports/news. Schema-1 audit
  bytes and hashes must remain unchanged; old readers/writers must reject an
  unsupported active version. Rollback cannot overwrite a new head with old
  permissive assumptions. Concrete migration and mixed-version cases require
  a new review before implementation.
- That schema would require new prompt/request versions and immutable binding
  of the exact source qualification, event versions, knowledge basis and receipt.
  The existing store compares latest snapshot id/hash/sequence; execution also
  checks the exact AI context, manifest and request hash. Preserve those checks.
  Requalification, negative refresh, supersession or expiry invalidates prior AI
  decisions, including immediately before dispatch.
- Acquisition identity must represent a socket request honestly. Current source
  validation accepts HTTPS URLs and same-provider origins. Do not invent HTTPS
  fetch provenance for socket reads or globally weaken URL/SSRF validation.
- Existing refresh locks are per config/manifest/instrument. WSH needs a separate
  durable coordination scope covering every cooperating process/instrument
  using the same qualified endpoint. Exact scope, lock loss, fencing and unknown
  request recovery remain critical contract work; an in-process mutex is not
  enough. A lock alone cannot certify cancellation of a timed-out request.
- Every metadata/event/segment call reserves budget before send and keeps its
  reservation after failure or unknown outcome. Bound request duration and bytes,
  correlate request ID and session, reject late callbacks, never blind-retry an
  unknown request. Check qualification at reserve/send/read/publish/AI/dispatch.
  Numeric operational limits require explicit qualification; none are invented
  here. Negative refresh replaces current success; failed DB persistence must
  block admission instead of leaving a stale success usable until ordinary TTL.

Present files demonstrating these dependencies are
[types](../../../packages/shared/src/instrument-research/types.ts),
[validation](../../../packages/shared/src/instrument-research/validation.ts),
[eligibility](../../../packages/shared/src/instrument-research/eligibility.ts),
[store](../../../packages/shared/src/instrument-research/store.ts),
[refresh](../../../apps/llm-agent/src/research-refresh.ts),
[AI request](../../../apps/llm-agent/src/research-decision.ts) and
[final guard](../../../apps/execution-engine/src/research-entry-guard.ts).
No edits to these files are authorized by the independent preparation packet.

## 5. Negative outcome matrix for the future adapter

| Condition | Required consequence |
| --- | --- |
| Unsupported request shape, missing metadata, identity mismatch or unknown important type | No qualifying acquisition; do not drop offending rows |
| JSON error, byte cap, disconnect, timeout, partial/missing segment or saturated unqualified response | ERROR or UNVERIFIED, complete=false; retain spent/unknown reservations; no automatic replay |
| Missing publication under existing schema | Reject evidence; never substitute fetch/event date |
| Uncertain date without finite supported bounds, conflicting revision or disappearance | UNVERIFIED and entry hold; no implied cancellation |
| Expired/missing rights, qualification or entitlement | No source call/admission; hold remains even with cached data |
| Empty callback without qualified exhaustiveness | UNVERIFIED, never EMPTY |
| Persist failure or unknown commit | No successful refresh/admission assertion; do not reuse prior approved binding |
| Successful source refresh after an AI decision | New snapshot invalidates old binding; mandatory re-evaluation under existing flow |

## 6. Independent offline preparation amendment

### Purpose and permitted files

Provide reusable, deterministic inspection of request shape and row structure so
later qualification can distinguish observed syntax from missing guarantees.
This has value before S1–S6 are answered and no authority to resolve them.

Proposed code ownership is exactly two new files:
`apps/llm-agent/src/research-wsh-inspection.ts` and
`apps/llm-agent/src/research-wsh-inspection.test.ts`.
No imports of this helper in production code, index re-export, CLI, SDK dependency,
package/lockfile/config/Compose edit, network, filesystem or DB access. Fixtures
live as synthetic inline test data. Do not copy real payload content into tests.

### Pure request inspection contract

Function `inspectWshRequest(input: unknown)` accepts an in-memory request object.
It does not parse a wire receipt or JSON. The only accepted keys are
`conId, filter, fillWatchlist, fillPortfolio, fillCompetitors, startDate, endDate,
totalLimit`. The output is exactly `{kind: "wsh-request-inspection-v1",
shapeValid: boolean, issues: string[]}`. shapeValid means this conservative
candidate request syntax only, never completeness, entitlement or eligibility.
No input values or arbitrary keys appear in output. No coercion or defaults.

Validate a plain object (prototype exactly Object.prototype) with exactly those
eight own string data properties; reject symbols/accessors before reading values.
conId is a positive safe integer; filter is the empty string; all fill flags are
false; both dates are real Gregorian YYYYMMDD with four-digit years 1000–9999 and
startDate <= endDate; totalLimit is an integer 1–100. Non-empty or non-string
filter yields UNSUPPORTED_FILTER_MODE. Filter mode is intentionally unsupported.
Input strings, including JSON strings, are INVALID_SHAPE; callers which parse
JSON remain responsible for that boundary. The helper makes no wire-validation
claim. Do not invoke getters, serialize inputs or traverse irrelevant values.

Fixed issue codes: INVALID_SHAPE, INVALID_CONID, UNSUPPORTED_FILTER_MODE,
FILL_FLAGS_NOT_FALSE, INVALID_DATE_RANGE, INVALID_TOTAL_LIMIT. Return unique
lexicographically sorted issues and shapeValid iff none. INVALID_SHAPE is the
sole issue for a non-object, wrong prototype, unknown/missing property, symbol
or accessor. Once shape passes, collect all independent field issues. Catch failed reflection
(e.g. a throwing/revoked Proxy) and return INVALID_SHAPE without error text.
Reflection can invoke Proxy traps; no sandbox against arbitrary in-process code
is claimed. Never invoke property getters to obtain inspected values.

### Row inspection contract

Function `inspectWshEventRows(input: unknown, expected: unknown)` accepts an
already decoded array and exactly `{conId: number, isin: string}` as expected
identity. It does not read files, parse raw JSON or claim duplicate-key/wire
validation. The actual PKO/AAPL receipt root is an array; row `conids` is an array
of decimal strings, often containing multiple listing IDs. Equality with a
singleton list is wrong. `data.company.isin` is the observed issuer path.
Top-level status is a string and may be empty; no status meaning is inferred.

Output is exactly `{kind: "wsh-row-inspection-v1", rowsInspected: number,
counts: {...}, issues: string[]}`. The count keys are exactly `malformedRows`,
`identityMatchedRows`, `identityMismatchedRows`, `identityUnverifiableRows`,
`dateRows`, `instantRows`, `unknownDateTypeRows`, `announcementFieldPresentRows`,
`announcementFieldAbsentRows`, `watchlistTaggedRows`. Counts expose no values.
There is no success/coverage/eligibility flag. No ResearchCoverage or calendar
objects can be returned; zero rows is merely rowsInspected=0, never EMPTY.

Bounds and rules:

1. Expected identity must be a plain object with exactly the two own string data
   properties, positive safe integer conId and ISIN matching
   `^[A-Z]{2}[A-Z0-9]{9}[0-9]$`. This is format validation, not an issuer registry
   or checksum qualification. Otherwise return EXPECTED_IDENTITY_INVALID only,
   rowsInspected=0 and all counters zero, without inspecting input.
2. Input must be an array with at most 1000 elements. Reject non-arrays with
   INVALID_ROWS and larger arrays with ROW_LIMIT_EXCEEDED; no prefix sampling.
   The array prototype must be Array.prototype and indices must be dense own
   data properties. Element accessors, sparse holes, non-index extra properties
   or symbols also cause INVALID_ROWS. Reject before executing accessors. Empty
   arrays are allowed. Reflection failure returns INVALID_ROWS. Boundary failures
   return rowsInspected=0, all counts zero and only the named issue.
3. A row and its data/company objects, when examined, must have exactly
   Object.prototype, no symbols/accessors and at most 128 own keys each.
   Read using descriptors after validation. The parser traverses only row,
   data, company and conids (no recursive traversal of source text/tooltips).
   Unknown own data fields are not interpreted or emitted. Accessors or reflection
   failure in the examined row/data/company/conids make the row malformed. Cycles in irrelevant data are
   ignored because those data are never traversed or serialized.
4. A malformed/non-object row increments malformedRows and no other count.
   For an otherwise structurally usable row, classify identity exactly once:
   valid identity fields and expected conId present in conids plus exact ISIN
   equality → matched; valid identity fields but either unequal → mismatched;
   absent/malformed identity fields → unverifiable. conids must be a nonempty
   dense own-data-property array with Array.prototype, no extra keys/symbols,
   of at most 32 distinct canonical positive decimal strings,
   each at most 16 characters representing a safe integer. Additional valid
   listing conIds are permitted. ISIN must satisfy the format above. Missing or
   non-object data/company makes identity unverifiable, not matched. If a
   present data/company object violates rule 3, the whole row is malformed.
5. For every non-malformed row, classify index_date_type as exact DATE, exact
   INSTANT or unknown; do not parse index_date or assign a time zone. Count
   watchlistTaggedRows only for exact filterSource=watchlist. Count one
   announcementFieldPresentRows when data has at least one own key beginning
   `announce_` whose value is a nonblank string of at most 2000 characters;
   otherwise announcementFieldAbsentRows. This counts field presence only:
   it does not validate publication, infer absence of announcements in the
   world, or interpret differently named fields as publication.
6. Fixed issues for structurally accepted input are MALFORMED_ROWS,
   IDENTITY_MISMATCH, IDENTITY_UNVERIFIABLE, UNKNOWN_DATE_TYPE,
   ANNOUNCEMENT_FIELDS_ABSENT, WATCHLIST_TAG_OBSERVED, included iff the relevant
   count is nonzero. Deduplicate and sort all issue codes lexicographically.
   rowsInspected equals array length. Require
   malformed+matched+mismatched+unverifiable=rowsInspected,
   date+instant+unknownDateType=rowsInspected-malformed, and
   announcementPresent+announcementAbsent=rowsInspected-malformed.

These are in-memory structural bounds, not transport byte/depth protection.
No arbitrary string, conId/ISIN, title, URL, property name, event_key or payload
hash is copied into output. Inspectors must not mutate input. Do not add a CLI or
production caller. Any later raw receipt ingestion needs its own byte limit,
JSON/duplicate-key boundary and licensed retention contract.

### Task packets and route

| Packet | Route / files | Dependencies and acceptance |
| --- | --- | --- |
| E1c-A0 contract completion | A `gpt-6-astra` / high; this document only | Independent RA plan acceptance of §6 before code; report S1–S6 separately |
| E1c-L0 pure inspection | L `gpt-6-luna` / medium; the two new files above | Accepted §6 only; synthetic tests for every boundary and third arbitrary conId; no side effects or production callers |
| E1c-A1 integration check | A `gpt-6-astra` / high; read-only source review | Verify no runtime import/wiring, no eligibility changes, exact owned diff, and no leaked input in diagnostics |
| E1c-RA final review | Different independent `gpt-6-astra` / high | Review actual diff, hostile input tests and full checks; neither author nor plan reviewer accepts own implementation |
| E1c-M verification/publication | M `gpt-5.6-luna` / low, disclosed available fallback | Run accepted commands only; return exits, SHA and exact CI; no source repairs or broader staging |

No Sol wiring task is justified: the helper has no runtime integration. Future
production L mappings/S wiring/A safety packets remain **blocked by G1** and
require exact accepted schema, identity, lifecycle and qualification contracts.
Do not delegate their design to a pure-helper worker.

After one failed targeted repair of an ordinary helper problem, return evidence
to lead for Sol; critical ambiguity returns immediately to Astra. Scope growth,
new imports/side effects, ambiguous field semantics, failing identity/privacy
cases or changes to acceptance stop the affected work. Escalation grants no
provider calls, broker retries, test weakening or operational authority.

### Validation and delivery

Targeted tests must include null/array/non-object, unknown/missing keys, getters,
throwing/revoked Proxies, NaN/Infinity/fractional/unsafe conId, invalid leap
days/reversed dates, mixed filter mode, every fill flag, limit 0/100/101/1000,
no mutation and fixed diagnostics without arbitrary input text. Row tests must
cover all three identity categories, multiple listing conIds,
empty status without invented semantics, missing/invalid data/company, getters
without execution, malformed/unknown/oversized structures, unknown fields with
secret-like synthetic text, zero rows, caps at and above boundaries, no mutation,
and the three counter conservation equations. No input text may appear in output.

Run required `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` with isolated PostgreSQL and `pnpm build`. Use a clean
export of baseline `94f1cb7` plus only the accepted files for validation so the
25 unrelated dirty files are not included. Prefer offline dependency installation;
never run destructive fixtures against an operational DB. No new backtest is
needed for this pure inspection scope. No runtime/deployment/build configuration
change means no new Docker build for this independent package; any such change
requires scope re-review and the parent's clean Docker requirement.

Documentation-only stages validate facts, links, secret-free diff and
`git diff --check`, without rerunning unchanged runtime suites. The lead owns the
package report, scoped commit/push and exact-commit CI; report any access block.
Preserve the 25 pre-existing dirty files and confirm their hashes unchanged.
Independent preparation completion must be reported separately from blocked G1,
production G2, Gate A/G3 and Paper/G4.

## 7. Unsent questions for the provider/operator

Prepare these questions only; do not contact a vendor without the owner's
explicit instruction to send.

1. For the supported conId+dates request with all fills false and totalLimit=100,
   does one callback exhaustively return every relevant issuer event? What are
   hidden caps, terminal/empty signals, pagination and saturated-window recovery?
2. What date/time zone and inclusive boundaries select events, including events
   overlapping multiple days, and why is filterSource watchlist reported here?
3. What are event-key and revision/cancellation semantics, the ed/fq relationship,
   the material-event catalogue, and guaranteed bounds of UNCONFIRMED/INFERRED?
4. Which fields establish publication for types lacking announce fields? Is a
   prospective first-observation interpretation supported, with what limitations?
5. Does the applicable agreement permit automated use, durable fact/reference
   and receipt storage, and transmitting event details to the configured external
   AI processor? What retention/deletion requirements survive trial expiry?
6. What are this account's expiry and quotas, and the WSH concurrency scope and
   safe recovery protocol after timeout/disconnect or an unacknowledged cancel?

## 8. Work record

Contract author: requested/assigned `gpt-6-astra` high; execution began
2026-10-07 12:39:41 UTC. Assigned model/effort confirmed by agent dispatch: `gpt-6-astra` high;
actual runtime model/effort telemetry and per-task token telemetry unavailable. Inventory was a separate M task with
its own disclosed fallback and evidence. Contract author performed local reads
and primary public-document reads only, with no provider/broker/DB/alert calls.
Draft completed 2026-10-07 12:48 UTC (about eight minutes wall time).
Repair/escalation count: zero implementation repairs; one immediate escalation
of the G1 source blocker. Independent plan review accepted §6 at 12:48:59 UTC.
A different independent Astra reviewed the implementation; two findings were
resolved through Sol and Astra repairs. Final code review accepted the helper at
13:01:33 UTC. Full checks, publication and CI are recorded in the
[preparation report](PP7_WSH_E1C_PREPARATION_REPORT.md); this acceptance does not
close G1 or authorize production integration.
