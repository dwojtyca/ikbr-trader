# Strategy-only backtest planning report

Initial plan: 2026-10-31. Amended: 2026-11-02.
Status: amendment scope and final wording reviews accepted; publication/CI pending.
Original publication: `a8c22e1`, [CI passed](https://github.com/dwojtyca/ikbr-trader/actions/runs/41209539923). This is historical evidence, not CI for the amendment.

## Owner-selected outcome

The owner narrowed the proposed backtester to technical strategies generating
signals: no AI adjudication, news, research providers or LLM calls. On 2026-11-02
the owner corrected the instrument/strategy scope: a general engine for different
registered strategies and compatible instruments. PKO/AAPL are initial examples,
not an allowlist; momentum is not the only eligible research strategy. Reuse strategy
implementations and indicator/regime computation from the bot. No new strategy,
Paper activation or operational exit-policy change belongs to this planning task.

This delivery prepares the [implementation plan](STRATEGY_ONLY_BACKTEST_PLAN.md).
It does not implement the future commands, populate the backtest database or
retrieve missing broker history. The earlier instruction to plan before runtime
implementation remains the boundary of this documentation package.

## Evidence used

Source baseline: `4727ed84d576a02c501fe7cf07819b8ff6b2ad34`.
The workspace contains unrelated unpublished work; none belongs to this package.

The preceding local audit measured the release image on copied operational data,
not on the dirty working-tree runtime. Median simulator time with an isolated
PostgreSQL repository was 4.738 s for 13,976 PKO minute bars and 4.872 s for 14,553
AAPL minute bars, three measured runs each after warmup. The native-currency,
independent runs used benchmark risk/cost options, not current Paper sizing.
Historical gaps make these performance samples unsuitable for profitability
claims. The measured result does not establish full-year performance or parity
with Paper. Raw data and harnesses remain local; no account/configuration export
is included in this publication.

Source inspection confirms:

- [configured replay](../../../apps/backtest-engine/src/configured-replay.ts)
  reuses strategy factories but runs the older simulator/SignalEngine path.
- [runtime indicators](../../../apps/signal-engine/src/runtime/strategy/indicators.ts)
  and [regime computation](../../../apps/signal-engine/src/runtime/strategy/regime.ts)
  are reusable pure calculation seams.
- [context loading](../../../apps/signal-engine/src/runtime/strategy/strategy-context-loader.ts)
  includes current broker/session/quote evidence checks. Historical replay must
  not falsify timestamps or relax those production checks.
- [ingestion persistence](../../../apps/ingestion/src/db.ts) retains candle source,
  contract metadata and current session-schedule evidence. A plain OHLCV export
  loses useful provenance; current schedule evidence is not automatically a
  complete historical calendar.
- [research dataset schema](../../../apps/backtest-engine/src/research-dataset-schema.ts)
  is ES/CME-specific. Reusing its importer for equities without a separate contract
  would be incorrect; preserve the existing ES work.

## Validation and publication

Only the amended plan and this report are in the publication scope. Validate local
Markdown links, check whitespace/diff and obtain independent plan and final
review. No local runtime suite is required for prose-only changes. Per repository
workflow, publish the reviewed documentation on main and verify GitHub CI for
that exact commit. Publication/CI evidence will be reported separately from
future implementation acceptance.

## Original 2026-10-31 review and routing record

| Task | Requested model / effort | Evidence | Repairs / escalation | Usage |
| --- | --- | --- | --- | --- |
| Plan author | gpt-6-astra / high | Contract authored; no runtime edits | 0 / 0 | Tokens/elapsed unavailable |
| Lead evidence/report | Current lead session | Source inspection and prior audit | 0 / 0 | Per-task telemetry unavailable |
| Independent plan review | gpt-6-astra / high | ACCEPT; no material findings | 0 / 0 | Tokens/elapsed unavailable |
| Independent final document review | gpt-6-astra / high | ACCEPT; no material findings | 0 / 0 | Tokens/elapsed unavailable |

Model IDs/efforts identify dispatched settings, not independent verification of
underlying model execution. Per-task elapsed time and tokens are unavailable
unless explicitly returned by the tool. No savings or quality inference is made.

Plan reviewer accepted the scope, source claims, temporal boundaries and isolated
data reuse path. Exact S1 readiness predicates and the S2 historical context/quote
contract must be fixed in reviewed implementation packets before their code is
written. This planning acceptance does not claim those packages are implemented.

Final reviewer (different from author and plan reviewer) accepted both documents.
Local validation found no broken relative links or trailing whitespace. Only these
two Markdown files were selected for the original publication. Mechanical publication uses
the lead fallback: the requested GPT-5.6-Luna route is unavailable in this session.
Exact-commit CI status is reported in the chat after publication; pending here
avoids recording a CI result before its commit exists.

## 2026-11-02 general-engine amendment

Bounded documentation change: revise the title, outcome, architecture, proposed
CLI/configuration, neutral manifest, file ownership and acceptance consistently.
The stock database export becomes the first input adapter, not the engine's asset
or ticker definition. Future research configuration is independent of production
entry flags and the momentum-only TradingConfigurationV1 factory. Reuse existing
strategy code with validated parameter/capability registrations; no formulas or
live controls are changed. No runtime, database or operational changes in this task.

Acceptance now requires a third stock configured solely through metadata/data and
at least two distinct existing strategy implementations, explicit unsupported
capabilities and preserved no-lookahead/parity evidence. Full futures/options
support is not claimed; adapter support must precede those runs. The current shared
registry is broader than its configured factory, so a validated research factory
adapter is an explicit implementation gap.

Amendment scope review: independent gpt-6-astra/high accepted; no material findings.
Final amended-document review: independent gpt-6-astra/high accepted; no material
findings, no repair rounds. Relative links and scoped whitespace checks passed.
Exact-commit publication CI is checked separately and reported in the chat. Lead authors the amendment; independent
final reviewer differs from the scope reviewer. Model execution identity and
per-task tokens/elapsed telemetry unavailable; no runtime suites run locally for
prose-only edits. Mechanical publication uses the lead fallback because the
configured GPT-5.6-Luna route is unavailable in this session.
