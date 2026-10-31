# Strategy-only historical evaluation for PKO and AAPL

Date: 2026-10-31. Status: PLAN REVIEW ACCEPTED; no implementation or
operational change is authorized by this document alone.
Planning baseline: `4727ed84d576a02c501fe7cf07819b8ff6b2ad34` on main, with
unrelated local changes. Recheck HEAD and the dirty-file inventory before work.

## Owner-selected outcome

Evaluate existing technical strategies on historical PKO and AAPL data, using
the same strategy and indicator implementations as the configured bot. Evaluate
each instrument/strategy instance independently. The immediate result is a
chronological signal report, including why a strategy produced no signal and
where the data cannot support evaluation.

No AI, news, LLM calls, paid providers, broker connections, proposals or broker
writes belong to this path. This does not bypass the bot's mandatory AI or risk
gates: an offline signal has no execution authority. No changes to Paper entry,
exit, account, reservation, recovery, session-deadline or deployment policies.
The owner's preference for no compulsory session-end close applies to the future
research simulator; it does not silently alter current Paper lifecycle controls.

Signal evaluation comes first. Simulated orders, positions, fills, costs and P&L
are a possible later package, with its own accepted contract. There is no shared
portfolio, strategy competition, FX aggregation, new strategy, short activation,
parameter optimization or Go/Rust rewrite in this delivery. The current configured
factory supports `momentum_breakout_long_v1`; existing configured instances and
parameters are the first subjects. Other registry implementations need a separate
scope decision, rather than being enabled implicitly.

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
| S1 — first implementation | Offline stock snapshot/export and readiness CLI | Repeatable, isolated input; exact gaps and unavailable metadata; no strategy evaluation yet |
| S2 — following package | Signal-only CLI using common strategy/indicator code | Closed-bar chronology, independent instances, parity fixtures, honest evaluable coverage |
| S3 — optional later | Simulated position/fill evaluation | Separate fill/cost/overnight contract; never required to finish S2 |

S1 is the next bounded implementation after review and owner authorization. S2
needs a reviewed context/time contract after S1 exposes actual coverage. A truthful
blocked report can complete S1, but not the owner's signal-evaluation outcome.

## S1 — bounded implementation packet

### Inputs and operator path

Add a file-first CLI without service entrypoints, global operational configuration,
simulator, broker client or ES importer. Proposed commands, not yet implemented:

```sh
pnpm --filter @ikbr/backtest-engine exec tsx src/stock-history-cli.ts export \
  --configuration /absolute/private/trading-configuration.json \
  --instrument-id pko_wse --instrument-id aapl_nasdaq \
  --from 2026-04-01T00:00:00.000Z --to 2026-10-31T00:00:00.000Z \
  --out /absolute/private/stock-history-snapshot
pnpm --filter @ikbr/backtest-engine exec tsx src/stock-history-cli.ts inspect \
  --bundle /absolute/private/stock-history-snapshot \
  --out /absolute/private/stock-history-report
```

IDs are examples; resolve them from the validated bundle. `export` reads only
explicit `STOCK_HISTORY_SOURCE_POSTGRES_URL` from the environment, with no default
DB, `.env` discovery, admin URL or fallback. `inspect` is offline. UTC ranges are
half-open `[from,to)`; include prehistory for warmup explicitly. Reject invalid
ranges, duplicate/unknown instrument IDs and existing output destinations.

Snapshot export reads selected configured stock contract identities and existing
`1m`, `5m`, `1h`, `4h`, `1d`, `1w` rows; legacy `12h` is reported unsupported and
is not an input to this path. No historical acquisition or aggregation occurs.
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

Versioned stock manifest: export time, requested range, selected contract identities,
normalized research config/attribution, known revision, file byte hashes/counts and
`operational_history_snapshot` provenance. Unknown revision stays unknown. Exclude
DSNs, secrets, account IDs and environment dumps from files/diagnostics.

Order candles by `(conId,timeframe,ts)`; retain symbol, timestamp, OHLCV and source.
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

- `apps/backtest-engine/src/stock-history-cli.ts`
- `apps/backtest-engine/src/stock-history-snapshot.ts`
- `apps/backtest-engine/src/stock-history-readiness.ts`
- corresponding `stock-history-*.test.ts` and
  `stock-history-snapshot.pg-integration.test.ts`
- `docs/runbooks/STRATEGY_ONLY_BACKTEST.md` and
  `docs/implementation/phase3/STRATEGY_ONLY_BACKTEST_REPORT.md`.

No package-script change is required by the runnable `pnpm exec tsx` path. Existing
dirty `apps/backtest-engine/package.json`, simulator, ES files, signal-engine,
llm-agent and operational tools are outside S1 ownership. A necessary shared-source
or schema change stops the affected work for a reviewed scope amendment.

Required targeted acceptance:

1. A disposable source with PKO/AAPL plus unrelated rows exports only requested
   identities/time range, in one consistent snapshot, with original metadata.
2. The source connection rejects a test write; database content/schema before
   and after export is unchanged. Export and inspect make no broker/provider call.
3. Missing schedule/source/adjustment knowledge, partial sessions, holidays and
   DST fixtures produce explicit coverage diagnostics without invented history.
4. Corrupt hashes, mismatched conIds, duplicate keys, malformed OHLC/timestamps,
   unwritable output and interrupted export cannot finalize a valid bundle.
5. Export twice from unchanged fixture data yields identical content hashes;
   export-time envelopes may differ. Repeated inspect results are identical.
6. Existing output is preserved. Sanitized connection/query failure diagnostics
   contain no credentials or account data. Files are consumed directly in isolation.

Targeted commands: `pnpm --filter @ikbr/backtest-engine exec node --import tsx
--test src/stock-history-*.test.ts` with repository-standard isolated PostgreSQL
setup for the integration fixture; do not let the broad glob connect to a default
database when no test URL is provided. Then all mandatory code-delivery gates:
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

- Fresh object per instance/instrument; reuse configured factory, attribution,
  indicator/regime functions and single-strategy portfolio evaluation. Reuse bot
  windows/timeframes; add narrow exports if necessary, without changing formulas.
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
- Test both instruments, nonempty signals/rejections, separate instances, exact
  direct-call parity, DST/session/warmup/partial-bar/gap boundaries, future-row
  mutation invariance, repeatability and no broker/provider/write side effects.
  Partial real history remains partial even if a useful subset evaluates.

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
