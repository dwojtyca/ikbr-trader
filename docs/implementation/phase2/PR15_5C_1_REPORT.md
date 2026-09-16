# PR15.5C.1 — IBKR ES source parity and immutable dataset acquisition — REPORT

Status: complete; READY for PR15.5D

Date: 2026-09-16

## Outcome

PR15.5C.1 acquired, validated, finalized, and imported a real ES research
dataset from the IBKR TWS API. The acquisition used exact dated futures
contracts and the frozen native `1 min / TRADES / useRTH=0` request tuple.
No order was placed, modified, or cancelled. `TRADING_ENABLED=false` and the
exclusive historical-data window were maintained throughout acquisition.

The final immutable bundle is local-only at
`.local/ibkr-es-acquisition/final` and is not committed.

## Approved source specification

- schema: `pr15.5c.1-ibkr-es-acquisition-v2`
- roll policy: `ibkr-es-volume-crossover-next-session-v2`
- specification SHA-256:
  `e39a59790324186f3665d1d2a287bf7c6ae9d794337ac7b1801f942fe658e8af`
- target: `2025-06-22T22:00:00.000Z` through
  `2026-08-31T20:59:00.000Z`
- contracts: `ESU5`, `ESZ5`, `ESH6`, `ESM6`, `ESU6`
- IBKR API server version: 77
- planned and completed requests: 102

The v2 artifact differs from the rejected v1 artifact only in the versioned
acquisition-schema and roll-policy identifiers. Contract identities, request
tuple, fetch windows, pacing, calendar identifier, and request estimate are
unchanged.

## Acquisition result

- provenance ID: `ibkr-es-20250622-20260831-e39a59790324`
- raw exact-contract candles: 483,608
- exact-contract candle counts:
  - `ESU5` / `637533641`: 88,533
  - `ESZ5` / `495512563`: 104,400
  - `ESH6` / `649180695`: 100,942
  - `ESM6` / `649180678`: 102,838
  - `ESU6` / `649180671`: 86,895
- candle-file SHA-256:
  `9d40e586a77c29f036cf0df270f71ef59bcd36ea3f7625941cd81c99fbef7ca3`
- selected-contract expected minutes: 423,360
- selected-contract present minutes: 423,300
- completeness: 99.9858276643991%
- entirely missing open sessions: 0
- missing acquisition chunks: 0
- pacing-wait events in the clean v2 run: 0
- maximum consecutive selected-contract gap: 1 minute

The accepted roll transitions are:

1. `ESU5 -> ESZ5` at `2025-09-15T22:00:00.000Z`
2. `ESZ5 -> ESH6` at `2025-12-15T23:00:00.000Z`
3. `ESH6 -> ESM6` at `2026-03-16T22:00:00.000Z`
4. `ESM6 -> ESU6` at `2026-06-15T22:00:00.000Z`

Each transition was derived from the first completed CME session in the
approved 15-calendar-day window whose incoming-contract volume strictly
exceeded outgoing-contract volume. The incoming contract becomes valid only
at the next session open.

## Import result

The bundle was atomically imported into the isolated database
`ikbr_trader_backtest_pr15_5a`.

- dataset ID: 1
- status: `ready`
- finalized: yes
- database fingerprint:
  `6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026`
- 1m rows: 483,608
- futures-contract rows: 5
- aggregate rows: 96,737 (5m), 8,068 (1h), 2,106 (4h), 709 (12h),
  356 (1d), 75 (1w)

The importer recomputed the fingerprint from PostgreSQL read-back before
finalization and installed the PR15.5C immutability guards.

## Fail-closed findings resolved during execution

1. The first acquisition pass exposed a calendar error for 2025-07-03. IBKR
   contained valid ES bars through 12:14 Chicago time, while the bounded
   calendar incorrectly closed at 12:00. The definition was corrected to the
   12:15 close and protected by a boundary test. A scan of all acquired rows
   found no other closed-session discrepancy.
2. Roll policy v1 required a crossover before the final five sessions. Real
   IBKR volume showed all four first crossovers during customary roll week, so
   v1 rejected valid data. The operator approved v2, which searches the full
   approved 15-calendar-day window through the final session completed by
   `lastTradeAt`. The semantic change received a new policy/spec version and
   exact hash; v1 checkpoint files were not rebound or copied.
3. Two transient IBKR disconnects occurred after the workstation had slept in
   the rejected v1 pass. Partial responses were not accepted and retries
   completed. The clean v2 acquisition completed all 102 requests without a
   reconnect or retry.
4. The historical client now fails an in-flight request immediately on socket
   disconnect and does not schedule its retry (or a new request) until IBKR
   restores the API session with `nextValidId`. Lifecycle tests cover both a
   disconnect before a request and a disconnect while one is active.

## Verification

- final independent hostile review: APPROVED, no P0-P2 findings
- `pnpm typecheck`: PASS
- `pnpm test`: PASS outside the filesystem/network sandbox required by the
  dynamic-loopback fixture tests
- `pnpm lint`: PASS with three pre-existing unused-disable warnings
- `pnpm build`: PASS
- backtest-engine unit tests: 60 passed, 0 failed, 2 PostgreSQL integration
  suites skipped by the unit-test command
- acquisition lifecycle tests: PASS for approved-hash enforcement, corrupted
  checkpoint rejection, interruption/resume byte equivalence, final-directory
  overwrite refusal, partial-failure isolation, atomic finalization, importer-
  compatible multi-contract output, and absence of order API calls
- real PostgreSQL import and read-back fingerprint: PASS
- `pnpm test:integration`: PASS; PostgreSQL suites were skipped because this
  run did not provide a disposable `TEST_POSTGRES_URL` (the real isolated
  import/read-back above supplies the operational database evidence)
- `git diff --check`: PASS

An initial sandboxed `pnpm test` run failed only because the sandbox denied
fixture `listen(127.0.0.1)` calls with `EPERM`; rerunning the identical suite
with local dynamic sockets allowed passed.

## Scope boundary

PR15.5C.1 does not run a strategy experiment, enable ES in a strategy, enable
execution, or perform Paper E2E. PR15.5D may now consume dataset ID 1 by its
immutable provenance ID and fingerprint.

Source parity means the research and live paths use IBKR and the same frozen
historical request semantics. It does not promise that a future download will
be byte-identical: IBKR may correct historical records later. Reproducibility
therefore depends on the finalized local artifact, its candle SHA-256, and the
database fingerprint recorded above.
