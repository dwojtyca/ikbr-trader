# AAPL morning-session implementation

## Delivered behavior

AAPL can build a complete strategy context after the first closed minute of the
current regular session, provided history, current quotes and all other gates are
ready. Higher timeframes use the exact latest completed broker-session slot,
including the preceding session before a new bucket closes. The strategy itself,
indicator parameters, mandatory AI decision, deterministic risk, one-share scope,
one-attempt budget and bounded supervised window are unchanged.

The ingestion-owned schedule adapter uses pinned `@stoqey/ib` 1.6.10 on a distinct
client ID. It verifies the exact AAPL stock contract, requests the recent RTH
schedule through the existing history pacing gate and persists generation-fenced
READY/REFRESHING/FAILED evidence. Startup/reconnect invalidates old readiness.
Hourly/open refresh and bounded retry preserve the broker request budget; warmed
pre-open history does not trigger repeated six-timeframe downloads.

Shared slot validation handles session boundaries, holidays, DST and short
sessions. A missing successor blocks after at most 90 seconds of publication
grace. Current-session 1m remains mandatory. Daily/weekly finality remains next
New York midnight/next Monday. Older uncovered history retains its previous
conservative validation; the recent calendar does not pretend to cover 50 weeks.
Signal context rechecks calendar evidence and data eligibility after async reads.

AAPL windows can begin at 09:30 ET, but this does not permit a partial-minute
signal. Insertion, preparation, atomic claim and dispatch validate the complete
window against current persisted broker sessions. A transaction-bound final wire
permit holds the calendar row lock through synchronous broker submission and
checks expiry and connection generation after waits. Late or duplicate callbacks
cannot send an order. Close/protective workflows retain their existing rules.

## Broker evidence and plan amendment M1

Four bounded, paced, read-only history probes on 2026-09-24 confirmed:

- Winter January 6–8, 2026: native 4h starts at 14:30, 16:00 and 20:00 UTC
  (09:30, 11:00 and 15:00 New York).
- November 28, 2025 shortened session: starts at 14:30 and 16:00 UTC.
- Completed September weeks carry Friday labels; the current incomplete week
  carried Thursday September 24 and is excluded.
- The Good Friday 2026 week carries Thursday April 2, the last actual session.

Together with observed summer starts at 13:30 and 16:00 UTC, these contradicted
the original fixed New York 4h grid. Independently accepted amendment M1 anchors
4h buckets to UTC and clips them to the authoritative RTH session. This is an
inference validated against these samples; any future alignment mismatch still
blocks readiness. No prices were relabeled and no broker order was submitted.

## Replay and review

Seven synthetic morning replays exercise an ordinary session, Monday, the day
after Labor Day, both US DST changes, a Thanksgiving shortened session and the
following Monday. At 09:31 ET the production loader accepts all seven complete
contexts; the former wall-clock 4h freshness rule rejects all seven. The existing
strategy emits zero signals on these fixtures. Indicators match direct
calculation on identical input bars. This proves mechanics, not profitability.
09:30 partial-minute input, missing successor, changed calendar generation and
failed/in-flight schedule evidence are rejected.

Independent review identified and corrected pre-open request amplification,
late SDK error cleanup, effective client-ID collisions and failed database
invalidation recovery. Final independent implementation and document review: ACCEPT. The reviewer
independently ran 154 targeted unit tests and 22 isolated PostgreSQL tests.

## Validation and operational status

Final clean-copy `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` against isolated PostgreSQL, and `pnpm build` all passed.
The unit run includes 400 shared, 1115 execution, 75 ingestion and 497 signal
tests, plus the backtest/simulator and verifier suites. Existing three lint
warnings remain; there are no lint errors. A clean Docker build passed.
All 29 unrelated research files retain their original hashes.

Code commit: `dfda4263924c5293bf29cb5e4e07dd0642de5f2d` on main.
[Exact-commit CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/36039316601)
completed successfully. Deployed image `ikbr-trader-gpw:dfda426`, digest
`sha256:49b4aeb7ae277993f346f820de839fd6403b515155a0e1f3c1fa367b707c7a62`.

Disabled deployment observed on 2026-09-24 at 18:13–18:15 UTC:

- Ingestion, signal and execution run the same reviewed image; AI worker is
  created but stopped. Paper writes and trading loop are false; no entry window.
- Real Gateway schedule is READY, generation 2, fourteen sessions, received
  18:13:30 UTC. Fresh AAPL bid/ask is marketDataType 1 with a 0.02 USD spread
  in the sampled quote. No competing-session failure was observed.
- All six retained timeframes pass the production loader at 18:14 UTC. The 1m
  sample temporarily uses the immediately preceding slot within publication
  grace; other timeframes match their expected closed slots. The current 4h
  opening bucket has verified 13:30–16:00 UTC boundaries.
- Existing strategy evaluates the real context and returns no candidate:
  `hourly_momentum_too_weak`. No signal or proposal was manufactured.
- Current-session reconciliation is CLEAN, readiness returns 200, no active holds
  and no AAPL position. Stack verifier reports HEALTHY, 12 healthy checks and
  two expected disabled controls, zero degraded/unhealthy/unreachable checks.

This documentation-only follow-up records the validated code deployment; its
commit does not change the running image or runtime behavior. No trading activation is part
of this implementation. The separate AAPL AI research identity/context gap
remains a launch gate; provider configuration alone does not resolve it.
An actual supervised morning entry/exit has not been observed.
