# General strategy-only backtest engine

Updated: 2026-11-02. Status: independent scope and final document reviews accepted.
No implementation or
operational change is authorized by this document alone.
Planning baseline: `a8c22e196ed631f4b38d1f18b50e02cad68eef6d` on main, with
unrelated local changes. Recheck HEAD and the dirty-file inventory before work.

## Owner-selected outcome

Build one general engine for evaluating registered technical strategies on
compatible historical instruments, using the same strategy and indicator code
as the bot. PKO and AAPL are initial validation examples, never an instrument
allowlist or architectural restriction. Select instruments, strategy instances,
validated parameters, timeframes and evaluation intervals through research
configuration. Evaluate
each instrument/strategy instance independently. The immediate result is a
chronological signal report, including why a strategy produced no signal and
where the data cannot support evaluation.

No AI, news, LLM calls, paid providers, broker connections, proposals or broker
writes belong to this path. This does not bypass the bot's mandatory AI or risk
gates: an offline signal has no execution authority. No changes to Paper entry,
exit, account, reservation, recovery, session-deadline or deployment policies.
The owner's preference for no compulsory session-end close applies to the future
research simulator; it does not silently alter current Paper lifecycle controls.

Signal evaluation comes first. Positions, fills, costs and P&L remain an optional
later package. No AI, new strategy implementation, live short activation, shared
portfolio, automated parameter search or Go/Rust rewrite in this delivery.
Existing registered LONG and SHORT signal implementations are eligible according
to their declared capabilities, regardless of whether the bot currently enables
them. Research selection never changes production activation or broker permissions.

## General architecture and extension contract

- **Research run configuration:** explicitly selects dataset version, full
  instrument identities, strategy implementation IDs, instance IDs/revisions,
  validated parameters, requested directions, evaluation interval and timeframes.
  Run each selected compatible instrument/instance pair independently; selection
  must not silently mean every possible combination. Record effective parameters,
  code/data versions and the planned pair matrix in the result.
- **Instrument/data adapters:** supply canonical candles, provenance, contract
  metadata, session calendars, timezone, currency, price increments and supported
  timeframes. Stable instrument identity is not just a ticker. The first adapter
  handles stock history from the operational database; the engine/manifest must
  not hardcode PKO, AAPL, WSE, Nasdaq or a two-instrument limit. Adding a supported
  stock requires only metadata/configuration/data, not engine edits.
- **Strategy registry:** reuse the existing Strategy interface and implementations.
  Each research registration declares supported instrument types/directions,
  required timeframes, warmup/context requirements and a validated parameter
  schema/factory. Adding a strategy extends its implementation and registration,
  not the replay loop. No copied formulas, parallel activation list or dependency
  on production entryEnabled, enabledInBot, accounts or live bindings.
- **Replay core:** one historical clock, closed-bar visibility, context assembly
  and deterministic evaluation loop for compatible pairs. Indicators/regime
  calculation and single-strategy eligibility use shared functions. Requirements
  derive from the selected strategies and shared calculation dependencies, not
  a global momentum-specific minimum or timeframe list.
- **Results:** a common event/report format retains instrument identity, strategy
  instance, parameters, direction, evaluation/input times, signals and reasons.
  Unsupported combinations fail preflight explicitly; missing observations are
  unavailable coverage, not no_signal. Compare signal counts/coverage per pair
  without presenting independent results as a portfolio or profitability ranking.

The existing createStrategy registry contains multiple implementations, while
createConfiguredStrategy/TradingConfigurationV1 currently support parameterized
long momentum only. A research configuration and validated factory adapter for
other registrations are planned gaps, not capabilities already delivered. Reuse
normalization for supported parameters; fixed-default strategies must reject
unsupported overrides instead of silently ignoring them. Preserve the production
configuration API and its narrower activation policy.

Generality does not claim immediate support for every asset class. The first
source/session adapter supports stocks; futures require explicit expiry/contract
and roll semantics, and options require their own metadata/context support.
Unsupported classes are rejected before evaluation. Extend adapters and capability
registrations without embedding asset-specific conditions in the replay loop or
replacing the existing ES research pipeline.

## Evidence and existing seams

- [Configured replay](../../../apps/backtest-engine/src/configured-replay.ts)
  separates instances but uses the legacy simulator context. Preserve its API;
  its parity tests do not prove today's runtime parity. See
  [strategy instances](../../runbooks/STRATEGY_INSTANCES.md).
- [Configured runtime](../../../apps/signal-engine/src/runtime/strategy/configured-strategy-runtime.ts)
  additionally checks account/safety state, priority selection and trusted quote
  triggers. Do not fake those dependencies to claim full-bot replay.
- Reuse [computeIndicatorsForContext](../../../apps/signal-engine/src/runtime/strategy/indicators.ts),
  [detectRegimeForContext](../../../apps/signal-engine/src/runtime/strategy/regime.ts),
  [strategy factories](../../../apps/signal-engine/src/strategies/strategy-registry.ts),
  and [StrategyPortfolioManager](../../../apps/signal-engine/src/portfolio/strategy-portfolio-manager.ts).
  Its single-strategy use preserves regime eligibility and rejection reasons.
  [StrategyContextLoader](../../../apps/signal-engine/src/runtime/strategy/strategy-context-loader.ts)
  supplies the reference candle windows/minima and current context semantics.
- [Shared session functions](../../../packages/shared/src/instrument-sessions.ts)
  provide identities, validation and candle slots. Never invent/backdate runtime
  `READY`, generation or acquisition timestamps, or relabel candle source strings.
- The [research manifest](../../../apps/backtest-engine/src/research-dataset-schema.ts),
  [importer](../../../apps/backtest-engine/src/research-dataset-importer.ts) and
  [registered loader](../../../apps/backtest-engine/src/research-dataset-loader.ts)
  are ES/CME-specific. Preserve their contracts; reuse provenance/read-back
  principles, not ES literals, fixed database or experiment identity for stocks.
- Operational storage currently exposes candle OHLCV/source, contract records
  and current schedules through the [signal repository](../../../apps/signal-engine/src/repository.ts).
  Current schedules do not prove historical coverage; bar timestamps do not prove
  original publication times. The audit export omitted recorded candle sources.

The local audit `.local/backtest-audit-20261031/report.txt` recorded 13,976 PKO
and 14,553 AAPL minute candles, with gaps of approximately 74.68 and 140.92 days.
Its copy from the operational database measured legacy simulator speed, not
profitability or runtime parity. These dated observations must be rechecked;
private audit files are not a verified dataset or publication scope.

## Delivery sequence and acceptance boundaries

| Package | Deliverable | Acceptance boundary |
| --- | --- | --- |
| S1 — first implementation | Generic history bundle/readiness CLI; first stock source adapter | Repeatable, isolated input; exact gaps and unavailable metadata; no strategy evaluation yet |
| S2 — following package | Generic signal-only CLI, registry/configuration and common strategy code | Closed-bar chronology, independent instances, parity fixtures, honest evaluable coverage |
| S3 — optional later | Simulated position/fill evaluation | Separate fill/cost/overnight contract; never required to finish S2 |

S1 is the next bounded implementation package. Finalize and review its research
configuration/manifest schema before coding; documentation acceptance is not
implementation acceptance. S2 needs a reviewed context/time contract after S1 exposes actual coverage. A truthful
blocked report can complete S1, but not the owner's signal-evaluation outcome.

## S1 — bounded implementation packet

### Inputs and operator path

Add a file-first CLI without service entrypoints, global operational configuration,
simulator, broker client or ES importer. Proposed commands, not yet implemented:

```sh
pnpm --filter @ikbr/backtest-engine exec tsx src/history-dataset-cli.ts export \
  --adapter operational-stocks --configuration /absolute/private/research-run.json \
  --instrument-id pko_wse --instrument-id aapl_nasdaq \
  --from 2026-04-01T00:00:00.000Z --to 2026-10-31T00:00:00.000Z \
  --out /absolute/private/history-dataset-snapshot
pnpm --filter @ikbr/backtest-engine exec tsx src/history-dataset-cli.ts inspect \
  --bundle /absolute/private/history-dataset-snapshot \
  --out /absolute/private/history-dataset-report
```

IDs are examples, not a fixed selection; resolve any supplied compatible identities
from validated research configuration. Do not require a deployed trading bundle.
`export` reads only
explicit `HISTORY_SOURCE_POSTGRES_URL` from the environment, with no default
DB, `.env` discovery, admin URL or fallback. `inspect` is offline. UTC ranges are
half-open `[from,to)`; include prehistory for warmup explicitly. Reject invalid
ranges, duplicate/unknown instrument IDs and existing output destinations.

The first operational-stocks adapter reads selected stock identities and existing
`1m`, `5m`, `1h`, `4h`, `1d`, `1w` rows; legacy `12h` is reported unsupported
by this adapter. The generic format does not globally forbid it;
a future adapter must establish its boundaries and semantics before use. No
historical acquisition or aggregation occurs in S1.
The supplied configuration is the research configuration, not a claim that those
parameters were deployed throughout the historical period.

### Isolation and storage

Use one `REPEATABLE READ READ ONLY` transaction, verify read-only status and use
allowlisted SELECTs with bound identities/ranges and finite timeouts. No repository
initialization, migrations, writes, resets or DB creation. Exclude account, position,
order, AI and secret tables; always close the connection.

Copy minimal candles and allowlisted contract/session metadata, not unrestricted
`details_json` or provider payloads. Detect optional metadata availability before
querying; missing metadata is explicit. Query failure or missing candle relations
prevents finalization, never becomes empty success in an aborted transaction.

The isolated copy is a private filesystem bundle; no backtest DB import is needed.
Export bounded cursor batches to a unique temporary sibling; finalize after
read-back validation and transaction completion. Never replace existing output;
failure leaves no finalized manifest. Cleanup touches only newly created temporary
output. Integration fixtures use disposable PostgreSQL, never the operational DB.

### Bundle and report contract

Versioned instrument-neutral manifest with adapter/schema identifiers: export
time, requested range, selected contract identities,
normalized research configuration/instance identity, known revision, file hashes/counts and
`operational_history_snapshot` provenance. Unknown revision stays unknown. Exclude
DSNs, secrets, account IDs and environment dumps from files/diagnostics.

Order candles by `(instrumentId,timeframe,ts)`; preserve source contract identity
(conId for the IBKR adapter) without requiring every source to be IBKR; retain
symbol, timestamp, OHLCV and source.
Unknown metadata stays unknown: no default native/adjusted/RTH/timezone provenance.
Preserve session status, generation, identity, coverage and acquisition timestamps.
Present contract/configuration identity is not historical validity evidence.

Validate hashes/counts, finite numbers, OHLC, timestamps, unique keys and contract
identity. Preserve unknown volume, including sentinel semantics. Missing provenance
or coverage is a readiness blocker, distinct from corruption and `no_signal`.

Polish text and JSON report counts, first/last timestamps, sources, observed dates,
raw gaps, metadata and warmup counts per instrument/timeframe. Enumerate expected
slots only inside validated session coverage using shared functions; outside it
report `session_coverage_unavailable`, not guessed weekdays or coverage percentages.
Unknown adjustment/corporate-action policy and publication timing remain unknown.

Readiness is `ready_for_signal_contract`, `partial` or `blocked`, with supported
coverage and reasons; it does not certify signals or trading. Exit 0 means a report
was produced, even if blocked. Usage/integrity/I/O failure exits nonzero. No P&L,
win rate, ranking or strategy-quality conclusion.

### Owned files and checks

S1 may add only:

- `apps/backtest-engine/src/research-run-config.ts`
- `apps/backtest-engine/src/research-strategy-catalog.ts`
- `apps/backtest-engine/src/history-dataset-types.ts`
- `apps/backtest-engine/src/history-operational-stocks-adapter.ts`
- `apps/backtest-engine/src/history-dataset-cli.ts`
- `apps/backtest-engine/src/history-dataset-snapshot.ts`
- `apps/backtest-engine/src/history-dataset-readiness.ts`
- corresponding config/catalog/adapter unit tests, `history-dataset-*.test.ts` and
  `history-dataset-snapshot.pg-integration.test.ts`
- `docs/runbooks/STRATEGY_ONLY_BACKTEST.md` and
  `docs/implementation/phase3/STRATEGY_ONLY_BACKTEST_REPORT.md`.

No package-script change is required by the runnable `pnpm exec tsx` path. Existing
dirty `apps/backtest-engine/package.json`, simulator, ES files, signal-engine,
llm-agent and operational tools are outside S1 ownership. A necessary shared-source
or schema change stops the affected work for a reviewed scope amendment.

Required targeted acceptance:

1. A disposable source with PKO/AAPL, a third fixture stock absent from production
   source branches and unrelated rows exports only requested identities/ranges.
   Adding that third stock changes fixture metadata/configuration only, not engine
   or adapter code. Preserve original metadata in one consistent snapshot.
2. The source connection rejects a test write; database content/schema before
   and after export is unchanged. Export and inspect make no broker/provider call.
3. Missing schedule/source/adjustment knowledge, partial sessions, holidays and
   DST fixtures produce explicit coverage diagnostics without invented history.
4. Corrupt hashes, mismatched conIds, duplicate keys, malformed OHLC/timestamps,
   unwritable output and interrupted export cannot finalize a valid bundle.
5. Export twice from unchanged fixture data yields identical content hashes;
   export-time envelopes may differ. Repeated inspect results are identical.
6. Reject unsupported asset classes/adapters, ambiguous identities and unknown
   strategy/parameter requirements explicitly; production activation is not a
   research-selection prerequisite.
7. Existing output is preserved. Sanitized connection/query failure diagnostics
   contain no credentials or account data. Files are consumed directly in isolation.

Targeted checks cover history-dataset, research-run-config, research-strategy-catalog
and adapter unit tests, plus their PostgreSQL integration fixtures with isolated
setup; do not let test discovery connect to a default database when no test URL
is provided. Then all mandatory code-delivery gates:
`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` against isolated
PostgreSQL, and `pnpm build`. No deployment change or strategy/simulator behavior
change is in S1, so no new Docker build or trading backtest is required for S1.
Record unrelated baseline failures separately; never silently fix or stage them.

Before S1 coding, record and review the exact predicates for its three readiness
states in the task packet. These classifications must not imply full signal
eligibility before the S2 context contract is accepted.

## S2 — signal evaluation contract to finalize after S1

A terminal command takes the snapshot/configuration, instrument/instance selection,
evaluation range and output directory; writes chronological JSON and Polish text.
No service, UI, operational database or provider. Required contract and acceptance:

- Fresh object per instance/instrument; resolve an explicitly selected registered
  strategy through the shared factory and validated research parameter adapter.
  Reuse indicator/regime functions and single-strategy eligibility. Derive windows
  and timeframes from each strategy and shared context dependencies; add narrow
  exports if necessary, without changing formulas or production activation gates.
- Historical context preserves real session provenance. No fake runtime READY,
  backdated timestamps or relaxed production checks. Retrospective calendars imply
  retrospective technical research, not point-in-time replay of the bot.
- Only bars with session-aware end <= evaluation time enter indicator windows.
  Daily/weekly and short final bars use validated session slots, not fixed UTC
  durations. Immediate availability at close is an explicit modeling assumption
  when publication latency was not recorded. Future rows cannot alter past results.
- Review source compatibility, adjustments, alignment and gap/warmup rules from
  S1 evidence. Missing scheduled bars block affected contexts; no fill-forward,
  fabricated native bars or stitching months-apart minutes into complete history.
- Flat position quantity zero means independent entry opportunities. No holdings,
  financial cooldown/loss state or synthetic quotes. Retain repeated signals;
  absent required quote information blocks evaluation, never creates a fake trigger.
- Events distinguish signal, no_signal, unavailable and error; retain reasons,
  raw signals, indicators, input cutoff and attribution. No P&L conclusions.
- Test PKO/AAPL plus a third metadata-only fixture instrument and at least two
  distinct existing strategy implementations (not merely two momentum parameter
  sets), including a declared SHORT signal path if compatible. Test a strategy
  disabled for bot activation but explicitly selected for offline research.
  Include nonempty signals/rejections, distinct parameter instances and exact
  direct-call parity, DST/session/warmup/partial-bar/gap boundaries, future-row
  mutation invariance, repeatability and no broker/provider/write side effects.
  Confirm unsupported instrument/timeframe/quote/parameter combinations fail
  explicitly. Future additions through adapter/registry contracts must not require
  replay-loop changes. Partial real history remains partial even if a subset evaluates.

## S3 — future simulation boundary

A separate owner-selected reviewed package would define positions, sizing, fills,
gap prices, TP/SL ambiguity, fees, slippage and corporate actions. No compulsory
session-end liquidation; report open exposure at dataset end without manufacturing
closing fills. No P&L for unverifiable periods or pooled independent results.
Current Paper exit policy remains unchanged.

## Review, publication and model routing

This turn is documentation only: independent Astra/high plan review, different
independent document reviewer, local source/link/diff validation, scoped main
commit/push and exact-commit CI. No unchanged runtime suites solely for prose.
Follow [AGENTS.md](../../../AGENTS.md), [roadmap](../ROADMAP.md) and
[routing guide](MODEL_ROUTING_GUIDE.md); preserve all unrelated local work.

S1/S2 identity, time, isolation and parity semantics use Astra/high, with different
independent Astra/high plan and hostile implementation reviewers. Pure formatting
may use Luna/medium under accepted semantics; mechanical work requests GPT-5.6-Luna
low with a disclosed available fallback. Stop for ambiguous metadata, scope
expansion, DB writes, formula/guard changes or provider acquisition; amend/review
before proceeding. Reports record requested/actual models, effort, elapsed time,
repairs, findings and available token usage; unavailable telemetry stays unavailable.
