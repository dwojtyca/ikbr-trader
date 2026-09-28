# PP2 strategy runtime contract

Date: 2026-09-28. Status: accepted by independent Astra plan review on 2026-09-28. Baseline: `aba2928`, main. Author: PP2-B,
requested/selected `gpt-6-astra`, high; token telemetry unavailable.

This contract refines [PP1](PP1_CONFIGURATION_CONTRACT.md) for the bounded
[PP2 plan](PP2_IMPLEMENTATION_PLAN.md). PP1 schema/canonical version and instance hashes remain unchanged; the additive
priority selection shape below extends v1 without changing existing single-mode
canonical bytes. PP3 execution policy remains unavailable;
PP2 authorizes no deployment, provider request or trading activation.

## 1. Construction and parameters (PP2-A)

Keep `Strategy.id` and `StrategySignal.strategyId` as implementation IDs. Do not
rename these to instance IDs: profiles, sizing and legacy backtests use them.
Existing `createStrategy(id)` and `createStrategies(ids?)` retain their behavior.

Add `createConfiguredStrategy(instance: TradingStrategyInstanceV1): Strategy`
It constructs a fresh
object every call and accepts only validated, fully resolved momentum v1 parameters.
Expose `new MomentumBreakoutLongStrategy(parameters?)`, where omitted parameters
preserve legacy behavior and explicit parameters are copied/frozen after validation.
Use a pure validator for resolved parameters: exactly PP1's fields, finite numbers,
the three editable ranges from PP1 and exact fixed defaults for every other field.
Unknown implementations, unknown/missing fields and malformed fixed values throw
fixed diagnostic errors before strategy evaluation. Do not add another schema.

`evaluateMomentumBreakoutLong(context, allowedSecTypes?, parameters?)` may add an
optional third argument to retain its existing two-argument public API. Both the
constructor and helper must apply the same effective parameters. Avoid the current
`generateSignal` path accidentally creating a default evaluator and dropping the
configured parameters. Preserve signal formulae, thresholds, required timeframes,
regime checks, price math, quality filters and `shouldExit` behavior.

An explicitly configured instance rejects a non-default legacy
`context.momentumBreakoutProfile` with `momentum_profile_configuration_conflict`.
Absent/default profile uses configured parameters. The parameterless legacy path
retains its PKO identity checks and mild/moderate named-profile behavior. This
prevents environment/context overrides from replacing an immutable bundle instance.

Factory/constructor tests cover full default parity, the three overrides one at a
time and combined, boundaries, rejection reasons, helper parity, fresh objects and
independent last-rejection state. Other registered algorithms remain usable through
the legacy factory but reject through the configured factory. Test at least two
such unsupported algorithm IDs; PP2 does not add their parameter contracts.

## 2. Selection schema amendment (PP2-B2 critical)

Extend `TradingInstrumentV1.strategySelection` to a discriminated union:

```ts
{ mode: "single"; instanceIds: readonly string[] }
| { mode: "priority"; instanceIds: readonly string[];
    priorities: Readonly<Record<string, number>> }
```

Single mode retains PP1's exact normalization, fields and 0/1 cardinality. Never
add a default priority field to old single snapshots. Priority mode allows 1–100
unique instance references, or zero only when entries are disabled. `priorities`
has exactly the same keys as instanceIds, no missing/extraneous/prototype keys;
values are distinct safe integers 0–1000 inclusive. Larger wins. Ties reject
`CONTRADICTORY_POLICY` even for disabled instances; duplicate refs retain PP1's
rejection. All references must resolve, and unsupported algorithm contracts remain
rejected. Disabled instances are valid assigned rows but do not become candidates.
Unknown modes/fields fail closed. Canonicalization sorts instanceIds and recursively
sorts priority keys; ordering changes do not change identity. Existing v1 single
canonical bytes and hashes have golden regression fixtures; priority changes affect
configuration identity. Snapshot decoding must accept and verify this additive
shape rather than rewriting old snapshots. This explicitly supersedes PP1's
priority/multiple rejection for PP2 only; other capability limits stay unchanged.

## 3. Immutable attribution and hashes (lead critical slice)

Add a browser-safe shared `StrategyInstanceAttributionV1` type with exactly:

```ts
interface StrategyInstanceAttributionV1 {
  readonly version: 1;
  readonly implementationId: "momentum_breakout_long_v1";
  readonly instanceId: string;
  readonly instanceRevision: number;
  readonly instanceHash: string;
  readonly effectiveConfigHash: string;
  readonly instrumentId: string;
}
```

The field name carried by `StrategySignal`, `SignalTicket`, `ProposedOrder`, runtime
signal metadata and read models is `strategyAttribution`. It is optional only for
legacy records. IDs/revision/hash validation matches PP1. Attribution is derived
from the server-loaded immutable configuration and exact assignment, never accepted
as evidence merely because an HTTP client supplied it. Validate the complete object
against the stored configuration snapshot, immutable instance revision and proposal
instrument/conId/algorithm; disabled assignment rejects new entry admission.
A snapshot hash alone does not prove that an instrument assigned this instance.

Add versioned client-order hashing without changing historical bytes:

- Unattributed ticket: v1 canonical bytes and digest are exactly unchanged.
- Attributed ticket: v2 SHA-256 over deterministic canonical JSON envelope containing
  `version:2`, the existing v1 canonical ticket string, `instrumentId`, the
  complete validated attribution object and complete `strategyTrigger` (§5). Recursively sort object keys; no raw JSON
  insertion order, timestamps, diagnostics or mutable readiness enter attribution.
- `computeClientOrderHash(ticket)` chooses v2 only for present, valid attribution;
  malformed attribution throws. Persist explicit `client_order_hash_version` and
  enforce version/attribution agreement when reading persisted records. Default
  old rows to v1 through the additive migration. Unknown versions reject.
- Removing attribution from a v2 row, replacing any field, or changing the stored
  version must fail persisted identity validation; never retry using another
  version. Historical v1 rows retain their original hashes and null attribution.

The logical `strategy` column stays the implementation label. New attributed writes
carry the full identity to proposal, AI claim/decision snapshot, deterministic risk
evidence and broker order ownership. AI approval binds proposal ID, hash/version,
full attribution, contract, account and session. Recheck at claim/finalize and at
execution prepare/reservation/dispatch, including after awaited admission work.
Risk evidence includes the proposal attribution before persistence; it cannot be
silently replaced by the currently enabled instance. Broker links already reference
proposal IDs: retain that FK and expose the immutable joined attribution rather
than inventing a mutable independent ownership label. Missing join/snapshot is an
explicit unavailable identity, never a latest-configuration fallback.

Use additive proposal columns and AI-review columns (JSONB attribution plus explicit
hash version), constraints requiring both-or-neither attribution/version, and DB
triggers preventing changes to these identity fields after insertion. Protect the
attribution-bearing proposal from deletion while linked audit/ownership survives.
Retain the original execution-policy reference inside the immutable configuration
snapshot associated with attributed proposals; retain algorithm parameters through
that same immutable bundle/instance revision. A separate duplicated policy JSON
is unnecessary if snapshot decoding validates all references. A new row with an unsupported policy never reaches a
provider or broker merely because its JSON is well formed.

Production bundle proposal creation remains blocked by PP3. Repository and service
fixtures must nevertheless exercise the real attributed insert/claim/validation
paths with injected admission and broker stubs, while actual production admission
tests prove zero proposal/provider/broker side effects.

## 4. Binding selection and evaluation (PP2-B worker)

Add `ConfiguredStrategyRuntime` in a new signal runtime module, constructed from
loaded bundle/effective hash, authoritative bindings, repository, existing
`StrategyContextLoader`, factory and clock. It owns a distinct strategy object per
`(instrumentId, instanceId, revision, instanceHash)`; no object is shared across
instruments even if they select the same instance. There is no global bundle
portfolio. Reuse `StrategyPortfolioManager` separately per configured instance or
its evaluation checks, so two instance IDs using the same algorithm do not collapse
in its algorithm-keyed lookup. Preserve exception rejection behavior.

The public evaluation method is `evaluate(instrumentId): Promise<ConfiguredStrategyEvaluation>`.
The discriminated result has `kind: "signal" | "no_signal" | "disabled" | "error"`,
`instrumentId`, optional immutable `strategyAttribution`, optional `signal`, and
fixed `reasons: readonly string[]`. Only `kind:"signal"` carries a signal. Invalid
identity, repository errors, malformed assignment and strategy exceptions return
`error`, never partial candidates; raw errors go only to existing private logging.
Return `entryAllowed:false` and `entryBlockers:["PP3_EXECUTION_POLICY_UNAVAILABLE"]`
(and actual other blockers) independently of signal presence.

Resolve assignment before looking up states, asking for candles or invoking any
strategy. Only the instrument's explicitly assigned instances participate. Instrument
entry disabled, no assignment, instance disabled or runtime safety disabled produces
`disabled`; no fallback to global `enabledInBot` or a different instance. The legacy
profile whitelist/blacklist is not an alternate bundle assignment authority. Keep
algorithm capability/direction/regime constraints and exact signal symbol/algorithm/
direction checks. Mutable legacy strategy toggle endpoints do not enable bundle
instances and do not reset their state.

Evaluate all enabled assigned instances after their safety checks, irrespective
of priority. Any exception discards every partial candidate. Opposite signal
directions yield `STRATEGY_CONFLICT` before rank selection regardless of priority;
this is exercised with injected strategies although the only configured algorithm
currently emits LONG. Highest configured priority wins among valid candidates;
single mode uses its sole candidate. Confidence and algorithm lanePriority cannot
override assignment priority. Ascending instance ID is a defensive deterministic
ordering only, never permission to accept an invalid priority tie. Never fall back
to an unassigned instance when the high-priority instance emits no signal. A
lower-priority assigned candidate may win when higher-priority assigned instances
emit no signal; those results remain independently attributed. Existing legacy
portfolio priority/conflict behavior is unchanged.

Candle requirements are the enabled assigned algorithms' requirements plus the existing
indicator/regime baseline (`1m,5m,1h,4h,1d` as currently required). No unrelated
algorithm adds `12h`/`1w` or triggers a policy mismatch. Use the existing session,
conId, closed-candle, data quality and regime computation path. Reassignment to a
third configured stock uses only configuration. The evaluator produces strategy
results and attribution, never an executable policy or broker readiness assertion.

Make this runtime reachable in the production service through a new read-only
`POST /runtime/strategy-evaluation` route accepting exactly `{instrumentId}`.
No caller parameters, attribution, account identity or policy overrides. Wire it
when runtime is enabled, with injected dependencies for route tests. The existing
`/runtime/dry-run` API stays compatible. In bundle mode the configured scheduled
loop uses the same evaluator and reports evaluated/no-signal/disabled/error outcomes
without entering `ExecutionRuntime`. It may run only when its existing scheduler
flag is enabled; no new default activation. Do not fake a ticket to get through
PP1's registry flags. Legacy scheduled behavior remains unchanged.

Configuration drift/store failure/preparation prevents bundle evaluation under a
separate read/evaluation readiness check; only the fixed PP3 entry blocker is
irrelevant to computing a diagnostic signal. Use the existing peer observation
freshness/hash rules. Every mutating/provider path still uses `assertEntryAllowed`.
Remove the PP2-unavailable diagnostic only where the configured runtime capability
is installed; never report entry-ready from this change. PP4 remains unavailable.

## 5. Durable state and revision-independent fences

Evaluation objects/rejection state are per binding and reconstructed on restart.
Durable loss/cooldown/permanent-disable state must not use a revision/hash key.
The stable safety key shared by same-algorithm instances on one contract is `(accountScope, broker, conId, implementationId)`; logical instrument
renames, instance renames, revision/configuration changes cannot reset it. Distinct
contracts use independent state. Use explicit `IBKR_ACCOUNT_ID`, forwarded to signal-engine and parsed together
with `IBKR_ENVIRONMENT` and its matching `ALLOWED_PAPER_ACCOUNTS` or
`ALLOWED_LIVE_ACCOUNTS` whitelist. Account ID must be nonempty/trimmed and present
in the exact environment allowlist; absent/ambiguous environment or account fails
bundle state readiness. Do not infer it from broker port, positions, snapshot
order or allowlist's first element. Legacy mode retains existing behavior.
Configured diagnostic evaluation never confers Live admission; existing Paper-only
write guards remain. Compose/config plumbing belongs to C and requires a clean
Docker build. No account ID enters the
public configuration hash or unauthenticated diagnostics.

Add a binding-state table and a processed-outcome ledger with unique
`(safetyKey, originalProposalId)` identity. Reuse the current three-consecutive-loss
cooldown rule and second-cooldown permanent-disable semantics; do not tune them.
The actual route/scheduler evaluator calls `state.sync` before evaluation, rather
than exposing an unused helper. Under a per-safety-key serialization lock, sync:

1. Reads attempted attributed original entry proposals for exact account/conId and
   implementation, including those with protective fills and linked full-close
   proposal fills. It never counts an entry commission as a completed loss. A
   successful empty query establishes no new outcomes; query failure is unavailable.
2. For each unprocessed original proposal, the injected production outcome reader
   calls the existing authenticated read-only
   `GET /execution/lifecycle/:id/round-trip`. That endpoint reads persisted evidence
   and current execution context without issuing broker/provider calls. Accept only
   `status=COMPLETED`, `accounting=COMPLETE`, exact original proposal/hash/attribution,
   account/conId and quote currency, empty missing-fees list and finite net P&L in
   that currency. Execution's existing `evaluateRoundTrip` establishes one-share
   owned parent + TP/SL or separately linked full-close completion, final broker
   flat state and fees. The report DTO must expose original hash/attribution for
   verification. Unsupported generic contracts return unavailable until PP3;
   never manufacture their P&L or broaden the lifecycle validator here.
3. Missing report, pending fees, mixed currencies, unproven ownership/closure, an
   attempted still-open proposal or transient read failure blocks that binding's
   evaluation. The diagnostic can report the exact reason; it does not replace
   exposure/admission controls. No retry inside one evaluation and no new observer.
4. Persist the validated report, account/contract/hash/attribution, final exit time,
   quote currency and net amount plus canonical economic fingerprint. Fingerprint
   the exact sorted owned execution records (exec ID, account, conId, proposal and
   order identity, side, quantity, price, execution time, commission/currency) and
   the original-to-close linkage. Do not use broker realized_pnl as the net-P&L
   source or coalesce missing fees to zero. The execution report owns arithmetic. Before commit, lock/re-read all relevant
   economic rows and linkage in the state transaction and compare them with the
   exact fill/fee/linkage inputs represented in that complete HTTP report. The
   report's net amount must agree with its gross/currency/fee inputs and the same
   locked inputs used for the saved fingerprint. A concurrent fee/fill/linkage
   update during the HTTP read produces `OUTCOME_EVIDENCE_CHANGED`; never save an
   old positive net amount beside a fingerprint of newly corrected negative data.
   Later inserts/updates are detected by the next-sync digest check. Include this
   exact interleaving in PostgreSQL tests.
5. Apply outcomes in `(finalExitAt, originalProposalId)` ascending order, with a
   composite watermark; same-timestamp distinct proposals both count. Lock state
   and append outcome/process ledger atomically. Duplicate fingerprint is a no-op;
   an unseen outcome earlier than the applied watermark yields a durable
   `OUTCOME_ORDER_CONFLICT` hold instead of changing historical streak order.
   Every sync compares consumed outcomes' underlying persisted fills/linkage against
   the saved fingerprints. Consumed reports are not re-requested using a new session
   after restart: original immutable completion evidence remains authoritative for
   that historical outcome, with the correction check still enforced. Late economic/identity/fee correction or missing original
   evidence creates a durable `OUTCOME_EVIDENCE_CHANGED` hold. Never replace the
   saved outcome, replay state or silently erase a previously counted loss.

Use DB time for cooldown start. Preserve counts across concurrent workers/restart.
Positive outcomes reset consecutive losses only, never cooldown count/permanent
disable. Exactly zero leaves consecutive losses unchanged, matching current rule.

At disabled conversion, capture each legacy algorithm state exactly once under
the conversion/state-initialization serialization lock, with an immutable inheritance
marker, source identity and source watermark. Initialize binding loss/cooldown counts,
flags and cooldown deadline from that capture. Persisted permanent/disabled state
cannot be cleared by current configuration or legacy UI toggle. Do not repeatedly
re-import a nonzero consecutive-loss count after a genuine new positive outcome
has reset the binding's streak. All legacy producers/state writers must be behind
the conversion barrier before capture; a peer that is not prepared blocks it.
Pre-v2 proposals are excluded from the new outcome ledger and represented only by
this conservative inherited state, avoiding double counting. New bindings/revisions
reuse the same stable contract/algorithm state; a newly encountered contract gets
the immutable conversion capture, not a now-reset legacy row. PP2 provides no
counter reset/unblock action.

Keep existing account reservation, GPW/AAPL day budgets and unknown-submission holds
unchanged. These remain stronger than binding isolation. No per-instance replacement
of account-wide limits. PP3 will generalize the budgets separately.

### Trigger wire contract and migration horizon

Add optional `strategyTrigger` beside attribution on SignalTicket/ProposedOrder and
runtime signal metadata. They must be present together for v2 writes. The exact
wire shape is:

```ts
interface StrategyTriggerV1 {
  readonly version: 1;
  readonly source: "evaluation_bucket";
  readonly timeframe: "1m";
  readonly observedAt: string; // canonical UTC timestamp of trusted price observation
  readonly bucketStartMs: number; // safe integer >= 0, divisible by 60_000
}
```

The configured evaluator derives it from `StrategyContextLoader`'s verified market
state timestamp, not evaluation time or HTTP body parameters. v2 canonical envelope
includes the complete trigger object. New identity is
`evaluation.1m.<bucketStartMs>` with bucketStartMs exactly
`floor(Date.parse(observedAt)/60000)*60000`. Before insertion and again before
attempt reservation, recompute it, require observedAt not future and age strictly
less than 90,000 ms against database time, and compare instrument/conId, direction,
algorithm and clientOrderId with the trusted proposal/assignment. The execution submission service's internal attributed-preflight reader
returns server-loaded effectiveConfigHash and trusted ingestion observedAt;
production execution `index.ts` wires it. Missing reader rejects attributed writes;
caller body fields are never this evidence. Repository internal insertion options
carry that trusted evidence and check it against DB time/stored configuration;
attempt reservation uses the fresh risk evidence timestamp. Legacy behavior is
unchanged and PP3 production admission rejects before invoking this reader.
At the entry boundary also require the bucket to equal the bucket of
the trusted, fresh ingestion price observation used in the current execution
preflight; caller observedAt must not exceed that trusted timestamp. Different
observations in the same bucket cannot create a new key. No caller timestamp alone
proves a trigger, and no change to timestamp can manufacture a different bucket
than the trusted current observation. Missing trusted evidence denies. Do not trust
an arbitrary caller trigger label. Repeated observations in the same bucket with a
changed timestamp/payload conflict conservatively, rather than creating a new
attempt. Existing legacy v4 derivation and keys remain byte-identical.

Reserve a durable unique proposal trigger fence on `(account, broker, conId,
direction, source, timeframe, bucketStartMs)` atomically with the proposal under
existing account reservation serialization. Revision, config hash, instance ID and
logical instrument ID are absent. Same trigger plus same full payload returns the
existing row; changed revision/config/observation returns conflict. Persist complete
trigger evidence on the proposal and fence and validate their equality, rather
than reverse-engineering new keys. A rolled-back transaction creates no reservation;
attempted/unknown/rejected/expired attributed fences are never released. Different
instruments still share the existing account reservation and day budgets.

At first legacy-to-v2 conversion, persist immutable `v2_not_before_bucket_ms` equal
to the NEXT minute boundary strictly after the DB-time disabled migration barrier.
New attributed proposals must have bucketStartMs >= this cutoff at insertion and
attempt reservation. This excludes every older trigger, including normally purged
legacy proposals, without claiming to reconstruct missing historical trades.
Conversion requires all peers paused and the drain predicates below; no legacy
producer may write a new proposal after the cutoff/barrier. Retained legacy v4
rows with buckets at/after cutoff are contradictory evidence and block transition;
malformed/unreconstructable retained attempted/unknown rows already block drain.
Retained old triggers below cutoff remain immutable/readable and account/day holds
remain untouched. A rollback cannot lower the cutoff or reopen legacy writes.
Tests cover a purged pre-cutoff row, boundary equality, delayed old observations,
renamed IDs and a concurrent writer during conversion. PP2 diagnostic evaluation
computes trigger evidence but does not consume a fence or broker budget.

## 6. Conversion, drain and old-position retention

Migrations `000017_strategy_instance_attribution.sql` (lead-owned) and
`000018_strategy_binding_state.sql` (B2-owned) are additive, preserve every old
proposal/client hash/account budget and add no operational reset. Migration must
be applied by existing migration runners before startup consumers access fields.
Test installation both on a fresh schema and on realistic v1 proposal/AI/order/
close fixtures. No destructive downgrade is provided.

### Conversion invocation and shared SQL boundary

Add an explicit `preparePP2Conversion` store operation in the shared Node-only
configuration module. Signal startup/evaluator initialization invokes it after
ordinary PP1 registration, with parsed environment/account context and writes
explicitly disabled. It is idempotent and persists a separate PP2 conversion marker;
ordinary PP1 registration behavior remains compatible. Until it succeeds, configured
state reports `PP2_STATE_CONVERSION_REQUIRED` and cannot evaluate entries.

For first legacy conversion it requires PP1's matching prepared observations before
bundle rollout, so the startup path invokes the same preparation during the final
prepared registration as well. For an already PP1-latched bundle without v2 records,
require caller's parsed `TRADING_ENABLED=false`, fresh matching bundle observations
from all four services, zero v2 proposal rows, no active legacy peer and the
existing immutable source (or the PP1 fresh-empty exception). Observations do not
attest peers' write-switch settings. The immutable bundle latch and PP1/PP2's
unconditional bundle proposal/AI/entry denial establish the shared no-new-entry
barrier; do not claim that observations prove all peers have writes disabled.
Existing supported close/reconciliation remains separately guarded, and unresolved
attempt/delivery/close evidence still blocks drain. This is a disabled, additive PP1-to-PP2 state conversion, not resetting
the PP1 bundle latch. Conflicting/missing peers or unresolved attempted state denies
conversion. The operation runs the drain and cutoff checks below, then captures
legacy state in the same DB transaction before publishing its immutable marker.
Never automatically run the operation with writes enabled or bypass preparation.

Migration 000018 supplies `capture_strategy_binding_inheritance(source_hash TEXT)`
for the lead's conversion transaction to call without importing app code. The
argument is the retained legacy source hash, or first effective config hash only
for a positively proven fresh installation. It must be lowercase 64-hex. The
function uses a fixed advisory transaction lock, then locks the legacy
`strategy_runtime_state` table against writers when present. It creates immutable
`strategy_binding_legacy_inheritance` rows keyed by `(source_hash,implementation_id)`
with `enabled`, `permanently_disabled`, `cooldown_until`,
`consecutive_loss_count`, `cooldown_count`, `last_evaluated_fill_at`, `captured_at`.
Capture all legacy algorithm rows; include a neutral momentum row only if that
algorithm has no state and no historical evidence requiring one. A repeated call
for an already captured source returns the same captured state without reimporting
current mutable counters. Unsupported state shape, malformed count/date or missing
source proof throws and rolls back the whole conversion.

The legacy state table is application-initialized and may be absent on a fresh DB.
Absence permits neutral capture only after successful queries prove no attempted
proposal, broker fills/order links or close operations needing historical state.
Query failure never means empty; an existing populated DB with missing state fails
`LEGACY_STATE_UNAVAILABLE`. The caller supplies/enforces the conversion peer/barrier
proof; the function additionally enforces these source/history checks. B2 owns the
function/schema and tests; lead owns the shared operation invocation/cutoff/drain.

For legacy conversion, explicit disabled-write preparation from PP1 is required:
all four services publish matching prepared observations. An already-latched PP1
bundle uses the equivalent unconditional no-new-entry barrier specified above.
Pause new proposal, AI claim/provider/delivery and dispatch before drain. In-flight work must stop at the
existing post-await guards. The transition/drain transaction locks proposals before
AI reviews, consistent with current execution/AI lock order. It may expire only
PROPOSED rows proven unattempted: no execution attempt timestamp, broker ID,
submission/order links, close ownership, AI delivery_started_at or unknown outcome.
A claimed review with a live lease is retained until the lease expires and the
worker barrier is observed; timeout alone does not prove a broker submission absent.
Recheck every predicate inside the lock. Mark reason `configuration_revision_invalidated`
and expire pending/approved review state without rewriting immutable decisions.

Attempted, submitted, unknown, delivered or ambiguously linked rows are retained and
block automatic conversion/drain when their disposition is not established. Do not
reset status, clear identity, erase budgets or auto-resubmit. Old rows remain dual
readable for audit/reconciliation/full-close. Use the immutable v2 trigger cutoff above rather than claiming to reconstruct
purged legacy history; retained contradictory/unknown evidence blocks transition. This
procedure is implemented/tested with disposable fixtures and documented, not run on
the operational database during PP2.

Original exit policy comes from the proposal's immutable policy/parameter snapshot,
not current assignment. Old pre-PP2 positions keep PP1's captured management
authority and existing stored order levels. Disabling/removing/revising an instance
must leave ownership, monitoring, broker protective legs and supported audited
full-close available under their existing guards. For new attributed fixtures,
load the stored bundle/instance/policy by original proposal identity even if absent
from current configuration. Expose a snapshot-based original-strategy resolver and
test its actual `shouldExit` result after removal/disable/reassignment. No configured
broker entries can legitimately exist before PP3; synthetic attributed ownership
fixtures do not authorize a generic management-policy projection or new close path. Missing snapshots fail explicitly; no default/current
fallback. PP2 does not add an automated exit observer or a new close quantity scope.

## 7. Simulator and read models (PP2-C)

Use the existing committed `BacktestSimulator` `strategyFactory` seam in a new
configured-replay wrapper; do not modify the dirty simulator or `SignalEngine`.
Run each configured binding in an independent simulator instance with the matching
symbol dataset, one implementation ID in `strategyIds`, and fresh configured factory. For priority
assignments, replay each selected instance as a separately labelled binding result
and use an additional context replay test to verify actual configured priority
selection; do not claim independent simulator runs model the priority portfolio.
This preserves existing profile sizing/entry-score rules and isolates its in-memory
cooldowns. Reject ambiguous symbol/contract input; do not merge independently run
binding equity/P&L into a claimed portfolio backtest. Attach full immutable
attribution to the wrapper's run/trade results and persist attribution in the
backtest run configuration/metadata using the existing repository capability.
Changing simulator risk or execution semantics is outside PP2-C and returns to A.

Provide default-vs-legacy deterministic replay with identical candles, options and
factory path; compare emitted signals and complete fills/P&L, not only trade count.
Provide two parameter sets whose known boundary fixture gives distinct results,
with separate instance attribution. The runtime parity harness compares raw strategy
signals on identical contexts; it does not claim that legacy backtest data loading
is identical to the live session-native loader.

Read models expose `strategyAttribution` or explicit legacy absence on signals,
proposals/orders and backtest results. UI can render algorithm, instance, revision
and short hash in existing order/signal detail surfaces. No latest-instance inference,
controls, new readiness claims, provider lookups or backend safety calculations in
UI. The lead owns critical row decoding; S consumes that accepted DTO. Missing
historical attribution must remain visibly legacy/unavailable.

## Review repair history

Initial RA review required four P1 clarifications: priority selection, account
scope, finalized owned outcomes and trigger/migration identity. The amended
sections above address them. The outcome clarification captures legacy counts
once under the disabled barrier, avoiding repeated import after a positive reset;
consumed completion reports persist across session restart and only stable
economic/linkage evidence is rechecked. Independent re-review accepted all amendments before implementation.
