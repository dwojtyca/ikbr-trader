# Continuous Paper operation and recoverable research preparation

Date: 2026-10-12. Status: ACCEPTED for implementation after independent critical
review by `continuous_plan_review` (requested Astra/high), one amendment covering
repeated same-contract cycles and immutable historical ownership. No remaining
blocking findings. A different independent agent must review implementation.
Baseline: `42afdf9bec979e61af31eca7b9bda900adfc101d` on main.

## Owner contract and scope

The owner explicitly replaces the short supervised-window operating model with
continuous IBKR Paper operation until the owner stops it. Start with PKO/WSE/PLN
and AAPL/SMART/NASDAQ/USD, one whole long share, at most one open position per
instrument. There is **no daily entry-attempt quota**. The owner approved a
USD5/day AI budget. Existing per-trade and account financial-risk limits remain.
Periodic research acquisition is retained, with the separately reviewed optional
Marketaux demand mode below. Identifiable missing or stale research
must initiate supported automatic acquisition instead of a terminal rejection
solely because those data are temporarily unavailable.

This direction supersedes the earlier fixed 20–60-minute scheduling and
one/two-attempt delivery restrictions for the new explicit mode. It does not
claim that the supervised broker round trip or subsequent soak has passed:
today's two PKO evaluations produced NO_SIGNAL, with no proposal/order/fill.
Real acceptance evidence remains distinct from implementation/release evidence.
No strategy formula, threshold, fake signal, forced AI approval, Live activation,
direct broker submission, fractional/short/ETF/futures capability is authorized.

Continuous means services and the scheduled strategy/data/supervision flow remain
running across broker sessions, weekends and process restarts. Entry occurs only
in current verified broker RTH sessions and before the existing exit margin.
Risk, missing permissions, unknown outcomes and disconnected broker can still
hold entries. Such holds do not terminate the service or fabricate readiness.
The owner's stop is the durable entry pause; existing protection and supported
exit supervision continue until exposure is resolved. Master-off is appropriate
only after fresh flat/no-working-order proof or an explicitly coordinated stop.

The 20-instrument question is a capacity assessment, not launch scope. Current
SessionNativeRefresh explicitly supports two instruments. Do not remove that
guard or replace native closed bars with tick-derived approximations to claim
20-instrument support. Preserve the existing differential history acquisition.

## Repository and operational boundaries

Work directly on main; no branch or PR. Preserve every pre-existing ES/backtest
change and `apps/signal-engine/src/signal-engine.ts`. No blanket staging. Runtime
stays on the pinned disabled-write release while code is developed and tested.
Operational DB is never used by destructive fixtures. Secrets/account identifiers
stay in private files/.env; examples and committed receipts use fixture identities.
No broker/provider requests during implementation tests. Authorized real provider
work belongs to the separately evidenced deployment, within actual entitlement
and the approved USD5 model budget; no subscriptions or paid upgrades are bought.

## A. Versioned recurring Paper authority

Add strict v3 `recurring_sessions`, preserving v1/v2 parsing, canonical bytes,
hashes, one/two-attempt rules and historical evidence. V3 requires:

- exact run/account/effective-configuration identity and Warsaw account day;
- explicit instrument/conId scope, restricted at launch to the two verified stocks;
- explicit JSON null for both daily attempt quotas, accepted only in v3;
- effective account date and a finite initial adoption deadline; active authority
  has no scheduled expiry and is not regenerated at midnight;
- explicit finite existing currency risk caps and session exit margin (15–60min).

The shared configuration adds an explicit recurring entry policy with null quota.
Allow account `maxOpenPositions:2` only when all participating enabled entry
policies use this new mode; legacy policies keep their existing maximum one.
Per-instrument maximum remains one owned one-share position. The launch uses
max2 total only to permit the two independently protected instruments.

Use broker session evidence and database time to resolve each concrete entry
interval. Do not substitute weekdays, fixed UTC hours or predicted sessions.
Persist immutable session identity/generation/hash, date, start/end and entry
cutoff with each proposal. Admission and dispatch revalidate the current calendar,
authority, pause, account, risk and ownership. Changed calendar can tighten an
existing bound proposal, never extend its original permission.

An additive migration makes binding checks version-aware: keep the <=60min
constraint for v1/v2; v3 requires genuine session evidence and cutoff. SQL accepts
unlimited quotas only for a fully validated, explicitly adopted v3 manifest with
present JSON-null keys. Missing/malformed caps, unadopted authority and old writers
raise; SQL null must not accidentally bypass other checks.

Keep every immutable attempt, trigger fence, legacy debt and unresolved hold.
V3 skips only numeric daily quota comparisons. Each dispatch still requires its
own exact durable reservation. Restart/config/run changes never create a retry
for unknown submission, erase audit, revive old proposals or clear operator pause.

Use existing schedule/adopt routes with exact prior/target hashes, UUID replay,
CAS/revision and account lock. V3 alone may be scheduled and adopted the same
database account day within its adoption deadline; retain future-day-only v2
behavior. Both startup and durable pauses, master writes disabled, current flat
broker/account/reconciliation state, healthy observer and alert path are required.
Adoption never resumes entries. Existing durable pause is sufficient for owner
stop; no new revoke endpoint is in this package.

### Coexisting positions

Retain serialized account admission and existing close serialization. Another
contract's position may coexist only with fresh complete broker reconciliation,
exact supported ownership, quantity one, confirmed protection and a healthy
pinned lifecycle. Same-contract exposure or active intent blocks another entry.
Unknown/unattributed outcomes, protection gaps, active close/uncertain transition,
unresolved reconciliation and migration holds remain account-wide blockers.
Do not achieve this by merely adding a conId filter to unresolved ownership SQL.
Risk/account exposure/cash/daily loss remain account-wide and are checked anew.

### Repeated cycles and historical ownership

Unlimited attempts must support repeated completed cycles on the same conId,
not only remove counters. Partition lifecycle execution/order evidence by exact
durable proposal, broker order/permId and execution identities. A later valid
cycle's fills/protection must not be attributed to, or invalidate, an earlier
completed cycle merely because both share a conId.

Validate a completed cycle using its immutable accepted terminal proof and stable
evidence fingerprint, preserving original links and execution membership. Recheck
for contradictions against current durable/broker evidence: old-link late fills,
changed commissions/economic evidence, inconsistent quantities, missing or
ambiguous ownership, and unknown same-conId orders/executions still produce holds.
Never ignore terminal rows wholesale or silently discard executions outside the
current cycle. Current complete account reconciliation and exposure classification
remain required before new admission. Worker A owns this critical ownership and
evidence change, including current close and historical round-trip collectors.

## B. Automatic research repair before admission

Reuse current periodic acquisition, adapters, provider budgets, locks, slot keys,
WSH ledger/pacing and immutable model/broker markers. Implement a durable
instrument/source/role repair request keyed by account/config/manifest identity.
Keep request/outcome history and scheduled retry eligibility separate from source
freshness. The queue itself never grants entry permission.

Before persisting a natural selected-signal proposal, inspect current research.
An authenticated internal prepare operation enqueues or joins only identifiable,
permitted repairs. READY continues the normal proposal path. WAITING returns a
clear instrument-level diagnostic without account reservation or AI call. HOLD
names the non-repairable condition. Next regular evaluation recomputes strategy,
prices, session and risk after repair; never replay a saved obsolete signal.

Add a targeted wake to the existing refresh scheduler for the requested roles,
using the same instrument lock, durable provider identities/reservations and
completed-slot records as periodic acquisition. Demand does not manufacture a
new slot, repeat unknown calls, reset a budget or bypass WSH rolling pacing.
When an operation is already running or the next legal slot is required, wait
durably and expose why. Isolate ordinary per-instrument failures so PKO research
does not starve AAPL. Global authority/DB failures still deny admission.

Use structured source inspection, distinguishing stale timestamps from unsafe
future timestamps; do not infer repairability from an error-string prefix alone.

| Classification | Required behavior |
| --- | --- |
| Missing snapshot/coverage or expired checkedAt; known adapter/mapping, valid rights/qualification and budget | Enqueue/join exact permitted source repair; wait and reevaluate |
| Lock busy, eligible acquisition running, next legal slot | Wait until the existing acquisition/slot is observable; no alternate call identity |
| Expired/missing rights or qualification, invalid identity, unsupported/outdated mapping, corrupt/future/conflicting facts, exhausted budget, unknown provider result | Explicit affected-instrument hold; no fabricated evidence or silent terminal AI rejection |
| Successful fetch still missing mandatory content | Content/mapping hold, not an endless fetch loop |

Cover the race after proposal persistence with durable bounded pre-binding wait:
release the claim without AI REJECT solely for repairable absence/staleness and
exclude sleeping claims until a due time/new snapshot. Keep the original immutable
120-second proposal expiry and 30-second claim semantics; do not block a DB
transaction across provider IO. Reclaim only with no binding, model reservation,
decision, delivery marker or execution attempt; revalidate identity, config,
session, controls and validity before binding and requesting fresh order context.
An expired proposal remains expired; repair may benefit future natural signals.
Existing immutable bindings are never replaced. A bound/superseded snapshot or
unknown model/delivery result retains current denial/hold rules and never triggers
a second model call. A brief post-admission wait still reserves the account;
per-instrument independence is primarily established before proposal admission.

Qualification/entitlement expiry and new financial-report mappings are not data
cache misses. Existing immutable source configuration cannot be renewed by adding
time to old claims. Deployment must qualify genuine current sources for the new
operating scope; unsupported future renewal or report rollover remains an explicit
instrument hold while the service/other eligible instrument continue. Do not claim
this package discovers arbitrary future PDF layouts or proves future entitlement.

### Accepted capacity adaptation: Marketaux on demand

Independent plan reviewer `continuous_plan_review` accepted this bounded addition
after the source-capacity audit: a 100-request daily allocation cannot sustain
96 slots/day × two completeness passes × two issuers (at least384 calls/day).
The lead asked the owner an optional preference and, after allowing time to reply,
stated the conservative launch assumption: demand-driven news, no new charges.
Any later owner selection overrides that launch assumption.

Add strict `RESEARCH_MARKETAUX_ON_DEMAND=true|false`, default false. True skips
only periodic `marketaux-news`; reports and WSH cadence remain. Targeted repair
still uses existing slots, locks, pacing, complete pagination and account/provider
budget reservations. Configured strategy evaluation already precedes preparation;
no signal and no pending repair causes zero Marketaux requests. A queued repair
may finish after its original signal disappears; later entry still requires a
new natural evaluation. Successful READY requests do not automatically rearm
merely because their data age. Restart does not create new call identities.

Initial disabled deployment may run one ordinary full refresh through the existing
helper/default periodic option, sharing durable slots and the same provider ledger.
Count actual pagination and non-ledger qualification usage; free quota can still
be exhausted and then produces HOLD. No freshness/completeness/AI guard is relaxed.
Tests cover default behavior, no demand, repair completion without rearming,
restart, concurrent periodic/repair work, exhausted budgets and unknown calls.
Final independent implementation review includes this addition.

## C. Continuous data-service startup/recovery

Reuse ingestion bootstrap as an internal operation shared with its existing
authenticated route. Add an explicit opt-in automatic startup/reconnect controller
for the continuous launch, default disabled for existing deployments. Single
flight only, no loopback HTTP self-calls, bounded retry/backoff, existing history
pacing and broker identity checks. Manual stop inhibits automatic restart until
explicit resume/start; shutdown drains/stops timers and does not recreate work.
Section C clarification independently accepted by the plan reviewer: retain manual
stop in a singleton ingestion control row initialized under the existing DDL lock.
Serialize manual start/stop; read/write failure inhibits work. Shutdown does not
persist a manual stop. Generation checks prevent late bootstrap subscription after
stop, shutdown or connection invalidation. Retry begins at 30 seconds, doubles to
a five-minute ceiling, checked every five seconds. Test persistence failure,
concurrent controls, stop during bootstrap and restart/recovery explicitly.

Preserve existing native candle/session finality checks and the two-instrument
capacity. On restart, inspect retained history, fetch only missing/obsolete
timeframes and maintain current-session minute readiness. Never delete history or
download an entire universe on every signal. Do not attempt broker UI login.

## D. Deployment and acceptance

After independent implementation review and the required release checks, publish
only the reviewed package on main, verify exact-commit CI and build a clean pinned
Docker release without unrelated dirty work. Back up the operational DB/private
configuration before the additive migrations and disabled-write rollout.

Prepare a private combined PKO/AAPL bundle and genuine source manifests. Set the
approved USD5/day model budget globally, using the existing UTC budget day (the
trading/account day remains Warsaw). Provider reservations retain conservative
cost accounting; no per-proposal budget reset. Use existing provider plans and
their real shared daily quotas; report inadequate feed capacity rather than
buying/assuming more. Keep both source and model costs auditable. Enable restart
behavior, ingestion auto bootstrap, periodic/targeted research, configured signal
scheduler and lifecycle supervision only after each layer's checks pass.

V3 adoption and explicit entry resume follow current verified Paper account,
matching peer configuration, complete clean reconciliation/account-day accounting,
fresh quote/grid/identity/session and healthy observer/alert checks. The owner's
current request and explicit limits authorize activation after these pass; do not
ask the same approval again. Observe initial operation; leave the authorized
continuous services running rather than imposing a new short window. Track actual
entry/exit evidence separately; lack of a natural signal does not stop the bot or
justify strategy changes. An unsupported external capability remains a precisely
reported blocker, never bypassed to call the launch complete.

Existing accounting qualification and provider evidence have real validity
requirements. No expiry is silently extended. Approaching/actual unavailable
evidence must be visible, with safe affected-scope holds and repair where supported.

## Acceptance and failure cases

- v1/v2 canonical hashes, quota behavior, date restrictions and evidence preserved;
  missing/malformed v3 null caps rejected; recurring authority survives restart.
- Repeated completed same-day cycles are allowed in v3 without quota; exact
  reservation/trigger/unknown fences remain enforced at SQL and application layers.
- Same-conId cycle1 closed/accounted -> cycle2 open/protected -> cycle2 closed ->
  cycle3 admitted, retaining correct evidence for all cycles. Changed historical
  commissions, old-link late fills and unknown same-conId executions/orders still
  hold entries; unrelated exact known-cycle membership never becomes foreign data.
- Verified sessions across weekends, holidays, early close, New York/Warsaw DST,
  day rollover and calendar changes; no new artificial one-hour stop.
- Two independently protected one-share PKO/AAPL positions; same-contract/third
  position denied; cross-contract unknown/protection/closing faults block safely.
- Same-day v3 adoption races/replays/revisions and pause versus dispatch; no
  automatic resume, old authority fallback or counter/history reset.
- Missing PKO research permits AAPL evaluation; repaired data leads only to a new
  current natural evaluation; no model before eligibility and one model reservation.
- Demand/periodic races, duplicate workers/restart, commit uncertainty and unknown
  provider calls cannot duplicate paid requests or overrun shared daily budgets.
- Proposal expiry/session close/pause/config change while waiting; bound research
  supersession before/during/after AI; no stale execution or rebinding.
- Fresh history skips downloads; missing timeframe alone fetched; disconnect and
  manual stop races preserve single-flight/pacing; capacity remains truthful.
- Production-wired isolated scheduler -> proposal -> repair/AI -> risk -> bracket
  -> lifecycle close/flat evidence for GPW and US fixtures; current real-source
  evidence is reported independently from fixtures.
- Polish terminal diagnostics identify waiting for source, permissions/mapping
  holds, outside session, no signal, operator pause and USD5 AI-budget exhaustion.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` with isolated
PostgreSQL, and `pnpm build`. Keep tests away from the operational database. Run
targeted meaningful tests during implementation; full suites once integrated,
rerunning only for changes/failures. No strategy/simulator behavior change is
planned, so existing regression fixtures suffice unless actual scope changes.
Deployment wiring requires a clean Docker build and final disabled/live-readiness
verification. Write report, scoped commit/push and exact-source GitHub CI evidence.

## Assignment and review boundaries

All critical work uses Astra/high. Lead supplies exact acceptance plus source
access; independent plan and final reviewers are different agents and never
implement the change under review. Requested/actual model, effort, repairs,
elapsed time and available tokens are recorded; unavailable telemetry stays so.

- Worker A: shared trading policy types/parser; execution v3 policy, authority,
  budgets/ownership/session/round-trip and migration000030; associated tests.
- Worker B: shared instrument-research inspection/repair, llm acquisition/wait,
  separate execution research prepare route, signal pre-admission integration and
  migration000031; associated tests. Do not edit execution index/repository shared
  with A; return exact wiring to lead. No edits to dirty signal-engine.ts.
- Lead: ingestion auto startup/recovery, compose/default-off controls, integration
  of route/dependency wiring after worker interfaces are fixed, documentation,
  release checks and separately evidenced authorized rollout.
- Independent plan reviewer: this entire critical package before any source edit.
- Different final reviewer: full integrated diff/hostile tests and exact scope.

Workers stop/escalate on changed critical contracts, required file overlap,
unknown external outcomes, unsupported source semantics or inability to preserve
legacy behavior. No worker may deploy, call paid providers, alter operational DB,
publish, loosen tests or expand scope without lead direction.
