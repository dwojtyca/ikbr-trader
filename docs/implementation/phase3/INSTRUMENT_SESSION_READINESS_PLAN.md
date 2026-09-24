# Instrument-independent session and closed-candle readiness

## Objective and boundary

Owner requires morning eligibility for every instrument, not a PKO/AAPL exception.
Every configured, bound IBKR instrument uses the same contract/session-aware
history and readiness algorithm. Once the first current-session 1m candle closes,
the engine may evaluate using the last completed higher-timeframe slots from
prior sessions. This is data eligibility, not a guaranteed strategy signal or a
new execution capability. Registry activation, instrument/strategy suitability,
AI, risk, supervised windows and broker ownership remain mandatory and unchanged.
No trading activation or paid provider diagnostics in this implementation.

Work on main. Preserve the 29 unrelated research changes, including existing
signal-engine.ts edits; use explicit staging. Reuse reviewed architecture rather
than add another ticker-specific lane. Existing symbol-specific risk/AI policy is
outside this candle/calendar correction and is not claimed to become universal.

## Shared contract calendar

1. Introduce generic types/functions in shared for exact identity (instrumentId,
   conId, symbol, security type, routing exchange, currency, local/trading class,
   optional primary exchange), session mode (RTH/all-hours) and broker timezone.
   No ticker, currency, market or asset-class allowlist in readiness selection.
2. Parse IBKR SCHEDULE with its declared timezone into canonical UTC instants and
   reference trading dates. Resolve valid IANA aliases; reject invalid, ambiguous
   or nonexistent local times. Preserve ordered non-overlapping intervals, split
   sessions/lunch breaks and overnight intervals sharing a reference date. Verify
   full contract/mode identity, timestamps, coverage, generation and provenance.
3. Persist evidence per instrument + bound contract + session mode. Require READY,
   nonfuture evidence no older than six hours, current-time coverage and complete
   prior-week coverage including any overnight interval start before the prior
   Monday reference date (require an additional preceding calendar day of coverage). Refresh at startup/reconnect, hourly and session reopening;
   invalidate before publishing new evidence and fence stale completions.
   Historical prewarming may use fresh identity-verified evidence whose coverage
   ends at the last close (observed IBKR after-hours behavior), via a separate
   history-only validator. Uncovered current time retries schedule at most once
   per60seconds (steady covered calendars remain hourly), so an unknown next
   opening is discovered promptly within the existing pacing budget. It must not extend coverage or authorize live context
   evaluation/entry; those always require current-time coverage and active session.
4. Determine expected closed slots from actual sessions. Native 1m/5m/1h buckets
   follow local-midnight grid clipped by each interval; 4h follows UTC grid clipped
   by intervals. Validate observed bar alignment instead of silently relabeling.
   Daily labels follow broker reference dates and close conservatively after the
   reference-date midnight boundary AND last interval; weekly labels follow the
   last reference trading date with finality after next local Monday and all
   intervals. Actual PKO broker observation also labels weekly bars at the
   following calendar-date midnight. Accept these two native labels only as
   aliases of ONE calendar-proven weekly period, never rewrite timestamps or
   create two freshness slots. Reject duplicate aliases for a period and labels
   mapping to multiple periods, including Sunday-to-Monday boundary collisions.
   Outside recent calendar coverage, count at most one bar per unambiguous week;
   Monday labels without calendar proof are ambiguous and fail closed. Validate
   holiday-Thursday/Friday labels, DST, cross-week aliases and incomplete weeks.
   Provisional current-week responses remain excluded from persistence until the
   unchanged calendar-proven finality, even when an interim label matches a final
   canonical/alias timestamp. Refresh uses period matching, not raw-label equality. Old indicator history outside recent calendar coverage is admitted
   only with exact native provenance, valid OHLCV and conservative finality, never
   as a replacement for the expected latest slot. Unsupported layouts fail with
   explicit diagnostics, not an AAPL fallback. Never map an 8h bar into 12h.
5. Require the latest eligible closed slot for each required timeframe; allow the
   existing bounded 90-second publication grace only for its immediate predecessor.
   Require a current active-interval minute (not yesterday or before a lunch break).
   Premarket/closed interval, missing new slot, future/malformed bars, stale calendar
   and wrong contract/mode remain blocked. Duplicate/contradictory bars must not
   silently satisfy indicator counts.

## Ingestion and persistence

1. Generalize the narrow schedule-only SDK adapter: request/verify exact bound
   contract, use registry session mode, correlate requests, validate broker timezone,
   serialize shared-client usage and use existing pacing budget. No order API.
2. Persist distinct RTH/full-session native source tags. Reject concurrent bindings
   for the same conId with conflicting session modes because existing candle keys
   cannot represent both at once; never mix them.
3. Migrate instrument_contracts identity from symbol primary key to conId, preserving
   rows; create the table for migration-only databases. Upsert by conId. Legacy
   symbol-only reads reject ambiguity. Test simultaneous dated contracts with the
   same root symbol.
4. Add a versioned generic schedule migration with generation-fenced repository
   operations. Keep historical AAPL table/migration immutable; adapt its execution
   window consumer or provide verified compatibility using the generic authority,
   without allowing stale AAPL-only evidence to authorize execution.
5. Generalize native history request/refresh for all bound subscriptions and the
   six supported required timeframes. Pass useRTH per instrument; parse daily/weekly
   labels using the broker timezone, intraday timestamps as epoch; tag a new exact
   native provenance distinct from old aggregated/8h data. Historical types must
   match contract capabilities (e.g. MIDPOINT for FX rather than assumed TRADES).
   Unsupported broker data is an explicit failure, not successful empty history.
   Preserve unavailable MIDPOINT volume as unknown (-1 sentinel), never invented
   zero. Volume indicators remain unavailable; volume-dependent strategies reject
   with a capability reason while non-volume strategies may use valid prices.
6. Source-filter before LIMIT; prevent provisional tick aggregators, shutdown
   flush, legacy bootstrap and lower-quality writes overwriting managed native bars.
   Native refresh is per-contract, serialized/paced with bounded retry intervals;
   one failed instrument must not corrupt another's schedule or readiness.
7. Keep existing shared historical pacing limits; prioritize due 1m data and rotate
   instrument order fairly. Expose queued/waiting data as unready, not fresh.
   Generic support does not promise unlimited concurrent symbols: deterministic
   capacity/admission diagnostics must reject an unsustainable polling set before
   claiming readiness: reserve20 of50 requests/10min for schedule, higher bars and
   startup, allow at most floor((budget-20)/12) continuously polled instruments
   (10minute +2five-minute requests each). Cold bootstrap is unready and serialized;
   due current1m maintenance has priority over cold higher-bar work. Reject sets
   above this conservative admission bound rather than silently starve them.
8. Readiness diagnostics expose identity/mode, timezone, generation, coverage,
   expected/latest start/end and failure reason per timeframe. Legacy unbound
   production signal paths must not silently bypass calendar verification; require
   verified bound runtime for this capability. Existing research/backtest workflows
   and unrelated data acquisition are preserved.

## Signal engine and strategy sessions

1. Replace ticker-specific loader selection and wall-clock age checks for managed
   higher bars with the generic authority for EVERY bound instrument. Require
   minimum indicator history and all requested supported timeframes. Omit the
   misleading default 12h context consistently; explicitly requested strategy
   dependence on unsupported 12h must fail visibly, not pretend it was supplied.
2. Re-read schedule generation/freshness at the end of context assembly. Quote
   timestamps must be checked against a clock read after asynchronous retrieval
   (the observed false-future race), while truly future/stale values still fail.
3. Attach verified session interval/ref-date evidence to internal strategy context.
   Replace general UTC market-hours filters in strategies with the verified
   instrument session for runtime contexts. Preserve intentional strategy-specific
   waits (opening range, gap fade) and all quantitative thresholds. Legacy/offline
   contexts retain documented historical behavior unless supplied calendar proof;
   no caller-provided Boolean can bypass production loader validation.
4. Feed the same authoritative interval/reference date into runtime intraday
   indicators (reference-date session open, elapsed minutes from that open,
   previous reference-date close), avoiding
   the existing one-hour-gap heuristic for split/overnight sessions. Lunch reopening
   requires a new current-interval minute without resetting reference-session open.
   Missing opening bars make opening-range/gap/VWAP fields unavailable. Preserve
   offline historical behavior without supplied calendar evidence.
5. Allow the supervised GPW envelope to start at09:00 rather than09:05 and apply
   the generic actual-session gate to PKO and AAPL execution windows. Preserve
   exit deadlines, one-attempt budget, immutable proposal binding and all risk
   gates; producer still requires a closed current1m. Add PG acceptance tests.
6. Add generic calendar guards for every bound OPEN_OR_ADD entry at proposal
   creation, before prepare, atomic claim and final dispatch; use configured
   identity and current immutable snapshot/generation. Unsupported unbound entry
   paths fail closed. Risk-reducing closes/cancels remain exempt from entry
   calendar gating. Exercise execute-ticket/execute-proposed/legacy paths in tests.
7. Audit all production proposal entry paths. Any path without authoritative
   calendar context must fail closed or route through the existing bound runtime;
   do not modify strategy suitability or trading authorization to make signals.

## Acceptance and tests

- Same production functions for PKO, AAPL, another US ticker (MSFT), LSE stock,
  overnight futures and a split-session/non-hour-offset timezone fixture. Use
  arbitrary contract IDs/symbols to detect hardcoding. RTH and all-hours isolated.
- At one minute after open, accept exact current 1m plus prior session 5m/1h/4h,
  daily/weekly with adequate indicator history; before first minute reject.
- Holidays/weekends, differing US/EU DST dates, early close, overnight ref dates,
  lunch reopening, weekly holiday labels and immutable older-history finality.
- No lookahead: incomplete current higher bars excluded; newly due missing bars
  reject after grace; current-minute requirement cannot use prior session bars.
- Negative identity/mode/source/timezone/clock/coverage/duplicate/overlap/NaN/OHLCV
  cases; stale/future calendar, canceled request, disconnect and stale generation.
- Multi-contract schedule/cache isolation; SQL generation fences, restart/migration
  and source-preserving writes; provider request flags/labels/error semantics.
- Real production context-loader and strategy replay prove PKO summer09:01 and
  arbitrary instrument opens outside08–20UTC reach strategy filters without an
  artificial time-of-day block. Explicit strategy waits still apply.
- Non-delivering read-only IBKR probes on currently configured PKO verify actual
  schedule/native alignment and warmup after disabled deployment; other markets
  covered by fixtures are not claimed as live broker-validated.

## Workflow, validation and delivery

Independent plan ACCEPT before edits; different independent implementation reviewer
checks completeness and hostile cases, iterated until ACCEPT. Run targeted unit/PG
checks and relevant deterministic historical strategy replay, then clean-copy
pnpm lint, typecheck, test, test:integration on isolated PostgreSQL, build and clean
Docker build. Preserve initial failures and diagnose them rather than hiding them.
Write report/runbook updates, commit/push main and verify exact-commit GitHub CI.
Deploy reviewed image with PKO only, paper writes/loop disabled and AI stopped;
read-only bootstrap/reconciliation/readiness evidence, no fresh entry window.
Document that other instruments need registry bindings, broker data entitlements
and existing supported execution policies; this change removes ticker-specific
history readiness, not those independent requirements.
