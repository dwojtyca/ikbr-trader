# Configured strategy instances (PP2)

PP2 applies validated momentum parameters to diagnostic evaluation and independent
binding replay. Every bundle entry remains blocked by
`PP3_EXECUTION_POLICY_UNAVAILABLE`; PP4 research is also unavailable. A signal is
not an admitted proposal or permission to trade. No operational conversion,
deployment, broker submission or paid provider call is part of this delivery.

## Configuration

Use the shared v1 bundle described in [TRADING_CONFIGURATION.md](TRADING_CONFIGURATION.md).
`strategyInstances` declares reusable `momentum_breakout_long_v1` instances with an
ID, positive revision, enabled flag and normalized parameters. Only these three
thresholds are adjustable in PP2:

- `dailyReturn20MinPct`: inclusive 0–100 percent.
- `h1Return4MinPct`: inclusive 0–100 percent.
- `return60MinPct`: inclusive 0–3 percent.

Other parameters retain the committed defaults. Invalid fields, values or references
fail configuration validation. Changing instance content requires a new revision;
reusing the same ID/revision with changed content is rejected. The algorithm ID
stays the implementation ID. Attribution separately records instance ID, revision,
instance hash, effective bundle hash and instrument ID.

Each instrument explicitly assigns instance IDs. `single` requires one assigned
instance for an entry-enabled instrument. `priority` declares 1–100 assigned IDs and
an exact `priorities` mapping with distinct integers from 0 through 1000. The
highest numeric priority among signalling assigned instances wins; a lower-priority
assigned instance may win when higher ones emit no signal. Conflicting directions
or invalid/tied priority metadata reject evaluation. Independent simulator runs do
not represent this priority portfolio.

For bundle state readiness, explicitly set `IBKR_ENVIRONMENT` to `paper` or `live`,
`IBKR_ACCOUNT_ID` to a nonempty trimmed account ID, and include that exact ID in the
matching `ALLOWED_PAPER_ACCOUNTS` or `ALLOWED_LIVE_ACCOUNTS` CSV. Missing account,
invalid environment or the wrong allowlist denies evaluation. Ports, positions and
allowlist order never select the account. These values are not bundle fields and
are not included in the public configuration hash or diagnostic responses. An
explicit Live configuration does not grant Live entry admission.

## Read-only evaluation

With `RUNTIME_ENABLED=true` and bundle configuration, signal-engine registers
`POST /runtime/strategy-evaluation`. The exact request body is:

```json
{"instrumentId":"aapl_nasdaq"}
```

Use an instrument ID present in the loaded bundle. The endpoint accepts no account,
parameter, timestamp, attribution or policy overrides. It returns `signal`,
`no_signal`, `disabled` or `error`, immutable strategy attribution/trigger when a
signal exists, and `entryAllowed:false`. `/runtime/dry-run` retains its existing API.

The production evaluator checks current peer configuration observations, account
scope, conversion readiness and persisted binding safety state before loading the
existing verified session-native strategy context. Configuration drift,
preparation, store failure, unavailable/ambiguous outcomes, missing/stale candles
or quote evidence deny evaluation. The fixed PP3 entry blocker alone does not
prevent computing a diagnostic signal. Trigger evidence comes from trusted market
state, with one minute buckets; caller timestamps cannot select it.

`TRADING_LOOP_ENABLED=true` schedules the same configured evaluator when the runtime
is enabled, including with `EXECUTION_RUNTIME_ENABLED=false`. Its configured branch
never enters execution submission or legacy strategy-state synchronization. With
`TRADING_LOOP_ENABLED=false`, no scheduler starts. The write route
`/runtime/execute` still requires its existing explicit execution-runtime flag and
entry guards.

`GET /configuration` exposes whether the configured runtime is installed and a
safe account readiness flag/reason, without returning the account ID. Matching
peers or successful diagnostic signals do not mean entry readiness.

## Durable state and conversion

Same-algorithm instances on the same account/IBKR contract share the stable safety
state. Logical instrument/instance renames, parameter revisions and bundle hashes
do not reset loss/cooldown/permanent-disable counters. Strategy evaluation objects
remain separate per instrument/instance/revision. Different contracts have separate
binding state; account reservations and day budgets remain stronger limits.

PP2 conversion runs only through the shared disabled-write preparation/store
operation, with peer convergence and the accepted drain checks. Initial conversion
requires explicit `TRADING_ENABLED=false`; missing or invalid switch text does not
prove disabled writes. Unresolved attempted, delivered, unknown or linked close
state prevents conversion. The immutable marker captures inherited counters once
and establishes a future minute cutoff. Readiness retries a blocked conversion
through the same store operation; there is no reset/unblock endpoint.

This delivery tests conversion on disposable fixtures. Do not infer operational
conversion from passing tests. See the accepted
[PP2 contract](../implementation/phase3/PP2_RUNTIME_CONTRACT.md) for the complete
barrier, immutable history and economic-evidence requirements. Existing broker
protection and supported audited close retain their original ownership/policy
identity after current instance removal or disablement.

## Independent replay and read models

`apps/backtest-engine/src/configured-replay.ts` exports `replayConfiguredBindings`.
It accepts a validated bundle, instrument ID, loaded candle dataset, existing
simulator options and backtest repository. It creates a separate isolated run per
assigned instance, filters the matching symbol, checks every matching
candle's conId and uses a fresh configured strategy factory. Missing candles,
ambiguous configured symbols, disabled assignments or mismatched contract rows reject the replay.

Each result labels itself `independent_binding_replay` and contains original
attribution, raw signals, complete orders/fills and simulator metrics. The run's
existing `config_json` stores attribution, normalized instance and contract metadata.
Run/report read models expose the saved attribution. No sum of these independent
P&L/equity results is a portfolio backtest. This helper does not add a new production
backtest HTTP endpoint or change existing backtest controls.

Deterministic fixture validation is available without database or provider calls:

```sh
pnpm --filter @ikbr/backtest-engine exec node --import tsx --test src/configured-replay.test.ts src/configured-replay-read-model.test.ts
```

The fixture compares nonempty default signals, full orders/fills and P&L with the
legacy factory using identical data/options, and proves distinct parameter instances
produce separately attributed results. Runtime context parity and priority tests
cover the configured evaluator; this does not claim legacy simulator data loading
is identical to the live session-native loader.

Existing order details, backtest run choices and report trade rows show algorithm,
instance, revision and shortened immutable hashes. Historical absence displays
`Legacy · attribution unavailable`. The UI does not infer the latest assignment or
provide new trading controls. Malformed persisted attribution fails explicitly.
