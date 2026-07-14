# Trading Pipeline — Skeleton (PR11)

> Status: **Phase 2, first runtime orchestrator.** This document
> describes the `packages/shared/src/trading-pipeline/` module
> introduced in PR11. The pipeline is entirely deterministic and
> composes two existing shared engines — `SignalEngine` and
> `ExecutionTicketBuilder` — into a single runtime result. It does
> NOT submit orders, does NOT talk to IBKR, does NOT write to
> Postgres, does NOT open any socket, and does NOT touch
> `execution-engine`, `apps/signal-engine`, `llm-agent` or `ui`.
> Consumer migration and I/O wiring are deferred to
> [PHASE_2_ROADMAP.md](../implementation/phase2/PHASE_2_ROADMAP.md)
> PR12 (Market Data Runtime) and PR13 (Execution Runtime).

## Purpose

Given a `MarketContextSnapshot`, an `Instrument`, and an
`ExecutionTicketPolicy`, run the pipeline:

```
MarketContextSnapshot
        │
        ▼
SignalEngine.evaluate(snapshot)          → SignalEvaluation
        │  (contains Decision + Risk)
        ▼  if status === "GENERATED"
ExecutionTicketBuilder.build({
  signal, snapshot, instrument, policy,
})                                       → ExecutionTicketBuildResult
        │
        ▼
TradingPipelineResult
```

`TradingPipeline` is a pure function of its inputs plus the
injected engines and clocks — no I/O, no randomness (id / duration
sources are injected), no HTTP, no persistence.

## Public API

```ts
class TradingPipeline {
  constructor(options: TradingPipelineOptions);
  run(
    snapshot: MarketContextSnapshot,
    instrument: Instrument,
    policy: ExecutionTicketPolicy,
  ): TradingPipelineResult;
}

interface TradingPipelineOptions {
  readonly signalEngine: SignalEngineLike;
  readonly ticketBuilder: ExecutionTicketBuilderLike;
  readonly now?: () => Date; // default: () => new Date()
  readonly performanceNow?: () => number; // default: () => performance.now()
  readonly version?: string; // default: TRADING_PIPELINE_VERSION
}
```

`SignalEngineLike` and `ExecutionTicketBuilderLike` are structural
ports (`{ evaluate }` / `{ build }`) — the pipeline never depends on
the full options surface of the concrete classes, which keeps unit
tests small and prevents accidental coupling.

## Non-goals (PR11)

The pipeline explicitly does **not**:

- talk to `execution-engine`, IBKR or any broker,
- send anything over HTTP,
- persist to Postgres, Redis, or `proposed_orders`,
- read market data from ingestion,
- call any LLM / external API,
- schedule its own runs (no cron, no candle-close subscription),
- re-implement Decision or Risk logic — those live inside
  `SignalEngine`.

## Outcomes

Every `run()` invocation returns a discriminated union tagged by
`outcome`:

- **`SUCCESS`** — signal was `GENERATED` and the ticket builder
  returned `{ ok: true }`. Carries `signal`, `ticket`, `warnings`,
  `durationMs`, `metadata`.
- **`NO_TRADE`** — signal reached a valid terminal state that
  intentionally means "do nothing" (currently `HOLD`). Carries
  `signal`, `ticket: null`, `reason: "HOLD"`, `warnings`,
  `durationMs`, `metadata`. **This is not a failure**: no
  `failedStage`, no `blockers`.
- **`FAILURE`** — signal was `BLOCKED` / `REJECTED` / `ERROR`, the
  ticket builder returned `{ ok: false }`, or an engine threw
  (mapped to `UNKNOWN`). Carries `signal | null`, `ticket: null`,
  `failedStage`, `blockers`, `warnings`, `durationMs`, `metadata`.

## Pipeline stages

1. **Signal.** `signalEngine.evaluate(snapshot)` inside a `try /
catch`. Any thrown exception (which the signal engine is
   contracted not to raise) becomes a `PIPELINE_SIGNAL_STAGE_THREW`
   blocker with `outcome: "FAILURE"`, `failedStage: "UNKNOWN"` and
   `signal: null`.
2. **Terminal-status branch.**
   - `HOLD` → `outcome: "NO_TRADE"`, no ticket builder call.
   - `BLOCKED` / `REJECTED` / `ERROR` → `outcome: "FAILURE"` with
     `failedStage` derived from the status (and, for `ERROR`, the
     first warning's source). No ticket builder call.
3. **Ticket.** `ticketBuilder.build({ signal, snapshot, instrument,
policy })` inside a `try / catch`. Exceptions become
   `PIPELINE_TICKET_STAGE_THREW` with `failedStage: "UNKNOWN"`.
4. **Ticket result branch.**
   - `ticket.ok === true` → `outcome: "SUCCESS"`.
   - `ticket.ok === false` → `outcome: "FAILURE"`,
     `failedStage: "TICKET"`, one pipeline blocker per ticket
     blocker (stamped `stage: "TICKET"`).

Warnings from both stages are concatenated (signal warnings first,
then ticket warnings) and surfaced on all outcomes.

## `failedStage` derivation (FAILURE only)

The pipeline maps signal status + warning source to
`TradingPipelineFailedStage` using the rules below. This is the
only place where the pipeline "interprets" upstream state — it
never re-scores or re-validates.

| Signal `status` | Warning `source` (first)                       | Outcome                | `failedStage`                     |
| --------------- | ---------------------------------------------- | ---------------------- | --------------------------------- |
| `HOLD`          | —                                              | `NO_TRADE`             | — (not a failure)                 |
| `BLOCKED`       | —                                              | `FAILURE`              | `DECISION`                        |
| `REJECTED`      | —                                              | `FAILURE`              | `RISK`                            |
| `ERROR`         | `decision-engine`                              | `FAILURE`              | `DECISION`                        |
| `ERROR`         | `risk-engine`                                  | `FAILURE`              | `RISK`                            |
| `ERROR`         | `signal-engine` / `instrument-registry` / none | `FAILURE`              | `SIGNAL`                          |
| `GENERATED`     | (ticket stage)                                 | `SUCCESS` or `FAILURE` | `TICKET` if `ticket.ok === false` |
| (thrown)        | —                                              | `FAILURE`              | `UNKNOWN`                         |

## `blockers` policy

Pipeline `blockers` are **never** copied from Decision Engine or
Risk Engine output. For `DECISION`, `RISK` and `SIGNAL` failures
the `blockers` array is empty; consumers read authoritative
diagnostics directly from the `SignalEvaluation`:

- `signal.decision?.blockedBy` for decision-engine blockers,
- `signal.risk?.blockers` for risk-engine blockers,
- `signal.warnings` for `ERROR` context.

Pipeline blockers exist **only** for:

| `failedStage` | Blockers                                                                    |
| ------------- | --------------------------------------------------------------------------- |
| `TICKET`      | One per `ticket.blockers`, stamped `stage: "TICKET"`.                       |
| `UNKNOWN`     | Single synthetic `PIPELINE_*_STAGE_THREW` blocker quoting the caught error. |

## Error isolation

No exception leaves `run()`. Defence-in-depth applies to every
code path, not just the two engine calls:

1. **Clocks are read defensively.** Injected `now` and
   `performanceNow` are consulted through `safeNow` /
   `safePerformanceNow`. A clock that throws or returns an
   invalid value (`NaN` `Date`, non-finite number) is captured
   once and MUST NOT be re-invoked while assembling the result.
   Fallbacks: `ranAt = new Date(0)`, `durationMs = 0`.
   `performanceNow` is called **at most twice per `run()`** (start
   - end); the computed `durationMs` is memoized so any later
     `measureDuration()` call — including the one in the top-level
     catch — reuses the cached value without touching the clock
     again.
2. **Engine calls.** `SignalEngine.evaluate` and
   `ExecutionTicketBuilder.build` are wrapped by
   `runSignalStep` / `runTicketStep`. Non-`Error` throws are
   stringified via `JSON.stringify` (with a `try / catch`
   fallback) to avoid `[object Object]` leaks.
3. **Diagnostic reads.** Every read from the signal / ticket
   result that could trigger a hostile getter (warning arrays,
   metadata versions, ticket builder version, ticket blockers on
   the `!ok` path) is wrapped in `trySafe` with a benign
   fallback (`[]`, `undefined`).
4. **Control-flow reads.** `signal.status` and `ticketResult.ok`
   are read directly. A hostile getter on these fields is
   unrecoverable — the pipeline cannot classify without them —
   so the throw propagates to the top-level catch (see #6).
5. **Duration captured before description.** Branches whose
   blocker literal calls `describeUnknownError(...)` (which
   reads `error.message`, potentially throwing for hostile
   Error-like objects) capture `measureDuration()` into a local
   variable BEFORE the description runs. That way, if the
   description throws, the top-level catch inherits the memoized
   duration through the cache.
6. **Top-level catch.** The entire body of `run()` is wrapped in
   a final `try / catch`. Any unexpected throw (result assembly,
   freeze failure, hostile control-flow getter, hostile
   `.message` getter, etc.) is converted to a
   `PIPELINE_INTERNAL_ERROR` failure — see the shape below. The
   broken clocks are NOT reused; `ranAt` and `durationMs` come
   from the values captured at the top of `run()`.
7. **Deep freeze** is best-effort — see the
   [Immutability](#immutability) section for the precise
   guarantee.

Constructor guards throw eagerly for mis-wired dependencies
(missing `signalEngine.evaluate` or `ticketBuilder.build`). Those
are the ONLY throws that can leave the class.

### `PIPELINE_INTERNAL_ERROR` shape

Emitted by the top-level catch when a non-engine code path throws
(hostile getter, freeze failure, unexpected bug):

```ts
{
  outcome: "FAILURE",
  signal: null,
  ticket: null,
  failedStage: "UNKNOWN",
  blockers: [{
    code: "PIPELINE_INTERNAL_ERROR",
    source: "trading-pipeline",
    stage: "UNKNOWN",
    message: <best-effort error message>,
  }],
  warnings: [],
  durationMs: <safe fallback>,
  metadata: {
    engineVersions: { pipeline: <version> },
    ranAt: <safe fallback or captured value>,
  },
}
```

## Immutability

Freeze is **best-effort**. Every returned `TradingPipelineResult`
is routed through `safeDeepFreezePipelineResult`, which walks the
result graph and calls `Object.freeze` on every reachable node.

The freeze walk can fail in one narrow case: a caller-supplied
runtime object (a hostile `SignalEvaluation`, `ExecutionTicket`,
etc.) exposes a Proxy trap or throwing getter that trips
`Object.values` / `Object.freeze` during the walk. In that case
`safeDeepFreezePipelineResult` swallows the exception and returns
the graph un-frozen rather than propagating — the "no exception
leaves `run()`" contract takes precedence over freeze.

In practice:

- For non-hostile inputs (the only shape produced by the shipped
  `SignalEngine` and `ExecutionTicketBuilder`) every returned
  result — including the `PIPELINE_INTERNAL_ERROR` emergency
  failure — is deep-frozen. Callers may share references without
  defensive copies.
- For hostile / exotic runtime objects, downstream consumers MUST
  NOT rely on freeze as a security boundary. Treat freeze as an
  optimisation for reference-sharing under trusted inputs, not as
  a guarantee.

The `PIPELINE_INTERNAL_ERROR` emergency result is constructed
entirely from primitives, empty literals, and pre-validated
`ranAt` / `durationMs` values — it holds no reference to
caller-supplied signal or ticket objects. In practice its freeze
always succeeds; the best-effort caveat above only exists as
defence against a pathological subclassed `Date` or similar.

The freeze helper is duplicated with `MarketContextBuilder`,
`DecisionEngine`, `RiskEngine`, `SignalEngine`, and
`ExecutionTicketBuilder` on purpose — see the architectural TODO
recorded in each of those modules for the planned extraction into
a shared utility. This PR intentionally does not perform that
refactor: introducing a new module and extracting a shared helper
in the same PR would conflate two changes.

## Determinism

- `now: () => Date` — wall clock. Default `() => new Date()`.
- `performanceNow: () => number` — monotonic clock used only for
  `durationMs`. Default `() => performance.now()`.
- `version: string` — pipeline version stamped into
  `metadata.engineVersions.pipeline`. Default
  `TRADING_PIPELINE_VERSION`.

All three are injectable so tests can produce byte-identical
results across runs.

## Future integration

The pipeline is the deterministic core that PR12–PR13 will wrap:

- **PR12 (Market Data Runtime).** A runtime process instantiates
  `TradingPipeline` with real `SignalEngine` and
  `ExecutionTicketBuilder`, produces real snapshots from
  `apps/ingestion`, and exposes a dry-run endpoint that returns
  the raw `TradingPipelineResult`. No submitter is wired yet.
- **PR13 (Execution Runtime).** Adds a `TicketSubmitter` port
  called only on `outcome === "SUCCESS"`. The port owns the HTTP
  call to `execution-engine`, the idempotency key propagation,
  and the retry contract from
  [FAILURE_AND_RECOVERY.md](../implementation/phase2/FAILURE_AND_RECOVERY.md).
  The pipeline itself remains I/O-free.

Nothing about the shape of `TradingPipelineResult` requires
changes to consume a submitter — the submitter is invoked
outside the pipeline by the runtime shell.

## Module boundary

`packages/shared/src/trading-pipeline/` may import from other
`packages/shared/src/` modules (`signal-engine`, `execution-ticket`,
`market-context`, `instruments`) and from Node built-ins. It **must
not** import from `apps/*`, `pg`, `ioredis`, `ib`, `openai`, `undici`,
or any transport / storage library. This is enforced by the
existing repository conventions (`packages/shared` has no such
dependencies in its `package.json`).
