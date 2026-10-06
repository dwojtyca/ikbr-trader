# Production-style Paper acceptance and operations

Status: **operational acceptance remains blocked; PP7 source verification is tracked separately**.
Updated 2026-10-06 for [PP7 implementation prerequisites](../implementation/phase3/PP7_IMPLEMENTATION_PLAN.md).
Reuses [PP0–PP6](../implementation/phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md)
and additionally requires PP7-D/E/F before Gate A/B and PP7-G before scheduled
Gate C activation. Current usable narrow procedures remain
[PKO](GPW_PAPER_ROUND_TRIP.md) and [AAPL](AAPL_PAPER_ROUND_TRIP.md); neither proves
unattended production-style readiness. No invented API routes/env commands appear here.
Custom UI is deferred: launch and acceptance must work with `apps/ui` stopped.
The owner uses IBKR desktop for broker inspection/manual operations; bot diagnostics
come from the delivered [PP6 terminal operations](PAPER_HEADLESS_OPERATIONS.md)
and existing alerts. Full operational acceptance remains planned: the configured
scheduler-to-proposal handoff, required real research/account-day evidence and
bounded scheduled policy are PP7 responsibilities; source delivery does not pass the operational gates.

## Implementation prerequisites

- PP7-D connects the production bundle scheduler and selected strategy to persisted
  proposal/AI/risk/dispatch, retaining identity, price evidence, admission and durable
  deduplication. PP7 supplies this handoff; see its implementation report for validation status.
- PP7-E completes real mandatory research for PKO and AAPL plus model readiness;
  PP7-F establishes verified full account-day execution/fee coverage. Missing feeds,
  permissions, credentials or broker capability remain explicit entry blockers.
- PP7-G implements versioned bounded scheduling and durable budget transition for
  Gate C. Gate B retains one attempt/account/day and existing supervised windows.
- Require isolated integrated success/failure tests, independent hostile review,
  required repository checks and exact-commit CI. No seeded approved proposal or
  fabricated coverage is evidence of the normal automated entry path.

Record code delivery separately from actual gate status. The implementation prompt
does not authorize broker trades, paid calls, operational deployment or real alerts.
Reuse applicable recorded owner permission; otherwise obtain the concrete bounded
launch/provider authorization after preparing the tested release and manifest.

## Launch manifest

Record exact code SHA/image digest, migrations, schema/effective configuration hash,
Paper environment, verified allowlisted account (private record only), both contract
identities, strategy instance/revision/parameters, research policy/snapshot/provider
coverage, sessions/timezones and operator responsibility. Include explicit authorized
start/end times, quantity, notional/stop/daily-loss/attempt limits and paid provider
request/cost ceiling. Never commit account identifiers, tokens or financial balances.

GateB starts with one whole-share attempt/account/day. GateC permits at most two
attempts/account/day, one per instrument/day, with one active account-wide bot intent,
after that policy is implemented/reviewed/authorized. Initial account-day timezone
is Europe/Warsaw; instrument session dates remain exchange-local. Values cannot be
reset by changing run ID, config revision or process restart.

## Disabled preflight

- Confirm actual account/environment; port number is not identity.
- Require matching config hashes across ingestion/signal/execution/AI and compatible
  migrations. Fail on unknown instance references or unsupported capabilities.
- Verify broker-resolved listing, market rules, session coverage and real-time BBO
  for both configured instruments, at actual evaluation time.
- Inspect closed-bar readiness and research source/issuer/freshness coverage per
  instrument. Counts, /health or a disabled scheduler /ready alone are insufficient.
- Require fresh complete account/exposure/reconciliation evidence, no conflicting
  holds/ownership and finite currency-aware risk caps. Known unrelated external
  exposure is accounted for; it is neither silently managed nor simply ignored.
- Verify authenticated operator controls, supported entry pause, close/protection
  observer and alert delivery health. Check backup/recovery procedure.
- With UI stopped, verify readable log follow, current per-instrument status,
  decision timeline, session report and redacted export through the documented
  terminal operations. Include data freshness/coverage and explicit missing intervals.
- Provider/model diagnostics, if needed, run only inside the recorded authorized
  cost/request scope. A configured key is not coverage or availability evidence.

## Headless operator evidence

Follow the [PP6 diagnostic contract](../implementation/phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md#10-pp6--headless-diagnostics-deployment-and-recovery).
The [runbook delivered by PP6](PAPER_HEADLESS_OPERATIONS.md) gives short executable
steps for readable log follow, instrument/reason/time filters, one-decision source/
lifecycle lookup and session summaries without bespoke SQL or mandatory jq. Machine JSON and readable
Polish output must agree, including stable IDs/codes, explicit timezone and safe
next actions. Source lookup reads stored evidence; it must not trigger provider calls.

Capture sanitized status/timeline/session evidence in the acceptance report with
exact code/config identities. Missing research, unknown broker state, accounting
pending, disabled entries and market closed are distinct. Repeated-state summaries
retain counts/time coverage; sampled console lines alone cannot prove that every
scheduled evaluation ran. An export with gaps/truncation stays visibly incomplete.
Log/alert availability is diagnostic evidence, never permission to resume or proof
that a broker position is flat. Use persisted audit plus fresh broker evidence.

## Supervised acceptance

After disabled Gate A passes and explicit bounded owner authorization is recorded,
enable only the supervised Gate B scope. Later Gate B/C broker results are not
preconditions for this first supervised run; collect them within that authorization.

Use the shipped authenticated bound runtime, never retired legacy signal routes.
A valid no-signal or AI REJECT remains pending acceptance. For each initial
instrument collect one real entry, broker protection, real exit and fresh final
instrument-flat/no-working-order evidence with original proposal/instance/config/
research/AI/risk identity, commissions and P&L completeness. Do not fabricate
signals or alter thresholds during the window. Preserve unknown attempts and budget.

## Automated observation

After GateB, PP7-G delivery and applicable explicit bounded authorization, run five
consecutive scheduled sessions per instrument under the unchanged launch manifest
and scheduled policy. The bot performs normal evaluation,
protection and exit observation; an operator monitors alerts rather than manually
polling close completion. Track every evaluation interval, reason for non-trading,
provider latency/cost, quote/history/research freshness, reconciliation lag,
protection, fills, costs and session-end state. See PP7 for exact reset/pass rules.

## Stop and incident handling

Pause new entries on stale/mismatched evidence, config drift, breached limits,
unknown dispatch/cancel state, protection gap or failed critical alert delivery.
Keep supported protection/reconciliation and risk-reducing exit management active.
Use the implemented PP5 [permission contract](PAPER_LIFECYCLE_SUPERVISION.md):
durable entry pause/startup ceiling differs from TRADING_ENABLED=false, which still
blocks full close. Pausing entries does not stop automatic exit management.

Never resubmit an unknown order with a new request ID. Never equate a timeout,
local row deletion or SUBMITTED response with cancellation/flat state. The broker
must establish remaining quantity and order outcomes before any bounded recovery
write. If the adapter cannot establish ownership or quantity, retain the hold and
escalate to the owner-operated IBKR procedure; no automated IBKR UI.

No-overnight policy needs an exit deadline before the actual broker close, including
early-close sessions. A limit order is not guaranteed to fill. Unresolved near-close
state is an incident, not permission for an ad hoc order bypassing risk/audit.

## Owner-operated IBKR changes

Before a planned manual change to bot-owned exposure, inspect active automatic
close operations and outstanding broker protection and follow a reviewed coordinated
takeover procedure. Entry pause alone cannot guarantee no competing exit; disabling
master writes does not undo already dispatched actions or cancel broker orders.
PP6 must state any unsupported takeover/recovery capability explicitly. This document
does not introduce a new safe-takeover switch or authorize an agent to operate IBKR UI.

After an external trade/cancel, require fresh broker positions, protective/close
orders, executions and supported ownership reconciliation before resumption. Manual
holdings are not silently adopted by a strategy. Wrong quantity, unmatched ownership,
unknown outcome or residual protection remains HOLD with clear reason/action in the
headless report. Do not delete rows, reset budgets or retry uncertain actions to clear
it. Manual incident recovery cannot substitute for a normal bot exit in PP7 evidence;
the existing incident/session invalidation rules still apply.

## Restart, shutdown and completion

A clean restart validates configuration, reconstructs durable ownership and compares
fresh broker state before admitting new entries. A database restore uses an isolated
verified backup procedure and requires reconciliation against broker events since
backup. Graceful shutdown pauses entries, records outstanding state and preserves
broker-side protection; it must not silently cancel it.

A successful acceptance report includes per-instrument session counts, real round
trips, fault-injection evidence labelled separately from broker observations,
restart results and exact image/config/CI identity. Any material fix/config change
restarts the soak count. Passing Paper acceptance does not enable Live.

## PP7 release preparation and scheduled policy controls

The [implementation contract](../implementation/phase3/PP7_DELIVERY_CONTRACT.md)
separates the internal selected-signal handoff from research, fresh risk and broker
permission. A configured evaluation remains read-only; production scheduler
submission additionally requires `EXECUTION_RUNTIME_ENABLED=true`, the loop
allowlist, current peer configuration and all execution guards. These settings
are not an authorization to operate. The checked-in instrument/strategy and
research examples remain disabled.

Copy the [disabled launch manifest template](../implementation/phase3/PP7_LAUNCH_MANIFEST.template.json)
to a private location for an exact release. Fill source SHA, image digest and CI
link from the reviewed build. Account, dates, amounts, model/cost scope and actual
evidence require verified operator input; `null` fields mean unresolved. Do not
pass this document to a run-policy parser or use it to enable trading. A private
completed manifest still needs the owner's bounded operational authorization.

The execution service exposes authenticated `GET /execution/paper-policy` and
`POST /execution/paper-policy/schedule`, `/cancel`, `/adopt`. A schedule request
names the exact registered target `manifestHash`, explicit `priorManifestHash`,
`expectedRevision`, UUID `requestId` and a reason. Cancel/adopt name the pending
manifest with a new request ID and current revision. These are policy controls;
they do not resume entries. Writes must be disabled and both startup and durable
entry pauses active. Scheduling and adoption require fresh broker/reconciliation,
flat bot ownership, observer and alert evidence. Missing evidence is a blocker.
Never retry an ambiguous control response under a new ID: inspect the policy audit
and use only the original request for an exact replay.

Scheduled policy v2 has finite dated windows (maximum 100, each at most 60 minutes),
`effectiveAccountDate` and `expiresAfterAccountDate`, account day Europe/Warsaw,
max2 attempts/account/day and max1/contract/day. Existing per-currency caps and
one-share bracket/no-overnight guards apply. Scheduling is for a subsequent account
day. Adoption during that finite date range repeats readiness; expiry never rolls
forward. A pending transition may be cancelled only before its effective day.
Active policy, consumed attempts and unknown outcomes survive restart. New run,
instance revision or configuration cannot replenish them. Actual broker calendars
and the configured exit margin may make a declared window ineligible on early-close
days. Existing positions retain their original exit deadlines.

Until the first authority transition, legacy v1 manifests keep their strict
one-attempt behavior. First scheduling explicitly chooses a registered prior v1
hash; historical manifest ordering never selects authority. After authority exists,
old writers cannot regain the compatibility path. Rollback must retain migration26
and the authority audit; do not restore an older database or delete counters to make
an older image admit entries. Gate C still requires Gate B evidence and separate
bounded operational authorization.
