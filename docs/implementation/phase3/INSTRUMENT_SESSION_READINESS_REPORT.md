# Instrument-independent session readiness — implementation report

## Delivered behavior

Every configured bound instrument uses the same persisted broker-calendar and
native-candle path. It is keyed by instrumentId, exact contract and RTH/all-hours
mode. The runtime can combine the first closed current-interval minute with the
last completed higher-timeframe slots from earlier sessions. No AAPL/PKO selector
remains in this production readiness path. This does not create new strategies,
activate instruments, bypass AI/risk or enable unsupported execution policies.

The shared calendar validates contract identity, timezone/DST, interval ordering,
coverage, timestamps and generation. It handles overnight reference dates, lunch
breaks, holidays and early closes. Unknown/misaligned data fails explicitly.
Historical prewarming has a separate validator for after-hours broker coverage;
entry always requires current-time coverage and an active interval.

Ingestion uses one serialized, paced schedule/native-history coordinator, mode-
specific provenance, exact-contract metadata and protected candle writes. Metadata
is now keyed by conId, permitting different contracts with the same root symbol.
Capacity is explicitly bounded to two concurrently polled contracts; conflicting
modes for the same contract are rejected. No higher historical pacing limits were
introduced. Native 12h remains unsupported rather than mislabeled 8h.

Production strategies receive verified session evidence, replacing broad UTC market-
hour gates while preserving intentional strategy waits and numeric thresholds.
Legacy unverified production signal producers fail closed. Offline research keeps
its explicit historical behavior and cannot become production calendar authority.
New entries are calendar-checked during insertion, preparation, atomic claim and
final dispatch. Supported lifecycle closes remain separate. The PKO supervised
window envelope now begins at 09:00 Warsaw; actual first-minute readiness still
comes from the shared loader.

## Review and verification

Independent plan review ACCEPT after clarifying metadata keys, generic execution
checks, calendar-derived intraday indicators, unknown volume, pacing capacity and
prior-week overnight coverage. The history-only after-hours clarification was also
independently ACCEPTED. A subsequent independently accepted amendment handles
broker weekly labels on the final reference date or its following date, without
rewriting source timestamps or advancing weekly finality.

Shared targeted tests cover arbitrary identities, PKO/AAPL/MSFT/LSE/non-hour-offset
zones, overnight and split sessions, early closes/holidays, US/EU DST differences,
first-minute eligibility, publication grace, invalid identities/modes/sources,
malformed/duplicate bars, unknown volume and after-hours non-authorizing prewarming.
The independent final implementation review ACCEPTED after fixes for unknown
volume, incomplete intraday indicators, ambiguous symbols, eager schedule
invalidation and serialized DDL. The reviewer independently ran 195 targeted
tests including 34 PostgreSQL cases, followed by 43 weekly/shared-ingestion
regressions. The final shared suite passed 36 tests; offline PKO strategy replay,
indicator and session-filter regressions passed 18 tests without broker or DB
writes.

Clean snapshot validation excludes all 29 unrelated research files (their original
hashes remain unchanged):

- `pnpm lint`, `pnpm typecheck`, `pnpm build`: PASS.
- `pnpm test`: 2459 passed, zero failures; 52 PostgreSQL tests intentionally skipped
  without a database URL and covered by the integration command.
- `pnpm test:integration`: 2037 passed, zero failures/skips, isolated PostgreSQL16
  on port55442, never the operational database.
- Clean Docker build: PASS; reviewed image digest
  `sha256:9cfd5b866ad9da60357115e6f04314ec163484ae72cf8df44fa53ab41a8479b4`.

## Read-only broker observation

On 2026-09-24 the generic schedule adapter successfully resolved PKO/35146360,
WSE/PLN, Europe/Warsaw and RTH from Gateway. It returned real session intervals
through 2026-09-24 17:05 Warsaw. After-hours coverage ends at the last close; it was
not extended to fabricate readiness. This observation motivated the separate
history-only prewarming validator. It is not a real morning entry/exit observation,
and cross-market fixture tests are not live validation of all broker instruments.

Captured native PKO history also verified 60 closed 4h bars and 59 closed weekly
bars from 60 returned rows. The provisional current-week row was excluded. PKO
weekly labels use Saturday local midnight; the shared period matcher accepts this
as the following-date label of the completed Friday session. Daily history had
59 closed bars from 60 returned rows under the conservative midnight finality rule.

Delivery, exact-commit CI and disabled-deployment evidence will be recorded after
all reviews and required checks pass. No orders or paid AI requests are part of
this implementation task.
