# PR15.5C — Reproducible ES dataset foundation — IMPLEMENTATION REPORT

Status: complete locally; independent hostile review approved; data readiness
`INCONCLUSIVE`

Date: 2026-09-16

## Outcome

PR15.5C adds an isolated, fail-closed import foundation for immutable,
fingerprinted ES research datasets. The implementation proves the complete
bundle-to-PostgreSQL machinery with synthetic ES-shaped data, but no approved
real ES bundle was available. Consequently, this report does not claim ES data
readiness or strategy compatibility, and PR15.5D remains blocked.

## Implemented

- A strict, versioned local bundle contract containing `manifest.json` and
  canonical LF-terminated `candles-1m.ndjson`; the importer performs no
  network or broker acquisition.
- Exact ES contract economics, lifecycle, roll-sequence, CME calendar,
  minute-ordering, session-membership, OHLC, integer-tick, and checksum
  validation before any dataset write.
- A frozen streaming SHA-256 format whose durable identity is
  `provenanceId + fingerprint`. Runtime database IDs, timestamps, and derived
  aggregates are excluded.
- Exact isolation to database `ikbr_trader_backtest_pr15_5a`, with URL and
  server-side database/schema checks and a forced `public` search path.
- A two-pass streaming importer with bounded batches, transaction-wide
  exclusive locks, atomic dataset/contract/candle/aggregate insertion, and a
  PostgreSQL read-back fingerprint computed through a bounded cursor.
- Multi-contract candle identity `(symbol, conId, ts)` and session-aligned
  `5m`, `1h`, `4h`, `12h`, `1d`, and `1w` aggregation without joining a roll
  into a synthetic candle.
- One-way finalization and database triggers that reject `INSERT`, `UPDATE`,
  `DELETE`, and `TRUNCATE` for every finalized dataset-content table.
- Application guards for every existing repository dataset mutation and for
  the mutable history and pre-PR15.5D run routes when the protected research
  database is configured.

## Synthetic proof fixture

The committed fixture is synthetic test data, not approved market data and not
a research-ready dataset:

- provenance: `synthetic-es-fixture-v1`;
- time range: `2026-06-01T22:00:00.000Z` through
  `2026-06-01T22:02:00.000Z`;
- contracts: conIds `101` (`ESM6`) and `102` (`ESU6`);
- frozen golden fingerprint:
  `3a3ad79690f7a41c3b1950ccafa4c5d3f2cc6c29da8d7ad7953e22e35d752c1a`.

The PostgreSQL suite proves that the same bundle imported into clean databases
has the same fingerprint, while a candle change or a valid contract-metadata
change produces a different read-back fingerprint.

## Hostile review

Independent review drove correction of:

1. unbounded preflight batch retention;
2. database identity and `search_path` enforcement gaps;
3. incomplete integration coverage for route, repository, transaction, and
   immutability boundaries;
4. aggregation-version and contract-lifecycle validation gaps;
5. wall-clock aggregation that was not CME-session aligned;
6. an empty-state race before exclusive table locking;
7. acceptance of candles after `lastTradeAt`;
8. helper-only route tests and hard-coded read-back identity fields;
9. repeated paginated scans during large-dataset read-back;
10. the missing PostgreSQL proof for contract-metadata fingerprint changes.

After four review rounds and the corresponding regressions, the final
independent hostile review returned `APPROVED` with no unresolved blocker.

## Verification

- `pnpm --filter @ikbr/backtest-engine typecheck` — pass.
- `pnpm --filter @ikbr/backtest-engine test` — pass, 35 tests.
- `pnpm --filter @ikbr/backtest-engine test:integration` — pass, 10 tests
  across the repository and PR15.5C PostgreSQL suites.
- `pnpm typecheck` — pass.
- `pnpm test` — pass.
- `pnpm lint` — pass with no errors; the repository retains three existing
  unused-disable warnings.
- `pnpm build` — pass.
- `pnpm test:integration` — pass: 371 execution-engine tests and 10
  backtest-engine PostgreSQL integration tests.
- `git diff --check` — pass.

No strategy backtest was run because no approved, immutable real ES bundle
exists for this stage.

## Safety and limitations

- No strategy gained futures support and no profile was enabled for ES.
- No Paper or Live execution setting changed.
- No TWS, IB Gateway, `HistoricalClient`, or other broker operation ran.
- The shared mutable `ikbr_trader_backtest` database is not an accepted
  research source or target.
- No licensed real market data is committed.

## Verdict and next permitted step

Data readiness is `INCONCLUSIVE`: the reproducibility foundation is complete,
but there is no approved real immutable ES source bundle with a verified
`provenanceId + fingerprint`.

The next permitted step is to obtain and approve that bundle and import it
into a new, empty, exact research database. Only then may a separate PR15.5D
experiment plan be prepared. Strategy activation, Paper E2E, and live trading
remain blocked.
