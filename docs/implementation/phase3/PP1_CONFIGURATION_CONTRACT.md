# PP1 configuration contract

Date: 2026-09-28. Status: accepted by independent Astra plan review before
implementation; the narrow migration clarification below was also accepted.
Author route: PP1-A, requested/actual `gpt-6-astra` / `high`.
Baseline: `a56bc5c`, main. This document is normative for the bounded
[implementation plan](PP1_IMPLEMENTATION_PLAN.md). It refines the proposed
[architecture](../../architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md) for PP1;
it does not implement PP2 factories, PP3 stock execution or grant activation.

## 1. Authority and delivery boundary

All four consumers (ingestion, signal-engine, execution-engine, llm-agent) load
one JSON bundle at process startup. Parsing failure terminates startup before
broker connections, proposal creation, AI claims/provider calls or entry dispatch.
A configured file never falls back to an environment watchlist or seed registry.
The bundle is immutable until restart. Secrets, account identifiers/allowlists,
activation windows, provider entitlements and broker observations are not bundle
fields and never enter its hash.

PP1 represents strategy instances and policy assignments, projects monitoring and
reports readiness. **Every bundle-mode new entry remains denied**, even with
`entryEnabled=true`, `TRADING_ENABLED=true`, matching service hashes and complete
fixtures: `PP2_STRATEGY_RUNTIME_UNAVAILABLE` and
`PP3_EXECUTION_POLICY_UNAVAILABLE` remain blockers. PP4 research verification is
also unavailable, not implied by a catalogue mapping. An entry-enabled supported
shape is valid declarative configuration but is not executable configuration.
Malformed or unsupported execution shapes fail parsing rather than being quietly
downgraded to monitoring. Valid monitor-only stocks may omit strategy assignment.

Current algorithm objects, proposal hashes, v4 trigger/idempotency, AI identity,
ownership, full-close checks and account/day budgets retain their semantics.
Nothing in PP1 creates parameterized strategy objects or rewrites historical rows.
Bundle mode suppresses the legacy event-driven signal pipeline as well as runtime
proposal/dispatch paths; a registry flag alone is not sufficient enforcement.
Existing supported ownership can still be reconciled/closed under §7.

## 2. File schema, lexical rules and limits

Export `TradingConfigurationV1`, `MomentumConfigurationParametersV1`,
`TradingConfigurationIssue`, `TradingConfigurationParseResult`,
`parseTradingConfiguration(input: unknown)`, and
`MOMENTUM_CONFIGURATION_DEFAULTS_V1` from shared. Parser is pure and dependency-free
(no environment, fs, DB, crypto, broker, logging or imported application code).
Input is a JSON text or decoded JSON value. Success is
`{ok:true, configuration: TradingConfigurationV1}` with a deep-frozen fully
normalized snapshot; failure is `{ok:false, issues: readonly
{path:string, code:string, message:string}[]}` and no partial snapshot.

Reject malformed JSON, null/array roots, unknown keys at every level, coercions,
NaN/infinities, negative zero, prototype keys (`__proto__`, `prototype`,
`constructor`) and non-plain objects in decoded input. String syntax is exact:
no trimming, uppercasing or conversion from numeric strings. Generic IDs match
`^[a-z][a-z0-9_]{0,63}$`; other text is ASCII, nonempty and at most 64 characters.
Symbols/local symbols/trading classes match `^[A-Z0-9][A-Z0-9 ._-]{0,31}$` without
leading/trailing whitespace. Currency is exactly `PLN` or `USD`. IANA zones below
are exact literals. Positive integer means safe integer > 0. Reject duplicate IDs
within each catalogue, duplicate references and empty required lists. Catalogue
arrays have at most 100 entries; instruments 1–100, instances 0–100; JSON text at
most 1 MiB UTF-8. Bound errors to 100 issues in traversal order. Diagnostics name
schema paths and fixed reason text, never raw input or rejected field values;
malformed JSON does not echo the JavaScript exception containing source text.

Required root keys are exactly `schemaVersion:1`, `strategyInstances`,
`instruments`, `accountPolicies`, `entryPolicies`, `executionPolicies`,
`riskPolicies`, `researchPolicies`, `issuerMappings`. All are arrays except version.
Policy catalogues and issuer mappings must each contain at least one element.
Unused valid catalogue rows are permitted and included in the effective hash.
No comments, date/version labels, arbitrary metadata, provider URLs or secrets.

Strategy instance fields (all required except `parameters`):

| Field | V1 semantics |
| --- | --- |
| `id` | Unique generic stable ID |
| `implementationId` | Exactly `momentum_breakout_long_v1`; other registered algorithms reject `UNSUPPORTED_IMPLEMENTATION` until their parameter contract lands |
| `revision` | Positive safe integer; an operator-managed immutable revision identity |
| `enabled` | Boolean, no default |
| `parameters` | Optional strict object of the three overrides below; omitted means `{}` |

Only these three input overrides are representable in PP1. Values are finite
numbers; percentages are percentage points (8 means 8%, not 0.08).

| Parameter | Resolved default | Inclusive range |
| --- | --- | --- |
| `dailyReturn20MinPct` | 8 | 0–100 |
| `h1Return4MinPct` | 1 | 0–100 |
| `return60MinPct` | 0.2 | 0–3 |

The normalized instance parameters additionally include these fixed implementation
v1 defaults. Input attempting to override these fields is rejected, not ignored:
`return20MaxPct=1.2`, `return60MaxPct=3`,
`consolidationDriftMaxPct=0.8`, `rsiMax=72`, `bbWidthMaxPct=0.08`,
`volumeMultiplier=1.2`, `closeLocationMin=0.6`, `bodyMin=0.12`,
`upperWickMax=0.45`, `plannedRewardMinPct=0.6`, `stopAtrMult=2`,
`structureStopAtrMult=3`, `takeProfitR=5`, `minRegimeScore=5`,
`sessionUtcStartHour=8`, `sessionUtcEndHour=20`.
These values were read from `paramsForSecType` in the current momentum source,
not inferred from comments (a comment still mentions a regime score of 9).
Candle-quality values are fractions of candle range; ATR/volume/R values are
multipliers; RSI/regime are scores; hours are UTC integers. `bbWidthMaxPct` retains
the exact existing indicator unit/value; PP1 does not reinterpret it or expose it
as an editable percent. Changing this defaults version requires a reviewed schema
revision. PP2 must supply parity evidence before using these values at runtime.

Policy catalogue rows have exactly these required fields, with no defaults:

| Catalogue | Fields and validation |
| --- | --- |
| `accountPolicies` | `id`; `maxOpenPositions:1`; `accountDayTimeZone:"Europe/Warsaw"` |
| `entryPolicies` | `id`; `kind:"supervised_one_attempt"`; `maxAttemptsPerAccountDay:1` |
| `executionPolicies` | `id`; `direction:"LONG"`; `quantity:1`; `quantityUnit:"shares"`; `orderType:"LMT"`; `timeInForce:"DAY"`; `outsideRth:false`; `protection:"bracket"` |
| `riskPolicies` | `id`; `maxPositionQuantity:1`; `maxEntryNotional:{amount,currency}`; `maxSpread`; `maxSlippage`; `allowOvernight:false` |
| `researchPolicies` | `id`; `required:true`; `kind:"issuer_news_required_v1"` |
| `issuerMappings` | `id`; `issuerId` (generic ID); `providerSymbol` (symbol syntax); `currency`; `primaryExchange` |

`maxEntryNotional.amount` is finite > 0 and <= 1,000,000 in named quote currency.
`maxSpread` and `maxSlippage` are finite > 0 and <= 10,000 in quote-price units per
share. No account percent conversions or implicit FX exist. These configured caps
cannot relax existing runtime/account checks. Account/entry policies document the
current narrow limit and remain ineffective until PP3 integrates them. Issuer
mapping syntax is not verified company identity, provider coverage or entitlement.
`primaryExchange` in mappings follows the instrument venue literals below.

Instrument fields are exactly:

- `id` (generic ID), `assetClass:"stock"`;
- `contract:{broker:"ibkr",symbol,conId,exchange,primaryExchange,currency,localSymbol,tradingClass,expectedMinTick}`;
- `session:{useRTH:true,timeZone}`;
- `monitoringEnabled` and `entryEnabled` (required booleans);
- `strategySelection:{mode:"single",instanceIds:[...]}`;
- `accountPolicyId`, `entryPolicyId`, `executionPolicyId`, `riskPolicyId`,
  `researchPolicyId`, `issuerMappingId` (required generic references).

`conId` is positive safe integer. `expectedMinTick` is finite > 0 and <= 1000
quote-price units; it is only an operator expectation until broker verification.
Its inclusion allows existing bound monitoring without fabricating a tick. It
never substitutes for market-rule tick bands or a fresh order grid.

Supported declaration pairs are WSE/WSE/PLN/Europe/Warsaw and
SMART/(NASDAQ|NYSE|AMEX)/USD/America/New_York. Routing venue and primary listing are
separate required values; a WSE instrument cannot use a US zone or USD. ETF,
future, option, short, fractional, market/stop entry, GTC, leverage, overnight,
extended-session and priority/multiple selection are rejected as unsupported even
when entry is disabled. This version supports monitoring of the declared stock
matrix, not arbitrary asset syntax. Expanding the matrix requires a new contract.

All references resolve to exactly one same-bundle row. Risk currency and issuer
mapping currency/primary listing must equal the contract. `mode=single` permits
zero references only when `entryEnabled=false`; otherwise exactly one. A disabled
referenced instance is valid but reports `STRATEGY_INSTANCE_DISABLED`; no fallback
instance is chosen. `entryEnabled=true` requires `monitoringEnabled=true`.
Reject duplicate `(broker,conId)` and duplicate listing identity
`(broker,primaryExchange,currency,symbol)` even when conIds differ. Also reject two
instruments with the same symbol: the current ingestion/cache paths key some data
by symbol, and PP1 cannot claim safe dual-listing support before that is corrected.
There are no PKO/AAPL checks in the parser; a third fixture stock must pass.

Stable issue codes: `INVALID_JSON`, `INVALID_TYPE`, `UNKNOWN_FIELD`,
`UNSUPPORTED_VERSION`, `INVALID_VALUE`, `DUPLICATE_ID`, `DUPLICATE_IDENTITY`,
`MISSING_REFERENCE`, `UNSUPPORTED_IMPLEMENTATION`, `UNSUPPORTED_CAPABILITY`,
`CONTRADICTORY_POLICY`, `LIMIT_EXCEEDED`. Exact paths use `$`, `.field`, `[index]`.
Use most specific semantic code after primitive validation; do not throw on normal
invalid inputs. Array-order-specific error paths do not enter configuration hash.

## 3. Identity and canonicalization (A ownership)

Add shared `canonicalizeTradingConfiguration`, `computeTradingConfigurationHash`
and `computeStrategyInstanceHash`. They accept only validated snapshots, not raw
objects. Canonical JSON recursively sorts object keys lexicographically and sorts
all root catalogue arrays by ID and `instanceIds` lexicographically. All normalized
fields including resolved defaults participate. No timestamps, file paths, mode,
environment, process/service ID, account IDs or broker/readiness observations enter
the bundle hash. Serialize numbers with JSON's finite-number representation;
parser already rejects negative zero. Hash UTF-8 canonical bytes using SHA-256,
return lower-case 64 hex. Canonical format is versioned as
`canonicalVersion:1` in the hashed envelope alongside `configuration`.

Instance hash envelope is `{canonicalVersion:1,implementationId,revision,parameters}`
with canonical object keys, and includes fully resolved fixed defaults. Instance
ID is the stable assignment key and is not part of the parameter identity hash.
Two distinct IDs may share parameters and hash; revision changes hash. Persisted
same `(instanceId,revision)` with changed instance hash rejects startup
`INSTANCE_REVISION_REUSED`; a renamed/revised instance does not reset account
limits, authorize entry, or mutate any old proposal identity.

The root file has no claimed hash field. `TRADING_CONFIG_EXPECTED_HASH` is a
separately supplied immutable rollout pin, required in bundle mode, compared to
computed effective hash. Wrong pin is a startup error. Parsing/canonicalization
and expected-pin check happen before I/O side effects. Whitespace/object key/
catalogue order or omitted default versus explicit default do not change hashes;
changes to any policy, assignment, enabled flag, contract or revision do.

## 4. Loading and legacy authority

Export `loadTradingConfiguration` from a separate Node-only `@ikbr/shared/trading-config` package subpath; fs/crypto/DB-dependent exports must not enter the browser-facing shared barrel. Pure parser/types may remain in the main shared barrel. The loader takes
an explicit environment record and injectable file reader, with no dotenv call.
Return discriminated legacy/bundle authority plus safe diagnostics. Applications
call it after dotenv and before application clients are connected or worker loops
start, including llm-agent whose old AAPL resolver currently catches errors.

`TRADING_CONFIG_MODE` is `legacy` or `bundle`. Absent mode preserves current legacy
behavior with `LEGACY_CONFIGURATION_UNVERSIONED` diagnostic; explicit `legacy`
reports `LEGACY_CONFIGURATION_DEPRECATED`. Neither choice changes existing opt-ins.
Any nonblank config path or expected hash in legacy/absent mode is an error, not an
ignored configured bundle. Bundle mode requires nonempty absolute
`TRADING_CONFIG_PATH` and valid expected hash. Missing/unreadable/oversized file or
invalid schema fails startup; no fallback, retry-on-old-authority or hot reload.

In bundle mode reject these non-neutral raw legacy authority inputs before schema
defaults are applied: nonblank `INSTRUMENT_BINDINGS_JSON`, `WATCHLIST_SYMBOLS`,
`WATCHLIST_CONTRACT_OVERRIDES`, `SIGNAL_PRICE_MULTIPLIER_OVERRIDES`,
`SIGNAL_FRACTIONAL_SYMBOLS`, `TRADING_LOOP_INSTRUMENT_IDS`; true
`GPW_PROFILE_ENABLED` or `AAPL_PROFILE_ENABLED`; nondefault `GPW_MOMENTUM_PROFILE`.
Empty strings, absent values, false profile flags and absent/`default` momentum
profile are neutral. Existing connection, account auth/risk controls and activation
flags are not alternate identity authorities; preserve them. Global IB default
venue/currency never override the per-instrument bundle contract.

Compose mounts one configuration directory read-only at `/app/config/trading` for
all four consumers and forwards identical mode/path/hash settings. Normal Compose
compatibility defaults to explicit legacy and blank file/hash. A committed disabled
PKO+AAPL example lives in that directory; conversion is an explicit settings change.
Use an empty isolated env file for Compose validation, never dump operational env.

## 5. Runtime projections and broker evidence

Shared `buildTradingConfigurationProjection` produces frozen logical registry,
monitoring binding descriptors, per-instance identity and readiness. It must not
replace old application helpers with a new strategy framework. Bundle instruments
have monitoring flags from configuration, no signal/AI generation flag and no new
entry execution authorization. No configured strategy parameters reach current
algorithm constructors. New entry paths use §6, never infer admission from legacy
`executionEnabled`. The close-management authority is separate (§7).

Ingestion uses only bundle instruments for its new monitoring watchlist, retaining
exact conId, symbol, STK, routing exchange, primary exchange, currency, localSymbol,
tradingClass and expectedMinTick. Existing contract-details matching is extended
where needed to compare primary listing as well as existing identity fields. Zero,
multiple or contradictory matches are rejected; missing fields remain unknown.
No first-result, symbol-only or seed fallback. Reuse existing generic session
schedule reader/persistence and expose its existing observed evidence where
available. Do not synthesize sessions from the declared zone.

Readiness includes per instrument `monitoringEnabled`, `entryRequested`,
`entryReady:false`, assigned instance IDs/revisions/hashes and `reasons`, plus
`brokerIdentity`, `session`, `priceGrid`, `quote`, `research` statuses. Each status
is one of `unknown`, `verified`, `mismatch`, `unavailable`, with fixed reason codes
and observation time when known. Broker identity can become verified only on exact
returned metadata including primary listing. Missing metadata => unknown, explicit
mismatch => mismatch; configured expectation alone never verifies it. A valid
session needs broker schedule evidence with existing validity/coverage checks;
minTick equality alone never verifies market-rule tick bands. If an adapter lacks
market rules expose `unavailable`; unrequested/unobserved data is `unknown`.
Fresh BBO and provider verification remain their own evidence, not config promises.
Fixture evidence can exercise verified states but live status must use real sources.

## 6. Audit, drift and denied admission

A new additive migration creates immutable configuration snapshots keyed by
`effective_hash` (canonical version, schema version, normalized JSON, created_at),
immutable instance revision identities, per-service observations and migration
records with old/new identities and `entries_disabled:true`. Do not alter released
SQL or existing proposal/order/budget hashes. Normalized audit JSON is decoded by A-owned `decodeTradingConfigurationSnapshot`, not passed directly to the raw parser (normalized parameters include fixed fields that raw input correctly rejects). The decoder requires the exact normalized schema and every fixed parameter equal to the v1 defaults; rejects missing/extra fields, changed defaults and malformed types; removes only those already-verified fixed parameter keys from a deep copy, then invokes the raw parser. Recanonicalize the returned normalized value, require byte-for-byte equality with the stored canonical JSON and require its computed hash to match the stored key before it is trusted. Never strip unexpected keys first or trust database JSON/hash claims independently. Snapshot insertion is transactional
and idempotent: same hash with inconsistent canonical bytes or reused revision is
a hard conflict. Persist snapshots before publishing ready/starting loops. Failure
to persist denies admission and readiness. The execution migration runner remains
the migration owner; other services may wait/retry schema availability before
starting their functional loops, never create ad hoc tables.

Persist startup/service observations for all four consumers, including llm-agent
(which currently has no HTTP server). Each observation has service name, random
process UUID, mode, version/hash, `migrationPrepared` boolean, optional `legacySourceHash`, observed_at and lease expiration. `migrationPrepared=true` is published only after that process has installed the preparation guards; source capture checks the validated legacy hash, not a caller assertion. Use DB time,
heartbeat every 10 seconds, freshness 30 seconds, and retain separate active process
rows: a second same-service process on a different hash must not overwrite evidence
of the first. An expired observation is missing/stale, not matching. Heartbeats do
not reload config. Execution exposes this common read model at an authenticated
read-only configuration endpoint; ingestion/signal expose their local snapshot in
existing diagnostics. No new unauthenticated network listener for llm-agent.

Shared `assessTradingConfigurationAdmission` returns `{allowed:false,reasons}` in
bundle mode, adding `CONFIG_DRIFT` for any live differing identity/mode/version,
`CONFIG_SERVICE_UNAVAILABLE` for missing/stale participants, and the PP2/PP3 blockers
regardless of match. Unknown schema/canonical version and malformed peer rows are
untrusted/unavailable, not matches. DB/read failures deny. Legacy behavior remains
compatible only when no active bundle-mode participant declares a conflicting
rollout; mixed mode blocks new legacy entries too. Persist a singleton bundle-rollout latch when the first bundle snapshot is committed. The first conversion/latch transaction itself requires `TRADING_ENABLED=false` and atomically records the disabled transition, selected legacy source and new identity; source capture alone is insufficient. An already-latched compatible restart may use the master switch for authenticated supported closes, but PP1 entry denial remains unconditional. This implementation performs no such operational activation. Once latched, absence/expiration of bundle peers cannot restore legacy entry permission: legacy admission remains blocked until a separately reviewed rollback transition, outside PP1 operational actions. All upgraded legacy entry/provider paths consult the store; store failure blocks them. Prior to the latch, missing peers do not break existing legacy mode, but an active bundle peer still blocks it. Older deployed images cannot consult this latch, so first conversion requires all services upgraded and entries disabled; configuration cannot retroactively protect an old process. Configuration readiness is an
additional gate, not a replacement for existing /ready conditions.

A-owned enforcement applies before signal legacy event callback/proposal writes,
runtime execute/loop submission, llm claim/provider polling, execution AI decision
acceptance/entry submission, direct/migrated entry endpoints and any alternative
entry dispatch path discovered in route inventory. Configuration HTTP payloads
cannot claim or override local identity. Pauses do not delete/mark attempted or
unknown proposals retryable. Authenticated close, reconciliation, cancellation and
read endpoints preserve their existing guards and never depend on new entry readiness.
Tests must spy on the actual downstream proposal/provider/broker calls to prove
barriers, not merely assert a diagnostic boolean.

## 7. Migration, retained management and rollback

Before the first conversion, start all four PP1 services in legacy mode with the
existing authority and explicit `TRADING_CONFIG_MIGRATION_PREPARE=true`. This boolean
setting defaults false and accepts only exact `true`/`false`; true is invalid in
bundle mode and requires `TRADING_ENABLED=false`. Preparation mode suppresses new
proposal creation, both llm claim/provider/delivery paths, runtime/loop entry and
execution entry routes using the actual startup/admission guards, regardless of
legacy event/runtime/LLM enable flags. Master false alone is insufficient. Source
snapshots are created only in this explicit preparation mode, never automatically
during ordinary legacy startup. Record prepare-mode observations for all services;
source capture/first conversion requires all four current observations in prepare
mode on the same legacy source identity, so a partially prepared stack cannot pass.
Ordinary pre-latch legacy behavior remains unchanged when preparation is false. Persist a trusted immutable legacy management
snapshot from the application's validated registry/bindings, including its original
execution policy and flags. Require `TRADING_ENABLED=false` for creating this migration source snapshot (ordinary compatible legacy startup retains its existing behavior but cannot capture a migration source without preparation mode). Explicit bundle migration supplies `TRADING_CONFIG_LEGACY_SOURCE_HASH` selecting the already persisted source; it is a 64-character lower-case hex hash, never raw bindings. On a fresh database without any retained ownership, this setting may be absent. A configured unknown/mismatched source hash rejects startup. This is deployment audit state, not a caller-supplied
new execution authority. Record the legacy authority hash over only the retained
instrument/binding/policy data; never capture raw environment/secrets. No automatic
conversion of legacy enabled flags into bundle `entryEnabled=true`.

Execution startup checks all nonterminal owned lifecycle/submission state against
retained management authority. If an owned supported instrument cannot be resolved
with exact original broker identity/policy from the explicitly selected source hash, fail conversion with
`LEGACY_MANAGEMENT_SNAPSHOT_REQUIRED`; do not declare migration safe or invent policy.
Unattempted proposals remain stored but blocked in bundle mode. Attempted/unknown
orders remain on their reconciliation/ownership path. Conversion does not drain,
reset, delete, rehash or rewrite these rows, and does not create retry permission.

The baseline does not persist a complete per-proposal historical risk-policy
snapshot. Preparation captures the current validated legacy policy and binds it
to durable proposal instrument/conId/symbol/strategy/client-order-hash evidence;
it cannot prove that an operator never changed legacy policy before this capture.
Do not claim that PP1 reconstructs unavailable historical policy. Retain current
ownership, fresh broker and deterministic close-risk checks; unsupported or
conflicting ownership still rejects.

The current full-close risk layer explicitly requires
`bound.instrument.trading.executionEnabled` and the original execution policy.
Therefore bundle monitoring projection cannot be used as its authority. Resolve
supported existing ownership through the persisted legacy management binding,
validated against original durable ownership identity, even if the new bundle
removes/reassigns/disables the instrument. Entry routing never consults this
management authority. Reusing an instrument ID or conId with a different identity
than the retained source is rejected; a removal is allowed because original management
authority survives independently. Compatibility compares every identity field known
in the retained legacy source. Existing PKO/AAPL seed instruments lack primaryExchange;
its absence is unknown, so it is not a conflicting known value and may coexist with
the new explicit primary-listing expectation. Do not add that expectation to the
retained source or call it broker verified; bundle metadata verification still requires
exact primary listing. A present conflicting legacy primary listing always rejects. Retained monitoring for an owned instrument that is removed or whose current
`monitoringEnabled` is false must be appended or preserved as management-only, never receive new strategy assignments. Unknown,
unowned or unsupported quantities keep current refusal behavior; this does not add
legacy-position support that the close workflow does not already have.

Store management snapshots append-only; later bundle boot/removal must not overwrite
them. Conflicting instrument ID/contract/policy observations deny management resolution
until explicit compatible evidence is restored. New bundle identity must not silently
replace original owned identity. Original master switch/auth/current broker quantity,
risk, idempotency and non-reversal checks remain mandatory for close. Tests cover
the actual supported one-share close service/risk flow after disable/removal and restart, including its ingestion `/watchlist` original identity evidence, missing
snapshot refusal, mismatched conId refusal and retained budget/unknown state.

Rollback uses last compatible image and authority while retaining additive audit
state. Do not delete new tables or consumed budgets. A restart recomputes hash and
revalidates revision identity, peer leases and management compatibility. Old images
that cannot enforce the rollout pin are not automatically safe rollback targets;
keep entries disabled and use the PP1 legacy mode for a reviewed return. No running
broker/provider call or operational conversion belongs to this implementation task.

## 8. Delegation ownership and hostile evidence

PP1-B owns only pure types/parser/default constants and fixtures/tests under
`packages/shared/src/trading-configuration/{types,parser,defaults}.ts` plus their
tests and fixture directory. It must not implement hashes, snapshots, broker
verification, env precedence, readiness admission or legacy policy conversion.
PP1-A owns identity, loader authority semantics, drift/admission barriers, migration
and retained close authority. PP1-C wires accepted pure/shared interfaces to the
four startup paths, read-only mount and diagnostic views; semantic gaps return to A.
Shared barrel exports are integrated by the lead after disjoint workers finish.

Required fixtures: PKO+AAPL sharing one immutable instance, a second distinct
parameter set, a fixture-only stock symbol not in production source, monitor-only
without assignment, disabled referenced instance, every invalid primitive/reference/
unknown field/version/capability and duplicate broker/listing/symbol case. Test
mutation cannot change one shared instance through another consumer. No strategy
execution/cooldown-isolation claim is made before PP2.

A tests canonical permutation/default equivalence, identity changes, revision reuse,
unknown peer versions, same-service concurrent drift, stale/missing leases, mismatch
and DB outage denial, all actual entry boundaries, management removal/rollback and
snapshot conflicts. C tests real boot wiring across all four services with injected
file/DB/broker/provider dependencies and zero external calls. A third stock must
traverse actual loader/projection/diagnostic paths without ticker-specific branches;
parsing alone does not meet this acceptance. Production metadata can remain unknown
with precise reasons; tests and docs must not promote unknown to operational ready.

## 9. Broker evidence interface for independent integration

Lead owns `packages/shared/src/trading-configuration/broker-evidence.ts` and tests
(pure types/evaluator), plus
`apps/execution-engine/src/configuration-metadata-client.ts`, its tests and the
read-only metadata route. It may reuse inspected WseMetadataClient transport
patterns while preserving that client's legacy public behavior. No new broker
write method. PP1-C owns `IB_CONFIG_METADATA_CLIENT_ID` schema/config plumbing,
default 155, positive integer <= 2147483647. Reject collision with ingestion,
execution, backtest, legacy WSE metadata, completed-orders, session-schedule and ES
acquisition client IDs using their configured values or existing defaults.

The generic adapter opens no socket at startup or on ordinary configuration status
reads. Only an authenticated execution configuration metadata request invokes its
read-only contract-details/market-rule transport. Use a dedicated configured client
ID, serialized requests and bounded timeout; always disconnect/remove listeners
on completion/failure. An account mismatch, broker error, disconnect or missing API
is explicit unavailable evidence, never fallback success. Config diagnostics use
cached observations or unknown until a request is explicitly made. No request is
made against a real broker during PP1 implementation/tests.

Export pure `TradingConfigurationBrokerObservation`,
`TradingConfigurationBrokerEvidence` and
`evaluateTradingConfigurationBrokerEvidence(instrument, observation, nowMs)`.
The input instrument is a validated v1 instrument. `nowMs` is finite epoch millis.
The observation is absent or has this exact typed shape:

- `requestStartedAt`, `observedAt`: canonical UTC ISO strings (`toISOString()`
  format), marking metadata request start and completed receipt;
- `candidates`: returned details array, each with `contract` (conId, symbol,
  secType, exchange, primaryExchange, currency, localSymbol, tradingClass),
  `minTick`, `validExchanges:string[]`, `marketRuleIds:number[]`;
- optional `marketRule:{id:number,bands:{lowEdge:number,increment:number}[]}`;
- optional `sessionEvidence:SessionScheduleEvidence` from existing shared schedule
  contracts, never a fabricated timetable derived from declared timezone;
- optional `quote:{instrumentId:string,conId:number,source:"ibkr",marketDataType:number,bid:number,ask:number,bidObservedAt:string,askObservedAt:string}`;
- optional `unavailableReason` selected from fixed transport reason codes (not raw
  exceptions or arbitrary broker text).

Returned broker `primaryExch` may be mapped to `primaryExchange` by transport;
conflicting supplied aliases reject. No missing returned field is filled from the
request. The adapter retains invalid/ambiguous evidence for evaluation rather than
selecting a first match. A wholly failed request may return empty candidates and an
unavailableReason. Evidence output contains `instrumentId`, metadata `observedAt`
when valid, and `identity`, `session`, `priceGrid`, `quote` components, each
`{status,reason}`; status has exactly four values: `unknown`, `verified`, `mismatch`,
`unavailable`. Also expose `sessionOpen:boolean|null` separately.

Freshness and identity rules are exact:

- Both metadata timestamps must round-trip through `new Date(...).toISOString()`;
  `requestStartedAt <= observedAt <= nowMs`, and
  `nowMs - requestStartedAt <= 60_000`. A malformed, future, reverse or older
  timestamp makes identity and grid unavailable (`BROKER_METADATA_STALE` or
  `BROKER_METADATA_TIMESTAMP_INVALID`), never verified.
- Absent observation is unknown; completed zero candidates is unavailable; two or
  more candidates is mismatch. For one candidate exact equality includes STK,
  configured conId, symbol, routing exchange, primary listing, currency, localSymbol
  and tradingClass. Missing required returned field => unknown; any present
  conflicting field => mismatch. Use existing `tickSizesEqual` only for finite
  positive minTick versus expectedMinTick. Equal minTick is not grid verification.
- Identity failure prevents grid verification, regardless of apparently valid bands.
  All diagnostics report fixed reasons and do not replace configured identity.

Route/grid rules: `validExchanges` and `marketRuleIds` must be nonempty arrays of
identical length <= 256. Every exchange is a nonempty trimmed uppercase route
string; duplicate exchange names reject. Every rule ID is a positive safe integer;
the same rule ID across different routes is permitted. The declared routing
exchange must occur exactly once. For SMART select the SMART index, not the
primary listing index; verify primary listing independently against the contract.
Returned marketRule.id must equal the selected ID. Bands must number 1–256, begin
at `lowEdge=0`, have strictly increasing finite nonnegative lowEdge values, and
finite strictly positive increments. Missing mapping/API/rule is unavailable;
contradictory/malformed route mapping, wrong rule ID or bands is mismatch. The
validated complete route-selected band list establishes verified price-grid
metadata only; it does not authorize an order or imply fresh BBO.

Session rules reuse `requireSessionHistorySchedule(evidence, identity, nowMs)`
including its six-hour freshness and history coverage checks. Missing evidence is
unknown, REFRESHING/FAILED/stale evidence unavailable, identity/timezone or malformed
schedule mismatch. When valid historical coverage does not extend through now,
report unavailable `SESSION_CURRENT_COVERAGE_MISSING`. Otherwise session metadata
is verified and `sessionOpen` is true exactly for `start <= nowMs < end` in one
validated interval. Outside every interval is `sessionOpen:false` with
`SESSION_CLOSED`; it is not a stale/unknown metadata claim. `sessionOpen:null`
applies to unknown/unavailable/mismatched session evidence. Declared zone or broker
liquidHours text alone cannot replace the existing validated schedule source.

Quote rules: absent quote is unknown. `instrumentId` and `conId` must exactly
match the configured bound instrument and `source` must be `ibkr`; missing identity
or provenance is unknown and conflicting identity/provenance is mismatch. Only a
trusted ingestion reader may attach this source after verifying connected/subscribed
state and the returned row's instrument/conId identity. HTTP callers cannot supply
or attest quote evidence. `marketDataType` must be exactly numeric `1` (real time):
missing is unknown, any other value unavailable (`QUOTE_NOT_REALTIME`). Bid/ask
must be finite > 0 with bid <= ask. Both canonical UTC source timestamps must be
<= nowMs with `0 <= nowMs - timestamp < 10_000`; exactly 10 seconds is stale,
matching existing close-risk freshness. Crossed/nonpositive/malformed prices are
mismatch; stale/future/unparseable timestamps unavailable with fixed reasons.
Quotes retain independent original source stamps: a metadata read, ingestion
projection or poll must never refresh them or derive receipt time from now.
Metadata validity does not substitute for verified quote identity. Tests cover
delayed/frozen types, missing provenance, unrelated row identity, caller evidence,
exactly-10-second boundary and current-disabled retained-management monitoring.

`buildTradingConfigurationProjection(configuration, evidence?)` defaults missing
evidence to unknown and research to unavailable `PP4_RESEARCH_UNAVAILABLE`; it
returns `{registry, bindings, instances, readiness}`. `bindings` are existing
`InstrumentBinding` inputs derived solely from contract and expectedMinTick.
Registry uses stock session templates, configured risk and monitoring flag;
signal/AI/entry flags are false, with no executable entry policy. `instances`
contain immutable id/revision/hash records. Readiness combines blockers and supplied
evidence without allowing entry. Evidence cannot mutate registry or inject a tick.

A and C coordinate exact storage/startup signatures before dependent implementation;
signature-only adaptation does not change semantics. APIs allow injected file/DB/
broker dependencies in tests without importing socket-starting main modules. Signal
and llm validation is unconditional, independent of runtime/worker-enabled flags.
llm gating covers bound-worker plus legacy claim/process/delivery. PP1-C owns
bound-watchlist/binding-verification and tests to propagate/verify primary listing.

## Review history

Initial independent Astra plan review: CHANGES REQUIRED, four safety findings.
Repair round 1 fixes: (1) first conversion itself requires disabled writes and an
atomic rollout latch; (2) removed owned instruments retain mandatory ingestion
monitoring and actual close-service evidence across restart; (3) exact broker
observation freshness/route/grid/session rules and normalized snapshot decoder are
fixed above; (4) explicit migration preparation suppresses proposal/provider/entry
paths before capture, beyond the master-write flag. Independent re-review accepted these fixes.

Repair round 2 addresses final independent P2 clarification: verified quotes require
trusted IBKR ingestion provenance, exact instrument/conId, real-time marketDataType
1 and strict less-than-10-second original source timestamps. Retained management
monitoring is mandatory for owned instruments both removed and present-but-disabled.
Independent re-review accepted the contract before implementation started.

Narrow implementation clarification accepted by the independent Astra plan reviewer: first bundle installation
on a fresh DB may omit legacy source only after a successful query proves no retained
attempted/unknown/submission-link/noncompleted-close state and no active legacy peers.
Conversion with a source still requires all four current prepare observations. Missing
legacy primary listing is unknown, not a known conflict; the immutable source is never
backfilled and all new broker verification remains exact. Source capture cannot prove
pre-capture historical policy values absent from baseline persistence.

Implementation clarification acceptance: RA accepted the known-field primary-listing
comparison and fresh-install evidence exception. Required tests use actual PKO/AAPL
legacy seeds and verify source hashes unchanged, known listing/conId mismatch rejection,
retained-state refusal without a source, and DB query failure never meaning empty.
