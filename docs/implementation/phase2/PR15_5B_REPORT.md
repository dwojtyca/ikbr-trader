# PR15.5B — Futures backtest execution model — IMPLEMENTATION REPORT

Status: complete locally; independent hostile review approved

Date: 2026-09-15

## Outcome

PR15.5B adds a deterministic, fail-closed futures execution model to the
backtest engine without enabling a futures strategy, importing ES data, or
contacting IBKR. Stock behavior remains on its existing execution and
commission path.

## Implemented

- Explicit futures specifications supplied through
  `BACKTEST_FUTURES_SPECS_JSON`; ES is fixed to multiplier `50`, tick `0.25`,
  and positive whole-contract quantities.
- Versioned, injected CME calendar definitions supplied through
  `BACKTEST_FUTURES_CALENDARS_JSON`, with Chicago wall time, Sunday session
  open, maintenance/weekend exclusion, DST behavior, closures, early closes,
  and bounded coverage.
- Integer-tick normalization for limit and stop instructions, adverse
  tick-based slippage for market/stop/roll/expiry/dataset-end fills, and
  per-contract-per-side commissions.
- Conservative OHLC ordering: stop wins collisions, same-bar protective stops
  are honored, favorable same-bar exits are suppressed, and stop ratchets take
  effect on the following candle.
- Higher-timeframe completion checks and session-aware FUT `1h`, `4h`, and
  `1d` aggregation. History is isolated by `symbol + conId`.
- Explicit roll/expiry handling: outgoing positions close from the outgoing
  contract, pending intents are cancelled, retired contracts cannot reappear,
  and positions are not transferred or reopened.
- Futures pyramiding fails closed in this model version because collapsing
  multiple entry legs into an average would destroy tick-grid and per-fill
  audit fidelity.
- Additive futures contract metadata and fill-audit persistence. Fills record
  reference/fill prices, multiplier, tick, entry/exit slippage, monetary
  slippage attribution, commission assumptions, entry/exit conIds, model
  version, and calendar version.
- Backtest unit and isolated PostgreSQL integration suites are part of root
  test/CI scripts.

## Hostile review

The independent review initially found and caused correction of:

1. Monday CME sessions incorrectly anchored to Friday instead of Sunday;
2. futures MKT and gap-through STP entries using the wrong reference price;
3. managed/opposite exits losing their reference price and slippage audit;
4. late transitions being labelled roll instead of expiry;
5. futures-spec currency not reaching FX acquisition/preflight;
6. a possible `FILLED` status before FX validation;
7. unauditable same-direction futures averaging;
8. early-close definitions capable of reopening the maintenance break;
9. incomplete audit, STK regression, half-tick, collision, expiry, and
   dataset-end test evidence.

After the corrections and added regressions, the final independent hostile
review returned `APPROVED` with no unresolved blocker.

## Verification

- `pnpm --filter @ikbr/backtest-engine test` — pass, 25 tests.
- `pnpm --filter @ikbr/backtest-engine typecheck` — pass.
- `pnpm --filter @ikbr/backtest-engine build` — pass.
- PostgreSQL integration test against a uniquely named disposable database —
  pass, including idempotent initialization, simulator-produced economics,
  every futures audit field, and fail-before-write validation.
- `pnpm lint` — pass with no errors; the repository retains its existing
  unused-disable warnings.
- `pnpm typecheck` — pass.
- `pnpm test` — pass when run outside the filesystem/network sandbox required
  by the dynamic loopback-port fixture.
- `pnpm test:integration` — pass for execution-engine and backtest-engine.
- `pnpm build` — pass.
- `git diff --check` — pass.

No strategy backtest command was run because PR15.5C has not supplied an
approved, fingerprinted ES dataset.

## Scope and limitations

- No strategy gained `FUT`, `CMDTY`, or `ETF` support.
- No seed, `executionEnabled`, Paper, Live, execution-engine, signal-engine,
  or llm-agent behavior was activated.
- No production calendar or ES contract series is embedded. A futures run
  requires explicit specifications, contract metadata, calendar coverage, and
  FX coverage.
- Pyramiding futures positions is intentionally unsupported in model
  `pr15.5b-v1`.
- PR15.5B does not choose real contract months, roll dates, commission tiers,
  slippage assumptions, or dataset fingerprints.

## Next permitted step

Prepare and approve the separate PR15.5C plan for a reproducible,
fingerprinted ES dataset with explicit contract and calendar metadata. Do not
run the ES compatibility experiment until PR15.5C is complete.
