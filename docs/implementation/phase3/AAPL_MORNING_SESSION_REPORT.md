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

Exact-commit CI and disabled deployment evidence will be appended after push. No trading activation is part
of this implementation. The separate AAPL AI research identity/context gap
remains a launch gate; provider configuration alone does not resolve it.
An actual supervised morning entry/exit has not been observed.
