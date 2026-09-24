# AAPL morning-session readiness — bounded implementation plan

## Owner objective and current evidence

Permit the existing one-share AAPL strategy to evaluate new entries near the
regular-session open, without waiting four hours for today's higher-timeframe
bar. Keep completed-candle inputs, default strategy parameters, mandatory AI,
deterministic risk, Paper account controls, one-entry daily budget and supervised
window. This plan does not activate trading or implement the separate AI research
extension. Work on main; preserve all 29 unrelated research files.

Read-only inspection found three independent morning blockers:

- Loader and native warmup use elapsed wall time for freshness. Yesterday's last
  closed 5m/1h/4h bar becomes stale overnight even when no newer closed bar exists.
- `aaplCandleEnd` assumes timestamp plus nominal duration. Actual persisted IBKR
  AAPL history has 4h starts at 09:30 and 12:00 New York, and hourly starts at
  09:30, 10:00, ..., 15:00. The opening buckets are clipped to the RTH boundary;
  09:30 plus four hours incorrectly postpones the first bucket's finality to13:30.
- The AAPL run-window parser explicitly excludes starts before09:35 ET.

Earliest intended evaluation is after the first completed current-session1m bar,
approximately09:31 ET plus ingestion, strategy and AI latency. Do not promise a
09:30:00 fill, a signal on every opening minute, or a trade without all gates.
History must be warmed before open; a cold start can legitimately take longer.

A bounded read-only Gateway probe succeeded using installed @stoqey/ib1.6.10:
`reqHistoricalData(id, exactAaplContract, '', '14 D', '1 day', 'SCHEDULE', true, 1, false)`.
The `historicalSchedule` response had timezoneUS/Eastern and fourteen trading
sessions spanning2026-09-04 through2026-09-24, including the current full session,
omitting Labor Day and weekends. No order was submitted. Contract liquidHours
alone covers today/future and does not establish the previous trading session.
The old ingestion ib0.2.9 cannot decode schedule message106.

API basis: [IBKR Historical Bar Data](https://interactivebrokers.github.io/tws-api/historical_bars.html)
(SCHEDULE through historical-data request, one-day bars). Public contract/bar
identity is documented here; private raw diagnostics remain outside Git.

## Deliverable A — authoritative recent sessions

1. Add a narrow ingestion-owned schedule adapter with an explicit pinned
   @stoqey/ib1.6.10 dependency and dedicated configured clientId distinct from all
   existing broker clients. Do not migrate the existing quote/history sockets.
   Verify server support (minimum165), exact requested AAPL265598/STK/SMART/USD,
   contractDetails response identity and matching request completion. Accept only
   validated America/New_York / US/Eastern timezone aliases. Signal-engine must
   read persisted ingestion evidence, never connect to the broker.
2. Request14 D using SCHEDULE/RTH and validate that the returned coverage is
   sufficient; do not assume a fixed trading-session count from the duration.
   Refresh before the session, at the opening boundary, after reconnect and at
   most hourly during steady-state operation. Pre-open responses must not be
   assumed to contain the upcoming session; obtain and validate current coverage
   again at open if needed. Bounded recovery retries remain subject to pacing. Share ingestion's
   existing historical pacing gate with this adapter; factor that gate only as
   needed, preserving legacy history and ES confirmation behavior. One request in
   flight, bounded timeout/cancellation/listener cleanup and failure backoff.
   Other account clients still share broker limits; no parallel backtest loading
   during supervised operational preparation.
3. Add an immutable SQL migration for a validated schedule snapshot keyed by the
   exact contract/source. Store request identity, response coverage bounds,
   normalized timezone, sessions, request/received timestamps and generation.
   Validate real dates, timezone round trips/DST, nonoverlapping sorted intervals,
   matching refDate, positive duration and complete response envelope. Reject
   unknown timezones, duplicates, truncated coverage, wrong identity, malformed or
   out-of-order contradictory evidence. An omitted date means closed only inside
   a complete authoritative response range; no weekday/holiday guessing.
4. Freshness decisions require recent successful evidence (max6h), no later
   refresh failure or reconnect invalidation, current-session coverage, and enough
   preceding coverage to identify the previous session and complete prior week.
   Publish failed/in-flight/generation state; older responses cannot overwrite a
   newer invalidation. Missing schedule blocks readiness with an explicit reason.
   A missing or unsupported API response must not fall back to hardcoded weekdays.

## Deliverable B — closed slots and freshness

Use one shared pure implementation in ingestion and signal-engine. Keep source,
contract, OHLC, volume and minimum-count checks. Do not globally increase existing
age limits and do not alter WSE, futures or other US-symbol paths.

For exact AAPL intraday bars use the observed UTC wall-clock lattice:
1m and5m aligned to minute multiples;1h to whole hours;4h to00/04/08/12/16/20UTC.
Intersect each bucket with the authoritative RTH session. Therefore a summer normal day
has4h intervals09:30–12:00 and12:00–16:00 New York; a winter normal day
has09:30–11:00,11:00–15:00 and15:00–16:00 New York. Hourly begins09:30–10:00.
Use the session close to clip early-close terminal bars. Never derive all buckets
by repeatedly adding four hours to09:30. Validate broker-returned starts against
this lattice on the covered recent sessions; any mismatch blocks readiness and
requires a separately reviewed rule, not an inferred relabel or dropped bad row.
Confirm this rule against the actual native response during implementation,
including a historical winter/short-session sample before claiming those cases
operationally supported. Synthetic edge-case tests alone do not establish broker
alignment. No extra operational history request bypasses pacing.

For each timeframe compute the most recent expected fully closed slot at `now`.
Before today's first closed5m/1h/4h slot, use the exact terminal slot of the previous
trading session. Once a newer slot is due, require that exact slot; a yesterday
bar must not hide a stopped feed. Allow a fixed bounded publication grace of90s
only after the expected boundary, with the preceding exact slot as temporary
fallback. After grace expires, missing data blocks. A present current slot is
usable immediately after closure; grace does not delay it. Quotes retain their
separate strict freshness requirements.

For1m additionally require at least one fully closed bar from the current active
session, and never use a previous-session minute to create an opening signal.
Outside authoritative regular hours no entry-ready context is published. This
allows the first normal evaluation near09:31, while keeping09:30 partial bars out.

Daily and weekly freshness must not become alternative morning blockers after a
holiday/weekend. Preserve conservative daily next-New-York-midnight and weekly
next-Monday-midnight finality in this delivery. Select the last eligible completed
trading day / week from the covered sessions. Match daily refDate and validate the
broker's weekly date labeling against actual native samples (observed end-of-week
Friday dates), rather than requiring a Monday start. Never use a partial current
week or accept an older eligible week when the expected completed week is missing.

Recent schedule evidence governs the latest expected slot and recent-bar finality;
it is NOT claimed to cover all50 weekly historical bars. Older native rows retain
existing conservative finality/provenance validation, unchanged minimum counts
and IBKR RTH source identity. No historical calendar is fabricated for uncovered
dates. Correcting old-bar OHLC/session alignment or changing the historical input
series is outside this delivery. The recent schedule must cover every slot used
for freshness/previous-session/week selection; otherwise fail closed.

Keep `ibkr_aapl_rth_native_v1`: native broker provenance is unchanged. Newly
admitted shortened current-session buckets must come from fresh broker responses
and be persisted only after their schedule-verified end. Do not relabel legacy
rows. The same closed-slot checks must run again at the strategy boundary; missing
schedule coverage cannot be replaced by the source tag alone.

## Deliverable C — operational wiring

- Replace `End(End(latest))` refresh scheduling with the same expected-slot policy.
  Schedule fetch when a newly closed slot is due; a successful earlier fetch must
  not suppress that boundary fetch beyond90s grace. Preserve bounded failure backoff,
  and expose expected/latest starts/ends, session date, coverage/freshness status,
  request failure and blocking reason in aaplWarmup. Counts alone are not READY.
- Read schedule evidence and generation consistently with strategy context;
  changes/failures during loading must not publish a context based on stale proof.
  No operational database fixture writes or ad hoc history repair.
- Change the AAPL window envelope from09:35 to09:30 ET; keep same-date/max60minute
  duration,15:45 deadline, proposal binding, immutable consumed attempt and all
  pre-prepare/claim/dispatch guards. Actual broker session coverage remains required
  for the chosen window at insertion, prepare, atomic claim and dispatch; holidays
  and early close must not be authorized by the weekday envelope. Revalidate fresh
  persisted schedule identity/generation at these existing gates, with failure
  returning a stable denial and no broker write. Preserve close/protective-order
  behavior; closing is not an entry and must not require an opening signal.
- Keep actual trading/loop disabled during delivery. Update runbook pre-open warmup,
  earliest first-minute evaluation and remaining AI checks. No unattended startup,
  scheduler change, strategy retuning, risk loosening or automatic test launch.

## Acceptance and verification

Independent plan ACCEPT precedes implementation. A different independent agent
must review final implementation, completeness and hostile races before delivery.

1. Normal opening09:30 refuses partial minute;09:31 with valid new1m and prior
   exact closed5m/1h/4h accepts complete context. Check subsequent09:35/10:00/12:00
   transitions, boundary−1ms/exact/+1ms,90s grace and missing successor refusal.
2. Monday uses Friday; holiday uses last actual session; unknown calendar coverage
   fails. Test Thanksgiving early close, multi-day closure, US DST changes and
   differing Europe/US DST transition weeks. No fixed Poland↔US hour offset.
3. A stalled feed, missing terminal prior-session bar, missing new5m/1h/4h slot,
   stale quote, wrong source/contract, missing native minima and malformed schedule
   all block. Out-of-order callbacks and failure/reconnect generation races cannot
   resurrect old readiness. First active-session minute must be present.
4. Shortened opening and early-close buckets cannot appear before verified closure.
   Test unsupported/mismatched broker alignment rather than accepting its OHLC.
   Daily/weekly holiday selection rejects partial or older-than-expected history.
5. Exercise production adapter events, real PostgreSQL schedule round trips,
   generation handling, SQL source-before-LIMIT and production loader/loop wiring.
   Verify09:30 envelope and all existing AAPL one-attempt/unknown-submission guards.
6. Deterministic multi-session replay through the production context loader and
   existing strategy: compare old/new context eligibility and record signal counts
   around open; compare indicators on identical input bars and prove no lookahead.
   Include weekend/holiday/early-close/DST fixtures and relevant backtest regression.
   Report mechanics only; this does not establish profitability or demand a signal.
7. Clean-copy pnpm lint/typecheck/test/test:integration/build and clean Docker build;
   no tests against the operational DB. Report, exact-scope commit/push on main,
   verify exact-commit CI. Preserve unrelated work and secrets.
8. Disabled deployment/preflight: actual schedule, native bar alignment, expected
   versus present slots, current quotes/account/reconciliation. Before declaring
   morning E2E proven, observe an actual opening session with approved scoped test;
   replay alone proves mechanics, not a real broker entry/exit. Any window or
   provider gate still unavailable remains a stated blocker.

## Limits and rollback

The morning fix permits strategy evaluation, not guaranteed execution. AI can
reject and deterministic risk can refuse. The separate AAPL AI identity/context
limitation remains on the next-stage list and is not silently marked resolved.

Rollback: keep writes/loop disabled, redeploy the prior reviewed image, preserve
broker-side protection and all durable proposals/attempt budgets. Retain additive
calendar evidence for audit; never delete positions/holds to manufacture readiness.

## Planning review status

Independent plan review: ACCEPT. Independent SDK/probe/document fact review:
ACCEPT. Clarifications from review explicitly require returned-coverage validation,
new-boundary refresh within the publication grace, and actual-session checks at
the existing submission phases. Runtime implementation, implementation review,
replay, full checks and disabled deployment are subsequent deliverables; this
planning document does not claim that the morning restriction is already fixed.

## Amendment M1 — native winter alignment (implementation evidence)

The required read-only Gateway sample on2026-09-24 contradicted the original
fixed-New-York4h grid. Exact AAPL native4h epochs for2026-01-06/07/08 began
14:30UTC,16:00UTC,20:00UTC. The2025-11-28 early-close sample began14:30UTC
and16:00UTC (regularclose18:00UTC); preceding winter full sessions had the same
three starts. Summer persisted samples begin13:30UTC and16:00UTC. Weekly probe
confirmed completed Friday labels and a partial current Thursday label.

Bounded correction: anchor intraday slots to UTC midnight, then intersect each
bucket with the authoritative New York session; retain every other gate,
provenance, conservative daily/weekly finality, coverage policy and minimum.
This is an inference matching the observed summer, winter and short-session
native responses, not a guarantee of undocumented IBKR behavior. Any future
mismatching native start must still fail closed. Add immutable observed-epoch
fixtures to tests, assert no shorter bucket becomes eligible before its actual
end, and exercise both DST transitions and shortened winter terminal bars.
Old uncovered historical rows retain the previous conservative finality policy.

M1 independent plan review: ACCEPT. Reviewed separately from the shared-policy
implementation and by a different agent than the final implementation reviewer.
An additional paced weekly probe confirmed the Good Friday2026 week carries
Thursday2026-04-02, matching the last actual session rather than nominal Friday.
