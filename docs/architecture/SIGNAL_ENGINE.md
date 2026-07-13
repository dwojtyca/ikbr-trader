# Signal Engine — Skeleton (PR9)

> Status: **Phase 1, foundation only.** This document describes the
> `packages/shared/src/signal-engine/` module introduced in PR9.
> The engine is entirely deterministic and orchestrates two existing
> pure engines (`DecisionEngine`, `RiskEngine`) into a single
> `SignalEvaluation`. There is **no** LLM, no I/O, no broker
> communication, no order submission, and no consumer migration.
> `apps/signal-engine`, `execution-engine`, `llm-agent` and `ui`
> remain untouched.

## Purpose

Given a `MarketContextSnapshot`, run the following pipeline and
return an immutable `SignalEvaluation`:

```
MarketContextSnapshot
        │
        ▼
DecisionEngine.evaluate(snapshot)          → DecisionResult
        │
        ▼
RiskEngine.evaluate(decision, snapshot,
                    instrument)            → RiskEvaluation
        │
        ▼
SignalEvaluation { status, decision, risk, … }
```

The engine is a pure domain orchestrator. It never places, modifies
or cancels orders. It does not construct an `ExecutionTicket`. It is
the layer that will *feed* an execution ticket generator in a later
PR — nothing more.

## Non-goals (PR9)

The engine explicitly does **not**:

- call any LLM / OpenAI / external API,
- fetch data (market data, news, calendar),
- talk to `execution-engine` or place orders,
- construct an `ExecutionTicket` (deferred to PR10),
- migrate `apps/signal-engine`, `execution-engine`, `llm-agent` or
  any other consumer,
- persist evaluations,
- maintain state across `evaluate()` calls.

## Public API

```ts
class SignalEngine {
  constructor(options: SignalEngineOptions);
  evaluate(snapshot: MarketContextSnapshot): SignalEvaluation;
  evaluateMany(
    snapshots: readonly MarketContextSnapshot[],
  ): readonly SignalEvaluation[];
}

interface SignalEngineOptions {
  readonly decisionEngine: DecisionEngine;
  readonly riskEngine: RiskEngine;
  readonly instrumentResolver: (id: string) => Instrument | undefined;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly version?: string;
  readonly performanceNow?: () => number;
}
```

## SignalEvaluation

```ts
interface SignalEvaluation {
  readonly signalId: string;
  readonly generatedAt: Date;
  readonly instrumentId: string;
  readonly decision: DecisionResult | null;
  readonly risk: RiskEvaluation | null;
  readonly status: SignalStatus;
  readonly reasonSummary: string;
  readonly warnings: readonly SignalWarning[];
  readonly metadata: {
    readonly engineVersions: {
      readonly signal: string;
      readonly decision?: string;
      readonly risk?: string;
    };
    readonly evaluationTimeMs: number;
  };
}
```

Every returned `SignalEvaluation` is **cycle-safe deep-frozen**. The
nested `DecisionResult` and `RiskEvaluation` are already frozen by
their respective engines and are re-frozen defensively as part of
the top-level walk.

`decision` and `risk` are `null` when the corresponding engine did
not run or when it threw. They are never partially-populated: it is
either the immutable output of that engine or `null`.

## Statuses

| Status      | When                                                                 |
| ----------- | -------------------------------------------------------------------- |
| `ERROR`     | Decision engine, instrument resolver, or risk engine threw. Also if the resolver returned `undefined`. |
| `BLOCKED`   | Decision engine returned at least one blocker in `decision.blockedBy`. |
| `HOLD`      | Decision engine returned `action = "HOLD"` with no blockers.         |
| `REJECTED`  | Risk engine returned `approved = false`.                             |
| `GENERATED` | Decision produced a directional action AND risk approved it.         |

**Precedence:** `ERROR > BLOCKED > HOLD > REJECTED > GENERATED`.
`BLOCKED` beats `HOLD` because a blocked decision *is* a HOLD under
the hood but for a hard reason, not for lack of conviction.

`ERROR` never leaks the underlying exception — the message goes into
`warnings[]` and `reasonSummary`.

## Pipeline

Implemented as a pure function in [pipeline.ts](../../packages/shared/src/signal-engine/pipeline.ts)
and orchestrated by the class in [evaluator.ts](../../packages/shared/src/signal-engine/evaluator.ts).
Steps, in order:

1. `decisionEngine.evaluate(snapshot)` under try/catch.
   - Throw → status `ERROR`, warning `{ code: "DECISION_ENGINE_EXCEPTION", source: "decision-engine" }`, pipeline stops.
2. **Short-circuit:** if `decision.blockedBy.length > 0` or
   `decision.action === "HOLD"`, risk is **not** invoked and the
   instrument resolver is **not** invoked. This saves work and keeps
   `null` semantics honest (`risk === null` iff risk was skipped or
   threw).
3. `instrumentResolver(snapshot.instrumentId)` under try/catch.
   - Throw → status `ERROR`, warning `INSTRUMENT_RESOLVER_EXCEPTION`.
   - `undefined` → status `ERROR`, warning `INSTRUMENT_NOT_FOUND`.
4. `riskEngine.evaluate(decision, snapshot, instrument)` under
   try/catch.
   - Throw → status `ERROR`, warning `RISK_ENGINE_EXCEPTION`.
5. Derive status via `deriveSignalStatus`, summarize via
   `summarizeReason`, build metadata, deep-freeze, return.

There are no other shortcuts. Every path returns a
`SignalEvaluation`; every exception is caught.

## Relation with `MarketContext`

The Signal Engine takes a `MarketContextSnapshot` **as-is**. It does
not build one, does not augment one, does not re-request providers.
The snapshot is the single input.

`MarketContextBuilder` remains the sole entry point for constructing
snapshots. Callers are expected to:

```ts
const snapshot   = await marketContextBuilder.build({ instrumentId });
const evaluation = signalEngine.evaluate(snapshot);
```

Wiring is deferred — no consumer is touched in PR9.

## Relation with `DecisionEngine`

The Signal Engine calls `DecisionEngine.evaluate(snapshot)` exactly
once per snapshot and treats its output as read-only. It does not
re-run rules, does not re-weight, does not translate blocker codes
into new statuses. Every `DecisionBlocker` present in
`decision.blockedBy` propagates straight into `SignalStatus.BLOCKED`.

The engine records `decision.metadata.engineVersion` in
`metadata.engineVersions.decision` for downstream audit.

## Relation with `RiskEngine`

The Signal Engine calls `RiskEngine.evaluate(decision, snapshot,
instrument)` only when decision produced a directional action with
no blockers. The instrument is resolved through the injected
`InstrumentResolver` — this keeps the shared package free of any
particular registry / config / DB dependency. In production the
injected resolver will typically wrap `defaultInstrumentRegistry`
from `@ikbr/shared`.

Risk failures propagate into `SignalStatus.REJECTED`. The full
`RiskEvaluation` (including warnings, blockers and score) is
preserved verbatim in `evaluation.risk`.

## Future relation with Execution Engine

- `execution-engine` remains the sole component allowed to place,
  modify or cancel orders. `SignalEngine` is upstream and passive.
- PR10 will introduce an `ExecutionTicket` — a broker-ready
  representation of a `GENERATED` `SignalEvaluation` (side, quantity,
  time-in-force, bracket parameters). It will be constructed by a
  separate builder, not by `SignalEngine`.
- The execution service will keep re-validating every ticket
  through its own account-level checks (buying power, position
  limits, broker kill-switch). The Signal Engine is one layer of
  defence — never the only one.
- The Signal Engine never emits an order id, never reserves buying
  power, never touches Postgres. Downstream persistence
  (`proposed_orders`) is the caller's responsibility.

## Determinism / testability hooks

`SignalEngine` constructor accepts:

- `now?: () => Date` — deterministic wall clock.
- `idFactory?: () => string` — deterministic id source.
- `performanceNow?: () => number` — deterministic monotonic clock.
- `version?: string` — overrides `metadata.engineVersions.signal`.

The unit tests inject a monotonic tick clock so `evaluationTimeMs`
is exactly `1` regardless of CI load, and reuse the same clocks for
the wrapped `DecisionEngine` and `RiskEngine`.

## Architectural TODOs recorded in code

- `evaluator.ts`: once a second signal consumer appears, extract
  timing + id + freeze into shared engine utilities (mirroring TODOs
  already recorded on `MarketContextBuilder`, `DecisionEngine`,
  `RiskEngine`).
- `evaluator.ts`: PR10 will add an `ExecutionTicket` layer that
  turns a `GENERATED` `SignalEvaluation` into an order-shaped intent
  for `execution-engine`. The Signal Engine itself remains purely
  domain — no broker, no HTTP, no persistence.
