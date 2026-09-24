# GPW3 — controlled PKO window preparation

Date: 2026-09-24. Plan ACCEPT (including native closed-bar freshness amendment).
Independent implementation review ACCEPT; all local gates passed.
Plan: [GPW3_CONTROLLED_WINDOW_PLAN.md](GPW3_CONTROLLED_WINDOW_PLAN.md).

## Implemented

The existing momentum strategy's entry/stop/target now reach the bound WSE ticket,
normalized using current broker bands before hashing and AI review. Raw/final
prices and metadata survive HTTP schema and atomic proposal persistence. The
execution layer still independently validates current metadata and exact prices.
A shared explicit Paper configuration opt-in creates the one-share PKO profile;
default registry, environment and running services remain unchanged.

PKO history uses provenance-tagged native IB bars, six supported timeframes and
closed-bar validation. Old aggregate rows do not count toward warmup. Native
refresh is serialized/paced and follows next-bar finality; WSE 12h is omitted
from both loader and regime input. WSE freshness uses conservative closed-bar end
with unchanged age ceilings. Other instruments retain existing behavior.

A configured window is immutable per run, bound to each proposal, limited to one
Warsaw date and <=60 minutes. PostgreSQL consumes one entry budget per account/day
in the exact plan/claim transaction. Restart, new run id, terminal/flat state and
unknown dispatch cannot replenish it. Window checks occur before proposal,
prepare, atomic claim and dispatch, including after broker reconnect. Exits are
not tied to the entry window. No automatic rearm or automatic flatten was added.

Read-only round-trip evidence combines a consistent DB snapshot, exact broker
ownership/fills, AI/risk, consumed window, fresh flat position and reconciliation.
It separates mechanics from accounting: missing/foreign fees keep net PLN null,
zero broker P&L remains zero, and execution currency defines position identity.
AI context explicitly labels missing fundamental/macro/trend sources and excludes
unverified PKO symbol-only news from instrument-matched research.

## Validation

- Separate independent plan and implementation reviews ACCEPT. Reviewer ran
  121 tests independently and verified the 31 production-service PG results.
- Targeted production-service/Postgres tests: 31 passed, including real clock
  expiry during prepare before atomic claim, post-claim refusal, concurrency,
  restart, unknown dispatch, rollback and durable strategy evidence.
- Evidence/route/Postgres tests: 33 passed; AI context tests included in 14 passed.
- Full local gates PASS: pnpm lint (0 errors, 3 pre-existing warnings), pnpm
  typecheck, pnpm test, pnpm test:integration, pnpm build. Unit suite: 1991 pass,
  one PG-only test skipped without DB; integration suite: 1059 execution +18
  backtest +7 AI repository tests pass, no skips. Existing real momentum strategy
  fixture exercises normalization, actual builder and mapper without tuning.
- All 29 unrelated dirty ES research files retain their baseline hashes.
- Commit/push and exact GitHub CI verification follow this report.
- Test adapters use deterministic open-session market evidence and a short DB
  wallclock window; no broker or paid provider calls occur in these fixtures.

## Operational boundary

[GPW runbook](../../runbooks/GPW_PAPER_ROUND_TRIP.md) requires separate launch
approval, empty legacy watchlist, only PKO subscriptions, no competing proposals,
real-time quotes, verified PLN funds, complete native warmup and CLEAN current
reconciliation. Scheduler remains off for individually supervised evaluations.
A provisional13:10–13:40 Warsaw window is conditional on actual readiness.

No strategy thresholds were tuned. The unchanged UTC08–20 filter and strict
momentum requirements may produce no signal. WSE12h omission changes its regime
input intentionally; strategy eligibility/profitability has not been established.
The bound loop does not automate strategy.shouldExit: broker SL/TP and supervised
full close are the supported exits. Stop the producer, close/reconcile while
writes remain authorized, prove flat/no orders, then disable writes. Master-off
is not auto-flatten. This delivery does not prove a real Paper round trip.

## CI follow-up

Initial commit f12d6b9 passed lint/typecheck/unit tests but CI35970122744 failed
one PG report test with PostgreSQL57P01 (administrator termination). The fixture
used DROP DATABASE WITH(FORCE) immediately after pg-pool.end(); the installed
pool implementation resolves end before every client socket emits its final
remove event. Teardown now explicitly awaits all existing client remove events
and uses ordinary DROP DATABASE. No broker behavior, risk/freshness checks or
error suppression changed. The fix received independent ACCEPT and all five gates passed again in a clean
copy of f12d6b9 with only the reviewed teardown fix applied (1084 PG tests pass).
