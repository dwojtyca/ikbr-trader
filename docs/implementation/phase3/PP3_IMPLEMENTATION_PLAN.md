# PP3 — Generic bounded Paper stock execution

Date: 2026-09-28. Status: accepted by independent Astra/high plan review after one P1 daily-loss
evidence clarification; reviewer authored no implementation.
Baseline: `fab78cab89dacdd286f7d9029056354e109c53f2`, main.
Dependencies: [ROADMAP](../ROADMAP.md), [delivery §7](PAPER_PRODUCTION_DELIVERY_PLAN.md#7-pp3--generic-bounded-stock-execution-and-evidence),
[PP1 contract](PP1_CONFIGURATION_CONTRACT.md), [PP1 report](PP1_IMPLEMENTATION_REPORT.md),
[PP2 contract](PP2_RUNTIME_CONTRACT.md), [PP2 report](PP2_IMPLEMENTATION_REPORT.md),
[routing](MODEL_ROUTING_GUIDE.md). This plan is the normative PP3 refinement.

## 1. Scope and baseline audit

PP1/PP2 source and reports are present. PP1 immutable configuration/management
snapshots and PP2 original attribution, trigger fences, state and conversion guards
remain authoritative. Published source CI is recorded in their reports. Recheck
baseline GitHub state during mechanical verification. Preserve the 25 unrelated
dirty files captured by SHA-256 in `/private/tmp/pp3-delivery/baseline.json`;
particularly ES diagnostics, simulator and legacy signal-engine changes.

Existing entry risk grants general USD handling without a listing capability,
while special AAPL caps and two independent GPW/AAPL window tables remain. The
round-trip collector selects USD via AAPL identity. Existing account locks,
proposal/AI ownership, close operations and session evidence provide the seams.
The installed execution socket package is `ib` ^0.2.8; metadata adapter is
`@stoqey/ib` 1.6.10. Reuse verified adapter APIs; no assumed new broker capability.

Implement PP3-A then dependent PP3-B. No PP4 research, PP5 background lifecycle,
new strategies, ETF/future/option support, provider calls, deployment, trading
activation or IBKR calls. All execution acceptance uses injected broker fixtures.
Keep Paper-only environment, authentication, master switch, AI and fresh risk gates.

## 2. Capability and evidence contract (A)

One common supported stock capability is validated from complete identity:

| Routing exchange | Primary exchange | Currency | Session timezone |
| --- | --- | --- | --- |
| WSE | WSE | PLN | Europe/Warsaw |
| SMART | NASDAQ, NYSE or AMEX | USD | America/New_York |

Require broker=ibkr, assetClass=stock, exact positive conId, symbol/local symbol/
trading class and binding identity. Currency alone cannot select the market.
Only quantity=1 whole share, LONG, BUY LMT/DAY, outsideRth=false, bracket stop and
TP, no fractional/partial/trailing/overnight semantics. Close remains the supported
one-share SELL LMT full-close operation using original ownership. Unsupported
shape rejects before provider/risk effects. Do not trust STK as proof of ETF support;
configured assetClass must be stock and unsupported declarations reject.

Broker metadata must match route, primary listing, conId, symbol, localSymbol,
tradingClass, currency and STK. Reuse the existing dedicated read-only metadata
socket and route-selected market-rule mapping; validate complete tick bands and
all submitted prices. No minTick-only fallback for new generic stock orders.
Metadata is account-bound and bounded by the existing freshness deadline (at most
60 seconds); session is current exact-identity broker schedule, checked under
existing session-generation guards; BBO is exact-identity real-time subscribed
bid/ask strictly younger than 10 seconds. Revalidate finite deadlines immediately
before send/close. No ticker-specific order planning or currency-derived venue.

Legacy retained management snapshots lacking primary listing must not be rewritten.
An explicit compatibility adapter retains only the previously supported original
unattributed ownership/close scope and checks all historically available fields plus
current broker evidence. It never grants a new attributed entry or fabricates listing
identity. Known conflicting primary listings always reject. Existing original exit
policy survives disabled/removed assignments.

PP1 schema/canonical version and historical hashes stay unchanged. Project the
configured execution policy into the binding used by the common execution path,
while admission still denies every bundle entry with `PP4_RESEARCH_UNAVAILABLE`.
Replace the obsolete PP3 diagnostic blocker; diagnostic strategy evaluation ignores
only the remaining fixed PP4 entry blocker, never drift/preparation/missing peers.
Actual proposal/AI/provider/dispatch entry barriers keep their existing hooks.

## 3. Generic run manifest and strict initial policy (A)

Introduce explicit `PAPER_RUN_POLICY_JSON`, parsed before broker activity. It is a
separate activation/run manifest, not part of PP1 bundle identity. Required fields:
`version:1`, `runId`, `accountId`, `effectiveConfigHash`,
`accountDayTimeZone:"Europe/Warsaw"`, `kind:"supervised_one_attempt"`,
`maxAttemptsPerAccountDay:1`, `maxAttemptsPerInstrumentDay:1`, and `windows` containing
unique instrumentId/conId plus ISO offset startsAt/endsAt, and `currencyCaps` for each
used currency containing positive finite maxNotional, maxStopRisk, feeReserve and
maxDailyLoss. No unknown fields/coercion/nonfinite values. IDs bounded; <=100 windows;
window >0 and <=60 minutes, one account date and one local session date, and entirely
inside verified RTH with a 15-minute exit margin. Production parsing rejects live,
foreign loaded hash, unconfigured identity, duplicate/overlapping per-instrument
windows and conflicting legacy window authority. Absence means no generic entry.

Run ID is audit identity, never a budget namespace. Persist exact normalized manifest
and original config hash with proposal binding. Reusing a run ID with different data
fails. Proposal creation checks window, account, hash, session and current budget;
reservation and final send repeat them using database time/current session evidence.
A failed/expired unattempted proposal does not consume a slot. Reservation consumes
before any broker write, even if the process crashes before send or acknowledgement.
Unknown/timeout never refunds, retries or clears the account reservation.

Risk uses named quote-currency caps, min(bundle maxEntryNotional, manifest maxNotional),
manifest stop-risk/fee reserve plus existing account percentage/exposure/funds checks.
USD valuation stays explicit; PLN requires fresh positive account PLN-to-USD evidence
and PLN cash with existing conservative FX buffer. USD requires USD cash. Daily loss
uses authoritative complete realized broker evidence in the quote currency; missing,
ambiguous or stale accounting fails closed, never FX-netted across currencies. Do not
infer daily-loss completeness from a sum of locally known fills. Initial production
remains denied by PP4 regardless of valid fixtures.

### 3.1 Daily-loss evidence refinement (independent review P1)

Use a dedicated `PaperDailyLossEvidence` contract, not account totals or a local
fill sum: accountId, execution sessionId, connectionGeneration, positionGeneration,
reconciliationRunId, accountDate, periodStart, coveredThrough, capturedAt,
sourceComplete, exact typed broker execution IDs and immutable matched commission
records. The period is [Europe/Warsaw midnight of accountDate, coveredThrough];
coveredThrough/capturedAt must be finite, not future, ordered, strictly younger
than 10 seconds and in the current account date. UTC-midnight coverage alone is
insufficient. A clean current reconciliation must certify independent execution
coverage beginning at or before periodStart and ending at coveredThrough, with
all required source/end markers, exact account/session/generations and exact
persisted snapshot coverage. Requested dates alone do not certify historical API
availability. Unproven historical coverage yields `paper_daily_loss_unavailable`.

Join every broker execution in the interval to exactly one persisted typed fill
and commission record, with identical account/conId/side/quantity/price/time/currency.
Reject unattributed local interval fills, duplicate/corrected identities, mismatched
sets, missing/sentinel realized P&L, absent/nonfinite fees, unknown or mixed commission
currency, or any observed fill/correction after evidence capture. For each currency
use the conservative loss debit `sum(max(0,-brokerRealizedPnl) + max(0,commission))`.
Gains and commission rebates do not replenish this safety budget. This deliberately
may overstate loss when a broker's reported realized value already includes fees;
it is a bounded loss guard, not the round-trip net-P&L report. Require debit strictly
less than maxDailyLoss (equality rejects) for every configured cap, with no FX netting.
An empty day has debit zero only when independent complete interval executions and
matching local interval records are both empty; do not infer zero from missing data.

The risk evidence stores the interval, source/generation IDs, exact accounting
fingerprint and debits. Under the existing account lock, reservation and final send
revalidate the same latest CLEAN run/generation, current day and unchanged fill/fee
fingerprint, and require no broker-fill observation after coveredThrough. Any change
requires a fresh risk assessment before reservation; after reservation, abort and
retain the consumed slot/hold without resending. Cap validation therefore cannot
race a commission correction or external execution silently. If current production
adapters cannot certify a full Warsaw day, return unavailable, keep entry denied
and state that operational blocker in the report; no speculative broker API expansion.
Fixtures provide explicit certified coverage through the same validator. Add tests
for partial coverage, Warsaw midnight/DST, missing/foreign fees, corrections and
fills between risk/reservation/send, equality at cap, and genuine empty coverage.

## 4. Durable budgets, migration and concurrency (A)

Add migration 000019, never edit released SQL. Generic run/proposal bindings and
immutable attempt ledger use account + broker + conId, with account date computed
from DB reservation time in fixed Europe/Warsaw. Instrument session date is separate
and derived from its verified calendar timezone. Counters do not use logical ID,
strategy revision, config hash or run ID. Timezone changes reject; no reset endpoint.

Backfill consumed gpw_windows/aapl_windows and existing attempted entry proposals
without double-counting the same proposal. Preserve original rows/reports and any
legacy charged date as an additional conservative budget obligation when it differs
from the normalized Warsaw date. Never silently choose between conflicting account,
contract or timestamp evidence: persist an immutable account-scoped blocking migration hold (global when the account is missing or contradictory). Missing identity
for an attempted entry also blocks rather than disappearing. Close proposals do not
consume an entry slot. Unknown outcomes count permanently.

Use existing account-first `snap:<account>` transaction lock, then instrument lock.
The same transaction binds immutable attempt identity, persists prepared broker links,
sets execution_attempted_at and commits before broker send. Database constraints/
triggers prevent ledger mutation/deletion and stale old writers bypassing the generic
account policy after adoption. Legacy compatibility inputs translate to the common
budget or are denied after generic adoption; they cannot open a separate budget.
A migration/rollback or new run cannot recover a used slot. Incomplete migration
blocks adoption. Keep proposal/hash/AI ownership and close schemas compatible.

One active bot intent/position is account-wide even with known external exposure.
Preserve account-wide reconciliation and risk for external/manual positions/orders;
instrument-scoped completion does not relax entry holds or identity. A filled entry
whose owned lifecycle is not proven terminal must block a second instrument even if
a status alone no longer says PROPOSED/SUBMITTED. Existing unknowns remain reserved
until supported reconciliation proves terminal state; never infer from local deletion.
For an unfilled attempt, active ownership may end only after the common evaluator
proves every prerequisite except the actual one-share round trip, plus independently
covered exact zero-fill terminal records for all three owned bracket legs, no fills
and no close operation. This does not declare a round trip complete or refund an
attempt. A later account date still requires its own valid window and all gates.

## 5. Scheduled-policy transition boundary

PP3 specifies and tests transition validation, but does not activate repeated entry.
`bounded_scheduled` requires at most 2 attempts/account/Warsaw day and 1 per stable
broker/conId/day, quantity1, one active account intent/position, no overnight,
finite per-currency notional/stop/daily-loss caps, exact code/config/manifest identity,
explicit owner-approved launch evidence and delivered PP5 lifecycle capability.
PP3 production rejects this kind with `PP5_LIFECYCLE_REQUIRED`; no environment flag
can claim PP5. The stricter one-attempt policy remains enforced in production.
A future reviewed transition must retain existing counts, cannot loosen a consumed
supervised day in place, and becomes effective only on a subsequent account day
while reconciled flat with no unresolved ownership/close/unknown reservations.
Rollback to stricter policy keeps all prior consumed attempts (even counts >1).

## 6. Generic lifecycle audit and PP3-B presentation

A owns evaluateRoundTrip and the repository evidence collector. Their immutable
read-only result includes original proposal/client hash, attribution/config identity,
account/instrument/conId, run/window/attempt identity and dates, AI decision, fresh
risk evidence, broker legs/reconciliation/close references, typed fills, currency,
commission completeness, gross/net P&L and explicit refusal reasons. COMPLETED
requires existing independent final flat position and no instrument working orders,
known account-wide identities/reconciliation, exactly one share entered/exited,
original consumed attempt, matching typed executions and timestamps. Missing fees
may leave lifecycle completed with accounting pending; net P&L stays unavailable.
Known other-contract exposure is disclosed separately. Unknown economics never
updates PP2 safety state or grants a new entry. Retain legacy report aliases as
read-only compatibility fields where required; no currency inference from ticker.

B receives the accepted evaluator return type and only formats a generic read-only
report/fixture presentation. It cannot derive COMPLETED/flat, rewrite reasons, make
broker/provider calls, consume/reset budget or clear holds. Display unknown/pending
fees/mixed-currency accounting faithfully and preserve audit identifiers. A integrates
it into the existing report route/collector; no new write endpoint or UI controls.

## 7. Work packets and dependency order

| Task | Requested model/effort | Permitted files/actions | Dependencies |
| --- | --- | --- | --- |
| Lead A integration | capable lead, A semantics | This plan/report, config/index/repository/submission wiring, admission diagnostic consumers, docs | independent plan acceptance |
| PP3-A capability/evidence | gpt-6-astra/high | shared capability/metadata/projection; execution risk/TWS/close/ownership/round-trip and associated tests | accepted §§2,3,6; coordinate index interfaces with lead |
| PP3-A budget | gpt-6-astra/high | new paper-run policy/budget modules, migration 19, focused unit/PG fixtures only | accepted §§3–5; lead wires repository |
| PP3-B formatter | gpt-6-luna/medium | new formatter + fixture tests only | accepted §6 and A evaluator type available |
| Plan review | gpt-6-astra/high | read-only independent review | this complete plan/source contracts |
| Hostile implementation review | different gpt-6-astra/high | read-only full scoped diff and failure evidence | integrated A+B |
| Mechanical | gpt-5.6-luna/low | exact commands, isolated candidate/checks; reviewed explicit-file commit/push/CI | lead freezes scope |

Workers read AGENTS/contracts/callers, edit only their disjoint ownership, and return
files/commands/results/model-effort/elapsed/tokens if exposed. Stop/escalate new
semantics, migration/identity/race surprises or scope changes. B has one focused
repair attempt, then escalates to Sol; critical problems to Astra. Reviewers author
no implementation. Report requested/actual routes, repairs and unavailable telemetry.

## 8. Acceptance and validation

- PKO and AAPL coexist in one configuration; each plus a third source-absent fixture
  stock traverses real common entry preparation/reservation/dispatch/close/report
  modules with injected broker, one-share bracket and original audit identity.
- Reject ETF/FUT, unsupported venue/currency, primary-route mismatch, quantity/shape,
  wrong grid, stale/missing metadata/BBO/calendar/account/FX/cash/config/AI evidence.
- Two simultaneous instruments account-wide: only one intent/attempt and broker
  dispatch. Attempted unknown or crash-after-reservation cannot resend after restart.
- DB/metadata/session failures and deadline expiry before send fail closed; broker
  ack loss leaves durable consumed attempt and reconciliation hold.
- Warsaw day boundaries and European/US DST mismatch weeks, early close and exact
  deadline edges; NY instrument date remains separate. Run/hash/revision/ID changes
  cannot reset same conId budgets. Rollback and rejected policy transition retain debt.
- Legacy consumed/attempted state migration, double-source deduplication, conflicting
  evidence holds, repeat migration/restart, old writer races and immutable ledger.
- Original disabled/removed-instrument close; external exposure, unowned/conflicting
  fills, active close, pending fees and unknown final state cannot fake completion.
- PP4 admission blocks actual claim/provider/dispatch despite valid generic config;
  unchanged master switch and Paper-only behavior. No operational tests.

Run focused unit and isolated PostgreSQL tests during development, then a clean
candidate exported from baseline overlaid only with PP3 files: `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration` with only TEST_POSTGRES_URL on
a disposable PostgreSQL 16, and `pnpm build`. Never use operational DB or frozen ES
fixtures. No strategy/simulator changes planned, so no new backtest run required;
if such changes become necessary update/review scope and run relevant backtests.
Manifest deployment plumbing requires a clean Docker build and synthetic Compose
validation without operational .env. Validate links, staged diff and original dirty
hashes. Write report, independent hostile/document acceptance, explicit-scope commit
and push main, verify GitHub CI for that exact commit. Do not call PP3 delivered
with failed/unverified checks. Rollback leaves entries paused and ownership/budgets
intact; do not deploy an incompatible old writer or delete safety records.
