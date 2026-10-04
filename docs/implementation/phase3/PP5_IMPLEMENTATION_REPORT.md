# PP5 — Automatic lifecycle supervision and durable alerts

Date: 2026-10-04. Status: PP5-A/B implemented, independently reviewed and published; all required
local checks and exact-source-commit CI passed. This status must not be read as broker acceptance.
Baseline: `4c94f737ecc041a9bb7f5929cbca707ac35f3393`, main.

Contract: [accepted plan](PP5_IMPLEMENTATION_PLAN.md),
[delivery specification](PAPER_PRODUCTION_DELIVERY_PLAN.md#9-pp5--automated-protection-exits-and-recovery),
[permission/recovery runbook](../../runbooks/PAPER_LIFECYCLE_SUPERVISION.md).

## Dependency verification and scope

PP1 configuration, PP2 attribution/runtime and PP3 stock capability, immutable
attempts, one-share reservation and close evidence remain the foundation. Their
reports record successful independent review/checks/CI. Baseline CI run
[37200063571](https://github.com/dwojtyca/ikbr-trader/actions/runs/37200063571)
was independently rechecked as successful for the exact baseline SHA.
PP4 source is implemented and published, but complete real-source research acceptance
remains blocked; its coverage/provider/model limitations are not resolved by PP5.

PP5-A adds automatic durable lifecycle supervision and explicit entry pause.
PP5-B implements the accepted fault/outbox/acknowledgement contract using existing
Telegram transport. No strategy/simulator change, PP6 UI, PP7 repeated-entry policy,
deployment, trading activation, real IBKR operation or real notification is included.
The 25 pre-existing dirty paths are excluded from the publication candidate and
checked against their original SHA256 inventory.

## Delivered behavior

The observer runs every5s with nonoverlapping work and a database account lease.
It discovers attempted ownership and close operations, uses retained original
configuration, refreshes broker evidence and observes protection/close/flat state
without manual HTTP polling. A separate watchdog denies entry and reports stale
or stalled work within15s even when the main cycle is blocked. Shutdown drains work
before disconnecting; it never cancels broker protection as a shutdown side effect.

Protection requires exact original TP LMT and SL STP, whole quantity1, parent/OCA2,
DAY validity and original prices, with matching stock type/currency and owned fills.
Fractional/mismatched/foreign evidence cannot appear healthy. Broker-flat proof is
independent of local rows. Immutable terminal proof fingerprints detect corrections
or old working identities while allowing later legitimate ownership. Missing fees
remain accounting-pending until their evidence arrives.

Migration22 stores the immutable original calendar identity and session policy
atomically with the entry attempt. The default margin is15min, configurable15..60.
Early closes and DST follow verified broker UTC sessions. Final dispatch revalidates
the current exact calendar in the same transaction; an earlier close tightens the
pinned deadline, never postpones it. Missing/stale/conflicting history rejects entry.
Entry-window expiry is not a position close. Older ownership requires explicit
writes-disabled adoption of a new recovery policy; unavailable history stays HOLD.

At deadline, enabled automation pins one durable request and obtains a validated
current bid before using the existing full-close service and deterministic close
risk. There is no new entry AI approval. Fresh broker quantity must be exactly one
before SELL; protective fills winning a race suppress it. An unfilled parent may
complete cancel-only with positive terminal proof for all three original legs and
no close submission. Request/attempt markers survive restart and are never replayed.
A crash between automatic intent and operation creation remains a visible hold.

Rejected, working/unfilled or unknown close after protective cancellation retains
its reservation and escalates. Unknown cancellation/submission is never retried;
timeout never proves cancellation. PP5 deliberately uses the specification's durable
HOLD plus critical-alert fallback. Automatic replacement/reprotection and arbitrary
quantity recovery remain unsupported. Further writes require a supported audited
recovery or separately authorized owner-operated broker intervention and fresh proof.

Migration24 adds durable account pause and immutable pause/resume history. First
adoption requires master writes off and starts paused. `EXECUTION_ENTRIES_PAUSED`
defaults true; setting it false never clears durable pause. `TRADING_ENABLED` retains
its existing meaning: full close still needs master=true. Authenticated/account-
guarded pause and observation-only close reconciliation are explicit exemptions.
Resume checks current configuration/research authority, broker reconciliation,
observer, alert acknowledgement and bounded freshness. It cannot reset attempts,
clear close uncertainty or bypass risk. Pause and final entry dispatch share the
account lock; all final permits expire at their earliest evidence deadline.

Migration23 joins each stable account/ownership/fault episode atomically to one
outbox delivery. Repeated observations deduplicate; proven resolution followed by
recurrence creates a new episode. Delivery state and attempts are available through
`GET /execution/lifecycle/supervision`; acknowledgement does not resolve faults.
Transport uses strict Telegram `ok:true` and a positive message ID, with5s request
bounds, at most3 charged attempts and5s/15s backoff. Ambiguous notifications can
repeat; this does not permit broker retries. Account/process-scoped claims and lease
tokens fence stale workers. Each new process requires its own confirmed transport
probe and fresh heartbeat. Credentials alone are UNVERIFIED. Pending/failed/unknown/
disabled/exhausted critical delivery denies unattended entry, while management
permissions remain independent. With storage/transport available, delivery status
is exposed within60s. Database outage uses local critical status and denies audited
writes until storage recovers; it cannot promise persistence during the outage.

## Review and regression evidence

The independent Astra/high plan reviewer accepted after one amendment/re-review
round. A different Astra/high implementation reviewer authored none of the source.
Initial hostile findings and follow-up repairs covered alert-heartbeat expiry,
account/process delivery scoping, fractional/typed ownership, denormalized fill
attribution, masked close uncertainty, terminal-proof read races and pending fees.
The final dispatch-calendar tightening was also found during implementer review and
received a real PostgreSQL regression. Final frozen-source/document review accepted
with no unresolved findings. The subsequent migration-list fixture correction was
independently accepted; no runtime change was required.

Focused evidence before full validation: observer/service/regressions121 pass,
full-close PostgreSQL57 pass, final combined observer/store/service PostgreSQL6
pass. The independent reviewer separately ran35 focused tests and68 PostgreSQL
cases before the last calendar regression; all passed. These are overlapping
focused suites, not additive totals.

Regression coverage uses injected IBKR/transport and disposable PostgreSQL:
automatic owned-share exit through the actual service/store, cancel-only pending
entry, TP/SL races, cancel/submission acknowledgement loss, rejected/unfilled close,
reconnect identity, concurrent observer/manual work, durable markers across restart,
stale/failed calendars, DST/early close, pause/send races, database faults, economic
correction races, outbox lease expiry, notification ambiguity and renewed episodes.
No test sends to real recipients or submits a broker order.

## Required validation and publication

Final candidate is an export of baseline plus only PP5 paths. It excludes all
unrelated local ES/backtest/signal changes and actual `.env`. Commands use the locked
pnpm9.5.0. Integration databases run in dedicated `pp5-postgres`, PostgreSQL16 on the
separate `colima-pp1-verification` daemon, host port55445. Integration runs in the
built image on that container's network to share the VM clock. Operational databases
and existing broker stacks are not touched.

| Check | Result |
| --- | --- |
| `pnpm lint` | PASS, exit0; two unchanged unused-disable warnings |
| `pnpm typecheck` | PASS, exit0, all workspace projects |
| `pnpm test` | PASS, exit0: 2,929 tests, 2,823 pass, 106 PostgreSQL-dependent skips, 0 failures |
| `pnpm test:integration` | PASS, exit0: 2,329 pass, 0 skips/failures; final image, isolated PostgreSQL |
| `pnpm build` | PASS, exit0, all workspace projects |
| Clean Docker `--no-cache` build | PASS, exit0; final image `sha256:9fbf3eee5b4f281b1c7b1228f75880eb203494d9271ba70ff957437169ae2b5a` |
| Independent final source/document review | Accepted; no unresolved findings |
| Local links, scoped diff, original dirty hashes | PASS; all25 original paths preserved |
| Scoped main publication and exact-SHA GitHub CI | PASS; source `6986ae23eac798bd9ed18773f47ffecbc78027f5`, run 37205293268 |

No strategy/simulator behavior changed, so additional strategy backtests are not
applicable; existing repository backtest tests still run in the required suites.
Initial setup encountered sandbox network restrictions and used approved access
to install locked dependencies and operate the isolated Docker daemon. The first
unit run stalled in the pre-existing local-server fixture because sandbox binding
returned EPERM; it was stopped (exit143), then passed unchanged with local socket
access. It is not counted as a pass.

The first integration run found one historical fixture list ending at migration21;
PP5 correctly applies22–24. The explicit expected list was extended without changing
legacy proposal/AI/ownership/budget preservation assertions. Targeted four migration
tests and independent re-review passed. The rebuilt final image then passed the
complete integration suite. No runtime safety assertion was weakened.

The46-path candidate passed lint/typecheck/unit/build; the only later code change
was that migration-list test, rechecked with scoped lint, targeted PostgreSQL, the
clean rebuilt image and full integration. Unit rerun took50.6s, build5.5s, final
Docker build17.6s and integration88.8s. Documentation receipt updates do not change
that verified runtime.

Source commit: [`6986ae23eac798bd9ed18773f47ffecbc78027f5`](https://github.com/dwojtyca/ikbr-trader/commit/6986ae23eac798bd9ed18773f47ffecbc78027f5), pushed to `main`.
Exact-source-commit [GitHub CI run 37205293268](https://github.com/dwojtyca/ikbr-trader/actions/runs/37205293268)
completed **success** at 2026-10-04T13:27:22Z. The observed `head_sha` matches the
source commit exactly. This documentation-only receipt records that result; its
own commit is also verified in CI before final delivery. The 25 unrelated dirty
paths remained byte-for-byte unchanged after publication. The dedicated PP5
PostgreSQL container was stopped, with other stacks untouched. No operational
service was started and no broker/provider message was sent.

## Model routing and remaining operational limits

| Work | Requested | Dispatched / repairs |
| --- | --- | --- |
| Critical lead integration and PP5-A | gpt-6-astra/high | Capable lead; lifecycle worker gpt-6-astra/high. Hostile repairs retained critical semantics; one final calendar-tightening follow-up. |
| PP5-B ledger/transport wiring | gpt-6-sol/medium | gpt-6-sol/medium. Two bounded follow-ups under the lead's critical contract: transport deadline/ack classification, then account/process-scoped claims. Critical admission semantics stayed with A. |
| Independent plan review | gpt-6-astra/high | gpt-6-astra/high; one amendment/re-review round |
| Independent implementation review | gpt-6-astra/high | Different gpt-6-astra/high agent; initial hostile review, two re-review rounds, final acceptance and a narrow migration-fixture recheck |
| Mechanical checks/publication | gpt-5.6-luna/low | Requested model unavailable in available agent routes; disclosed fallback gpt-6-luna/low, plus lead for scoped publication |

Requested/dispatched routes are known. Backend actual-model telemetry, per-agent
token usage and per-agent elapsed time are unavailable, not zero. Approximately69 minutes elapsed
from baseline inventory through final local validation. No efficiency percentage
or model-quality guarantee is claimed. No broker or paid-provider retries occurred.

Source validation does not establish current IBKR quote/calendar/account coverage,
PP4 real research eligibility or successful Paper fills. Defaults keep entries
paused and automatic lifecycle writes disabled. PP6 and PP7 remain unimplemented;
this package does not start either stage or authorize activation.
