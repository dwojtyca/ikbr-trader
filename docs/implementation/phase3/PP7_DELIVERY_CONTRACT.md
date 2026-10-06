# PP7 implementation contract and bounded delivery

2026-10-05. Accepted by independent Astra high reviewer after one authority-contract repair; implements the
[PP7 plan](PP7_IMPLEMENTATION_PLAN.md), without operational activation.

## Scope and starting evidence

Work on main; preserve pre-existing ES/backtest work and
`apps/signal-engine/src/signal-engine.ts`. No branch/PR, broker connection,
orders, real alerts, deployment or paid provider calls. Public source inspection
is read-only. Code delivery and Gates A/B/C/D have separate outcomes.

The configured scheduler currently only records evaluations. The shared generic
DecisionEngine has no directional strategy rule; merely forwarding attribution to
its existing `dryRun` would remain HOLD and is not a working handoff. PP2 already
supplies v2 canonical payload identity, trigger fences independent of config and
instance revision, snapshot attribution and safety-state inheritance. PP3/4/5
already supply proposal/review, risk reservation and lifecycle machinery. Reuse it.

## D: selected signal and proposal admission

The configured runtime continues to evaluate only assigned enabled instances,
using their factory parameters and existing closed-history/session context. Return
its actual selected signal, attribution, trusted evaluation-bucket trigger and
indicator evidence. Diagnostic evaluation remains incapable of submitting: report
`entryAllowed:false` and `RESEARCH_PER_PROPOSAL_REQUIRED` rather than claiming a
permanent unavailable provider. Proposal eligibility is separate from permission
to dispatch a broker order.

The scheduled configured cycle enforces its allowlist and execution runtime opt-in,
configuration/account/environment admission, reconciliation and exposure before
preparing a proposal. Existing per-instrument overlap and global concurrency cap
apply to configured work too. Disabled/no-signal/error never calls a model or
submitter. Diagnostic GET/dry-run/evaluation routes stay read-only. Entry pause,
account-wide active-intent, policy window and budget checks remain authoritative
on the execution service before persistence/review and again before dispatch.

Add an internal configured-signal preparation method to MarketDataRuntime, not a
public raw-ticket endpoint. It builds the real current price snapshot, validates
selected signal identity/direction/confidence/levels and adapts that signal to the
shared pipeline's SignalEngineLike contract. The directional decision comes from
the selected StrategySignal (confidence is its actual 0..1 value times 100); reuse
the existing deterministic default decision safety rules for blockers and the
existing shared RiskEngine rules for approval. Do not rerun another strategy or
invent a passing risk result. Shared TradingPipeline and ExecutionTicketBuilder
then create a ticket with the selected attribution/trigger. Preserve raw strategy
entry/SL/TP; WSE uses the existing verified price-grid normalizer and its evidence,
other supported stocks use the verified configured grid and conservative existing
normalization rules. Reject unsupported trailing/partial protection rather than
silently discarding it. Verify final prices equal the approved normalization.

ExecutionRuntime.executePrepared maps this ticket through the existing authenticated
HttpExecutionTicketSubmitter. Include actual confidence/reason/indicators and WSE
price evidence as appropriate. Compute existing v4 trigger key and canonical v2
payload hash; do not put config revision or payload prices into a new identity.
Server-side PP2 fences reject alternate instance/config/ID for an already handled
account/contract/direction/bucket. Persist terminal rejection and ambiguous holds.
No retry loop on timeout or unknown acknowledgement, no alternate key. Repeated
observations can only encounter the original durable intent. Research/AI are
mandatory and broker risk is freshly re-evaluated after the verdict.

Preserve evaluation attribution in the cycle outcome while linking returned
proposal ID into PP6 diagnostics. Actual skip/research/risk/unknown reasons must be
visible without exposing secrets. Retained position supervision is unchanged.

## E/F: genuine evidence, never positive declarations

Research adapters retain immutable documents, exact issuer/listing/period/currency
and mandatory financial/news/calendar groups. Verify public issuer sources for
both initial issuers. Tighten any discovered calendar coverage gap so past-only
or too-short coverage cannot assert upcoming-event readiness. Required future
coverage must include the intended holding horizon and reporting deadlines.
Do not invent empty complete news/calendar coverage from a page or arbitrary URL.
Keep examples disabled. Actual entitlement/retention and model availability remain
explicit Gate A blockers until authenticated probes are authorized and observed.

Installed broker clients and production collector must be checked, including the
existing separate completed-order source. `reqExecutionsEnd`, requested `from`,
process uptime and local rows do not prove a complete account day. Retain all
`paper_daily_loss_*` denials when genuine certified coverage cannot be obtained.
Only implement a collector extension if a supported source contract actually
certifies account-wide history/fees from Warsaw midnight through observation.
Otherwise report the exact missing capability and supported next extension,
with official evidence. This permitted external blocker does not stop D/G or tests.

## G: finite scheduled policy and durable adoption

Preserve v1 supervised manifest/hash behavior and its one-attempt account/day
limit. Add strict v2 bounded_scheduled contract: explicit finite dated UTC windows
(no implicit recurring authority), each <=60 minutes, max two attempts/account/
Warsaw-day, one per instrument/day, quantity one, one active account-wide intent,
finite existing per-currency loss/notional/stop caps, no overnight. Repeated conId
windows require distinct sessions/account days; overlap cannot create concurrency.
Session evidence must still come from current broker calendar including early close.

Policy transition/adoption is durable, append-only and only effective on a later
Warsaw account day. A new run ID/config hash/revision never resets allowances or
unknown attempts. Startup registration alone cannot certify flat state before
broker connection. Activation requires freshly reconciled flat state, no unresolved
reservation/ownership and current PP5 observer/alert readiness; preserve entry
pause until explicitly resumed. Scope exact adoption mechanism in the review
addendum before implementation. Preserve pinned exit policy for existing ownership.
Migration updates counter validation and reservation/dispatch SQL together; retains
all existing rows and disallows rollback to a policy that hides spent allowance.
Old binaries cannot silently operate the new mode; incompatible mode fails closed.

## Acceptance and validation

Start isolated integration through TradingLoopService.start and captured scheduler
timer, not runOnce/raw submitTicket. Use production strategy factories/context,
configured preparation, HTTP transport/route, ExecutionRepository/submission,
research review worker and lifecycle service with controlled external adapters and
a disposable PostgreSQL database. No pre-approved proposal seeding. Prove PKO,
AAPL and configuration-only third stock, independent parameter attribution, exact
strategy prices, pending AI then approval then fresh risk then one bracket then
observed automated exit/flat evidence. Fixtures prove mechanics, never real gates.

Cover no-signal/disabled/allowlist/pause, stale data/session/config/hash, rejected/
malformed/timeout/late AI, changed research/account, duplicate ticks/processes,
lost HTTP acknowledgement/restart/revision changes, DB/Redis/broker failures.
Cover two instruments' sequential allowance and concurrent reservation; account/
session day boundaries including DST; late fees/corrections and unsupported history
remain holds. Existing protection/close/alert/recovery hostile suites stay required.

Run lint, typecheck, unit tests, integration with isolated PostgreSQL and build.
No strategy formula/parameters or simulator change is intended: use existing
momentum regression/backtest fixtures; record any need for broader backtests.
Build relevant Docker images cleanly for changed production service wiring.
A different independent Astra high reviewer reviews integrated code and hostile
cases; fix until accepted. Publish only reviewed scope on main and verify GitHub
CI for the exact commit. Record commands, model/effort, review/repair counts,
elapsed time and unavailable token telemetry honestly.

## Release and gate evidence

Prepare a disabled launch manifest template with release SHA/hash references and
explicit unresolved private fields (account, dated windows, caps, provider/model
allowance, broker evidence, authorization). It must not be executable as an enabled
policy until completed and approved. Report implementation, Gate A blockers,
Gate B per-stock real round trips (zero without authorization), Gate C sessions
(zero without authorization) and Gate D fixture/restart evidence separately.

## Review addendum: exact E and G contracts

E: calendar acquisition `checkedAt`/publication stay <=now, independent of future
occurrence range. Add explicit `occurrenceWindowStart`/`occurrenceWindowEnd` to
calendar normalized evidence, require [now-24h, now+24h] coverage for the existing
24h event blackout and expire at occurrenceWindowEnd-24h as well as normal TTL.
Old immutable snapshots without range remain readable but ineligible; do not
rewrite hashes. Bump normalized calendar schema discriminator if necessary and
validate provider parsing against it. Future event time is allowed; future
publication/as-of is not. Reporting deadline expectations retain their verified
source rather than guessed dates. Unverified PKO XLSX mapping is not eligible
production research until independently validated against current official report.

G v2 exact extra fields: version=2, kind=bounded_scheduled, runId, accountId,
effectiveConfigHash, accountDayTimeZone=Europe/Warsaw, effectiveAccountDate,
expiresAfterAccountDate (inclusive), maxAttemptsPerAccountDay=2,
maxAttemptsPerInstrumentDay=1, windows and currencyCaps. At most100 explicit
windows; reject same-contract/session-date duplicates and overlaps; require window
within both explicit date bounds. Preserve <=60min and same Warsaw/local day per
window. Sort contract/start/end for new v2 hash; v1 bytes unchanged. Shared entry
policy accepts scheduled/max2 capability; v1 may remain the stricter runtime cap.

Add an append-only transition/audit table and per-account authority with monotonic
revision in an additive migration (never edit historical migrations). Startup
registers the manifest only. Authenticated disabled-write and paused control
schedules the exact hash for a strictly future database Warsaw day. On due-day
adoption, under the account lock, require current Paper identity/generation,
fresh CLEAN complete reconciliation, no unresolved entry/close reservations or
bot ownership, healthy PP5 observer and alert worker/transport and no critical
faults. Reuse PP5 checks by separating observation readiness from the master-write
permit. Adoption never resumes entry pause. Same request/hash is idempotent;
conflicting reuse denied. Original position exit policy stays pinned.

Admission/reservation/dispatch and SQL trigger derive cap from durable authority,
count attempts across run/config/revision changes and preserve legacy debt and
unknown holds. Count stable conId against both Warsaw and exchange day. A second
instrument slot needs authoritative completion of the first. Pin the particular
window when creating the proposal; use it on subsequent checks. Fresh actual RTH
must contain the window and configured exit margin (15–60min), including early
close. Reject stale unattempted proposal authority after transition. Rollback or
old writer cannot erase/hide debt or regain old authority. Lifecycle reports read
persisted policy kind/version instead of inventing supervised status.

### Authority bootstrap and transition contention (review repair 1)

Migration starts with no guessed active manifest. Accounts without any authority
row retain the existing v1-only supervised compatibility path with its stricter
immutable max1 SQL fence; v2 is always denied there. First authenticated scheduling
request must name an exact already registered v1 `priorManifestHash` and bind it as
prior authority while writes are disabled, entries paused and readiness passes.
This explicit selection is audited; never select MAX(run), latest config or infer
ownership from startup. Once an authority row exists, even v1 writers must match
its exact active hash; SQL prevents old binaries from falling back to compatibility.

One pending transition per account. Requests carry expectedRevision and UUID
requestId; account lock + CAS serialize different requests. An exact request replay
is idempotent; changed body/hash or stale revision conflicts. No silent supersession.
Cancellation is authenticated/disabled/paused, names the exact pending transition
and revision, appends an event and is allowed only before its effective day; no
counter/reservation deletion or refund. A replacement requires a new reviewed
future-day request after cancellation. Due-day adoption is valid only within
explicit effective/expiry dates and repeats fresh readiness; failed readiness keeps
pending HOLD and never restores permission automatically. Expired/missed authority
stays expired/blocked, retains prior/pending history and pause; no fallback to an
older window or automatic roll-forward. Scheduling/adoption never changes pause.


D wiring detail: the current generic snapshot only has a price provider. Keep the
existing BrokerAvailabilityRule and supply a brokerState provider backed by the
existing authenticated /ready and exposure readers. It returns a Paper/no-open-
orders section only after actual ready/whitelist/write-state and complete clear
instrument-exposure responses; missing/failed/contradictory responses leave the
section unavailable. No buying power or balance is fabricated. This is preliminary
admission evidence, never the final fresh account/financial risk assessment.
