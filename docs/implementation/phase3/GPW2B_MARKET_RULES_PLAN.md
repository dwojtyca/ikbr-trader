# GPW2B — authoritative WSE rules and sessions

Date: 2026-09-24. Status: ACCEPTED by independent gpw2b_plan_review.
Owner authorizes plan review → implementation → new independent review → all
checks → commit/push main → exact-commit CI. No activation or broker writes.
Preserve the 29 unrelated dirty research files.

## Architecture decision

Keep ib@0.2.9 for execution and existing feeds. Its legacy protocol does not
expose marketRuleIds or reqMarketRule. Add pinned @stoqey/ib 1.6.10 only to
execution-engine for a separate READ-ONLY metadata socket to the same configured
Gateway host/port. It calls only contract details and market rules (plus account
identity bootstrap). It never calls order/cancel/account mutation functions.
The provider is lazy, bounded by timeout, disconnects on completion/failure,
serializes requests and uses a configurable distinct clientId. No persistent
socket/cache survives refresh or reconnect. Missing/ambiguous/error data blocks.

## Metadata and pure validation

- Bind exact account membership and one returned contract: conId, symbol, STK,
  WSE, PLN, localSymbol and tradingClass must match trusted binding/registry.
  Reject duplicate/zero details, wrong reqId, wrong marketRuleId, missing values.
- Map WSE to marketRuleIds by positional validExchanges CSV (preserve blanks).
  Require exactly one WSE occurrence and matching list lengths and positive ID.
- Validate nonempty ordered price bands: lowEdge starts at zero, strictly
  increasing, finite nonnegative; increment finite positive. Validate each
  entry/SL/TP and prepared wire price at its OWN band. Never approximate from
  minTick or normalize/round an AI-approved price. Reject unsupported price
  shapes and non-whole quantity for WSE instead of silently flooring.
- Parse explicit-date liquidHours intervals and CLOSED days in broker timezone
  Europe/Warsaw (allow equivalent Poland alias). Validate real calendar dates,
  times and interval ordering; unknown timezone/format/missing current date
  fails closed. Convert Warsaw time with DST-aware Intl. Intersect broker
  intervals with a conservative application window 09:05–16:45 Warsaw,
  weekdays only. This is an operational restriction, not a hardcoded holiday
  calendar: broker CLOSED/missing dates deny even on weekdays. Entry and new
  closing orders use the same window; existing cancellation remains available.
- Evidence expires at min(request start + 60 seconds, current interval end,
  application-window end). Require requestStarted <= received <= now; expiry must equal the calculated
  minimum and be strictly later than now (now >= expiry denies). Malformed
  metadata and stale rules fail closed. Persist contract/rule/bands/session source and timestamps
  with risk evidence; do not claim quote freshness from metadata freshness.

## Production integration

- One server-owned metadata provider is shared by entry/close risk assessment
  and TwsExecutionClient preparation via injected dependency.
- WSE risk assessment requires verified metadata, valid per-leg prices and open
  session; USD behavior unchanged. The existing atomic entry claim validates risk-evidence expiry; include
  metadata/session expiry in it, without network I/O inside the transaction.
  Preparation obtains fresh metadata; dispatch revalidates it synchronously.
- WSE preparation resolves only via this strict source, bypassing legacy
  contract fallback and approximate ladder. Trusted binding must exist;
  unbound/legacy WSE dispatch is refused. Remove guessed ladder usage.
- WSE full-close preflights metadata/session/price risk BEFORE any protective
  cancellation, recording BLOCKED on failure; already-flat completion remains
  ahead of quote requirements. Prepared and risk metadata share account/contract
  identity; dispatch verifies execution generation. Build the same close ticket before
  the cancellation loop; retain fresh after-cancel and claim risk checks.
  Add PG closed/stale/off-band preflight cases with zero cancels/dispatch.
- Prepared WSE plan retains metadata and execution connection generation.
  Immediately before dispatch recheck generation, identity, every wire price
  and session/expiry synchronously, before any placeOrder. No metadata fetch
  or retry after a submission marker. A crossed session/reconnect denies and
  stays covered by existing unknown-submission/reconciliation fencing.
- Static policyTick==minTick validation remains for other instruments; WSE
  actual price acceptance is broker-band validation. No silent fallback.
- Add disabled PKO stock seed (pko_wse, PKO, WSE, PLN, conId35146360), all four
  activity flags false, maxQuantity1, maxLeverage1, spread/slippage0.05PLN,
  no overnight, Warsaw RTH. No executionPolicy or deployment binding enabled.
  Ensure configured binding cannot override pinned seed conId/local identity.
- Do not change strategy levels, warmup, run budget, P&L or launch configuration;
  these are GPW3. No real market order/FX conversion/paid AI calls.

## Acceptance

Pure tests: differing bands per leg, exact boundaries and floating tolerance,
invalid/missing/duplicate/unsorted bands, identity mismatch, weekends, CLOSED,
missing dates, summer/winter DST, invalid dates/times/timezones, interval edges,
stale/future metadata, cutoff expiry, and forged persisted metadata identity
  or timestamps (not only raw provider input). Invalid metadata yields zero dispatch.
Provider fake-event tests: lifecycle readiness, correlation, exact single
contract, CSV positions, timeout/errors/disconnect cleanup, no write methods.
TWS fake tests: strict metadata path without old resolver fallback, no rounding,
exact valid bracket/close wire, invalid child price, closed/expired session and
connection generation change refuse before any broker write; no direct bypass.
Production-service PG tests: WSE approved entry and full close through risk
metadata gate, persisted metadata, invalid/stale/session failure prevents claim
or dispatch; keep all existing unknown/concurrency/cancel invariants.
Seed/binding tests: disabled PKO, pinned identity cannot be rebound, USD/futures
regressions. Run all local lint/typecheck/test/build and Postgres integration;
existing backtest tests cover unchanged strategy. Independent implementation
review must ACCEPT. Report limitations, commit/push reviewed scope only and
verify exact GitHub CI. Stop at GPW2B boundary, no Paper readiness claim.

## Sources

- https://www.interactivebrokers.com/docs/tws-api/doc/orders/minimum-price-increment/introduction
- https://www.interactivebrokers.com/docs/tws-api/ref/contract-details
- https://stoqey.github.io/ib-doc/classes/IBApi.html

## Test clock boundary

Pure and TWS tests control the complete clock at Warsaw weekday noon and test
session/expiry boundaries directly. PostgreSQL service tests retain real database
and lifecycle clocks; their fake external risk adapter invokes the production
assessor at deterministic Warsaw noon and translates only the accepted expiry
DURATION to the real DB clock. Original validated metadata remains intact for
persistence assertions. This avoids time-of-day-dependent CI without production
clock overrides. These PG tests prove service gating and persistence, not one
continuous real-time broker session. No production bypass or fake clock exists.
