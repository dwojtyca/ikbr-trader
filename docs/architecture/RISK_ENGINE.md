# Risk Engine — Skeleton (PR8)

> Status: **Phase 1, foundation only.** This document describes the
> `packages/shared/src/risk-engine/` module introduced in PR8.
> The engine is entirely deterministic and rule-based. There is **no**
> LLM, no I/O, no broker communication, no order submission, and no
> consumer migration. Real risk consumers (signal-engine,
> execution-engine, llm-agent) are untouched.

## Purpose

Given a `DecisionResult` (from the Decision Engine), the
`MarketContextSnapshot` it was produced from, and the resolved
`Instrument`, return an immutable `RiskEvaluation` that answers a
single question: **may this decision proceed toward execution?**

The engine does not size orders, does not construct brackets, does
not talk to a broker, and does not persist anything. It is a pure
gate.

## Non-goals (PR8)

The engine explicitly does **not**:

- call any LLM / OpenAI / external API,
- fetch data from the internet,
- talk to `execution-engine` or place orders,
- migrate `signal-engine`, `execution-engine`, or any other consumer,
- persist evaluations,
- maintain state across `evaluate()` calls.

## Architecture

```
DecisionResult ─┐
                ├─► RiskEngine.evaluate(decision, snapshot, instrument)
Snapshot     ─  │            │
Instrument   ───┤            ├─ RiskRule.supports(input)?  yes/no
                             ├─ RiskRule.evaluate(input)   (isolated try/catch)
                             │        └─► RiskRuleEvaluation
                             │              { scoreContribution, warnings, blockers }
                             │
                             ├─ riskScore = clamp(sum(contribution), 0, 100)
                             ├─ if score ≥ threshold → append HIGH_RISK_SCORE
                             ├─ approved = (blockers.length === 0)
                             └─► RiskEvaluation (deep-frozen)
```

Every step is a pure function of its inputs. The engine has no
mutable state past the constructor.

## Rule API

```ts
interface RiskInput {
  readonly decision: DecisionResult;
  readonly snapshot: MarketContextSnapshot;
  readonly instrument: Instrument;
}

interface RiskRule {
  readonly id: string;
  supports(input: RiskInput): boolean;
  evaluate(input: RiskInput): RiskRuleEvaluation;
}

interface RiskRuleEvaluation {
  readonly scoreContribution: number;   // 0..100 — unipolar
  readonly warnings: readonly RiskWarning[];
  readonly blockers: readonly RiskBlocker[];
}
```

Guarantees:

- Rules are invoked in registration order; that order is preserved
  in `RiskEvaluation.blockers` and `.warnings`.
- A `supports(input) === false` rule is skipped (its `evaluate` is
  never called).
- A rule that throws is isolated: an `UNKNOWN` blocker with
  `ruleId` set is appended, a warning is recorded, and the engine
  keeps going. No user-visible exception escapes `evaluate()`.
- Rules MUST be pure functions of `RiskInput`. No I/O, no
  randomness, no persistent state, no cross-rule coordination.
- Risk is **unipolar**: rules only ADD score. Negative contributions
  are floored to zero by the aggregator.

### Initial rules (PR8)

| Rule                        | Emits blocker                     | Default score |
| --------------------------- | --------------------------------- | ------------- |
| `DecisionConfidenceRule`    | `LOW_CONFIDENCE` (< threshold)    | 60            |
| `HighImpactEventRule`       | `HIGH_IMPACT_EVENT` (event window)| 40            |
| `MarketFreshnessRule`       | `STALE_SNAPSHOT` / `UNAVAILABLE_SNAPSHOT` | 30 / 60 |
| `InstrumentExecutionRule`   | `INSTRUMENT_DISABLED`             | 100           |
| `OvernightRule`             | `OVERNIGHT_NOT_ALLOWED`           | 40            |
| `BrokerEnvironmentRule`     | `BROKER_ENVIRONMENT_MISMATCH`     | 100           |

`OvernightRule` takes an injectable `isInSession(input)` predicate;
the default is permissive (`() => true`) because a session-aware
provider is out of scope for PR8. A future session calendar
integration (part of the Market Context Engine roadmap) will replace
it.

## RiskEvaluation shape

```ts
interface RiskEvaluation {
  readonly approved: boolean;
  readonly riskScore: number;                  // 0..100
  readonly warnings: readonly RiskWarning[];
  readonly blockers: readonly RiskBlocker[];
  readonly metadata: {
    readonly engineVersion: string;
    readonly evaluationTimeMs: number;
  };
}
```

Every returned `RiskEvaluation` is **cycle-safe deep-frozen**: the
top-level object, every array, every warning and blocker, and every
nested object.

## Risk score aggregation

```
riskScore = clamp(round(sum(max(0, contribution))), 0, 100)
```

- Empty rule set → `0`.
- Negative or non-finite contributions are dropped defensively so a
  single buggy rule cannot poison the aggregate.
- No per-category weighting. Rules are trusted to size their own
  contribution.

## Approval flow

```
approved = (blockers.length === 0)

if riskScore >= highRiskScoreThreshold and no HIGH_RISK_SCORE blocker exists
    → append synthetic HIGH_RISK_SCORE blocker
    → approved becomes false
```

Default threshold: `highRiskScoreThreshold = 70`. The threshold is
per-engine-instance configurable.

### Blocker catalogue

| Code                          | Meaning                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `LOW_CONFIDENCE`              | Decision confidence below risk threshold.                       |
| `HIGH_IMPACT_EVENT`           | Snapshot flags a near-term high-impact event.                   |
| `STALE_SNAPSHOT`              | `snapshot.overallStatus === "stale"`.                           |
| `UNAVAILABLE_SNAPSHOT`        | `snapshot.overallStatus === "unavailable"`.                     |
| `INSTRUMENT_DISABLED`         | `instrument.trading.executionEnabled === false`.                |
| `OVERNIGHT_NOT_ALLOWED`       | Instrument disallows overnight AND is out of session.           |
| `OUT_OF_SESSION`              | Reserved for a future session-aware rule; not emitted in PR8.   |
| `BROKER_ENVIRONMENT_MISMATCH` | Broker environment differs from `expectedEnvironment`.          |
| `HIGH_RISK_SCORE`             | Aggregated risk score at/above threshold.                       |
| `UNKNOWN`                     | Rule threw; message contains original error text.               |

## Integration

### Decision Engine → Risk Engine

The Decision Engine already returns `HOLD` when *its* rules block
(stale price, missing price, calendar, low confidence, etc.). Risk
Engine layers on top: it may reject a directional decision that the
Decision Engine happily produced because risk-specific concerns
(instrument disabled, broker environment mismatch, overnight
restriction, out-of-session) are orthogonal to alpha generation.

Callers are expected to invoke both engines in order:

```
snapshot   = marketContextBuilder.build({ instrumentId })
decision   = decisionEngine.evaluate(snapshot)
evaluation = riskEngine.evaluate(decision, snapshot, instrument)

if (!evaluation.approved) reject(decision, evaluation.blockers)
else                      forward(decision, evaluation)
```

Wiring is deferred to a later PR — no consumer is touched in PR8.

### Future integration with Execution Engine

- `execution-engine` remains the sole component allowed to place,
  modify or cancel orders. `RiskEngine` is upstream and passive.
- Every rejected `RiskEvaluation` should be persisted with its full
  `blockers` + `warnings` for operator audit.
- The execution-engine will re-validate every accepted decision
  through its own account-level checks (buying power, position
  limits, broker kill-switch). Risk Engine is one layer of defence,
  not the only one.
- `BrokerEnvironmentRule` is the pointed defence against the "paper
  vs live" foot-gun: the risk engine holds the trader's declared
  `IBKR_ENVIRONMENT` and rejects any decision built off a snapshot
  observed from the wrong side.

## Determinism / testability hooks

`RiskEngine` constructor accepts:

- `performanceNow?: () => number` — deterministic monotonic clock;
  default `() => performance.now()`.
- `highRiskScoreThreshold?: number` — approval threshold.
- `version?: string` — overrides `engineVersion` in metadata.

The test suite injects a monotonic tick clock so `evaluationTimeMs`
is exactly `1` regardless of CI load.

## Architectural TODOs recorded in code

- `evaluator.ts`: once a second risk consumer appears, split
  `RiskEngine` into `RiskRuleRunner`, `RiskAggregator`, and a shared
  freeze utility (currently duplicated with `MarketContextBuilder`
  and `DecisionEngine`).
- `types.ts`:
  - `TODO(async)` — `RiskRule.evaluate()` will become
    `Promise<RiskRuleEvaluation>` once a rule needs I/O.
  - `TODO(context)` — a `RiskContext` object will be threaded as
    the second argument to `evaluate()` carrying config, logger,
    clock, feature flags, portfolio state, and session calendar.
