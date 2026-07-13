# Decision Engine — Skeleton (PR7)

> Status: **Phase 1, foundation only.** This document describes the
> `packages/shared/src/decision-engine/` module introduced in PR7.
> The engine is entirely deterministic and rule-based. There is **no**
> LLM, no I/O, no order submission, and no consumer migration. Real
> decision consumers (signal-engine, llm-agent, execution-engine) are
> untouched.

## Purpose

Translate a `MarketContextSnapshot` into a structured, immutable
`DecisionResult` (`LONG` / `SHORT` / `HOLD`) with:

- a signed `overallScore` in `[-100, 100]`,
- a `confidence` in `[0, 100]`,
- a list of `reasons`, `warnings` and `blockedBy` entries.

The engine deliberately produces a decision, not an order. Sizing,
bracket construction, risk envelope enforcement and broker
communication remain the responsibility of `signal-engine` and
`execution-engine`. See "Future integration" below.

## Non-goals (PR7)

The engine explicitly does **not**:

- call any LLM / OpenAI / external API,
- fetch data from the internet (no HTTP),
- talk to `execution-engine` or place orders,
- migrate `signal-engine`, `llm-agent`, or any other consumer,
- persist decisions,
- maintain per-instrument state across calls (each `evaluate()` is
  stateless).

## Architecture

```
MarketContextSnapshot ──► DecisionEngine.evaluate()
                              │
                              ├─ Rule.supports(snapshot)?  yes/no
                              ├─ Rule.evaluate(snapshot)   (isolated try/catch)
                              │        └─► RuleEvaluation
                              │              { scoreContribution,
                              │                reasons, warnings, blockers }
                              │
                              ├─ aggregateOverallScore(outcomes)
                              ├─ computeConfidence(outcomes, snapshot, …)
                              ├─ chooseAction(score, confidence, blockers)
                              └─► DecisionResult (deep-frozen)
```

All four steps are pure functions of their inputs. The engine has no
mutable state past the constructor.

## Rule Engine

```ts
interface Rule {
  readonly id: string;
  readonly category: DecisionCategory;
  supports(snapshot: MarketContextSnapshot): boolean;
  evaluate(snapshot: MarketContextSnapshot): RuleEvaluation;
}

interface RuleEvaluation {
  readonly scoreContribution: number; // signed, expected in [-100, 100]
  readonly reasons: readonly DecisionReason[];
  readonly warnings: readonly string[];
  readonly blockers: readonly DecisionBlocker[];
}
```

Guarantees:

- Rules are invoked in the order the caller registered them; that
  order is preserved in `DecisionResult.reasons` and `.blockedBy`.
- A `supports(snapshot) === false` rule is skipped (its `evaluate` is
  never called).
- A rule that throws is isolated: an `UNKNOWN` blocker with
  `ruleId` set is inserted, a warning is added, and the engine keeps
  going. No user-visible exception escapes `evaluate()`.
- Rules MUST be pure functions of the snapshot. No I/O, no
  randomness, no persistent state, no cross-rule coordination.

### Initial rules (PR7)

| Rule                       | Category    | Emits                                                   |
| -------------------------- | ----------- | ------------------------------------------------------- |
| `FreshPriceRule`           | `TECHNICAL` | neutral reason if fresh; `STALE_DATA` blocker if stale  |
| `MissingPriceRule`         | `TECHNICAL` | `MISSING_PRICE` blocker if `price.data === null`        |
| `HighImpactCalendarRule`   | `MACRO`     | `HIGH_IMPACT_EVENT` blocker if next event within window |
| `NewsRiskRule`             | `NEWS`      | bearish `scoreContribution` per risk flag + sentiment   |
| `BrokerAvailabilityRule`   | `BROKER`    | `BROKER_UNAVAILABLE` if broker data missing             |

These are intentionally minimal; PR7 proves the scaffold, not a
strategy. Follow-up PRs will add multi-timeframe technical
confluence, cross-asset regime, positioning (COT), flows, etc.

## Scoring

`aggregateOverallScore(outcomes)` sums every rule's signed
`scoreContribution` and clamps to `[-100, 100]`. Non-finite values
are dropped defensively.

- Empty rule set → `0`.
- The aggregator has **no per-category weights**. Rules are trusted
  to size their own contribution. Categories exist to make outputs
  interpretable, not to bias the sum.

## Confidence

`computeConfidence({ outcomes, snapshot, expectedRuleCount, blockerPenalty })`:

```
coverage    = min(rules, expected) / expected          // fewer rules → lower
consistency = |sum(contribution)| / sum(|contribution|) // conflict → 0
freshness   = { fresh: 1, partial: 0.7, stale: 0.3, unavailable: 0 }
penalty     = min(100, blockers × blockerPenalty)
confidence  = clamp(round(coverage × consistency × freshness × 100 − penalty),
                    0, 100)
```

The formula is intentionally simple and inspectable — no ML, no
tunable coefficients beyond `expectedRuleCount` and `blockerPenalty`.
Confidence is `0` whenever:

- rules disagree entirely (bull + bear cancel to 0 signed sum),
- the snapshot is fully unavailable,
- blockers stack enough to exhaust the penalty budget.

## Blockers

| Code                        | Emitted by                                          |
| --------------------------- | --------------------------------------------------- |
| `STALE_DATA`                | `FreshPriceRule` (stale price data)                 |
| `MISSING_PRICE`             | `MissingPriceRule`                                  |
| `MARKET_CLOSED`             | *(not yet emitted by a built-in rule; type reserved for a future session-aware rule)* |
| `BROKER_UNAVAILABLE`        | `BrokerAvailabilityRule`                            |
| `HIGH_IMPACT_EVENT`         | `HighImpactCalendarRule`                            |
| `INSUFFICIENT_CONFIDENCE`   | `DecisionEngine` (post-aggregation guard)           |
| `UNKNOWN`                   | `DecisionEngine` (rule-level exception fallback)    |

Any blocker forces `action = "HOLD"`. Multiple blockers are
preserved; the engine does not deduplicate or prioritise.

## Action selection

```
if blockers.length > 0                          → HOLD
if confidence < minConfidenceForAction          → HOLD + INSUFFICIENT_CONFIDENCE
if overallScore >  +scoreThreshold              → LONG
if overallScore <  −scoreThreshold              → SHORT
otherwise                                       → HOLD
```

Defaults: `minConfidenceForAction = 25`, `scoreThreshold = 15`. A
`HOLD` can therefore be returned even with a strongly positive
score, e.g. when confidence is capped by a stale snapshot or a
blocker — this is by design.

## DecisionResult shape

```ts
interface DecisionResult {
  readonly decisionId: string;         // uuid or injected id
  readonly generatedAt: Date;
  readonly instrumentId: string;
  readonly action: "LONG" | "SHORT" | "HOLD";
  readonly confidence: number;         // 0..100
  readonly overallScore: number;       // -100..100
  readonly reasons: readonly DecisionReason[];
  readonly warnings: readonly string[];
  readonly blockedBy: readonly DecisionBlocker[];
  readonly metadata: {
    readonly engineVersion: string;
    readonly evaluationTimeMs: number;
  };
}
```

Every returned `DecisionResult` is **deep-frozen** (cycle-safe) — the
top-level object, every array, every reason and blocker, and every
nested object. Consumers may share the reference freely.

## Determinism / testability hooks

`DecisionEngine` constructor accepts:

- `now?: () => Date` — deterministic clock.
- `idFactory?: () => string` — deterministic id source.
- `version?: string` — overrides `engineVersion` in metadata.
- `minConfidenceForAction`, `scoreThreshold`, `expectedRuleCount`,
  `blockerPenalty` — all tunable per engine instance.

Both hooks are used by the test suite to produce fully reproducible
outputs without touching the real system clock.

## Future integration

### LLM (llm-agent)

The current `llm-agent` polls `proposed_orders` and calls OpenAI to
gate `EXECUTE`/`REJECT`. Once the Decision Engine is wired in:

- `DecisionResult.action` becomes the primary directional
  recommendation.
- The LLM receives the `reasons`, `warnings`, `blockedBy` and the
  underlying `MarketContextSnapshot` as structured context — it does
  not need to re-derive them.
- The LLM's role narrows to *interpretation and veto*: it may
  downgrade `LONG` → `HOLD` given qualitative context (e.g. a
  headline the news provider missed), but MUST NOT upgrade a
  blocker-carrying `HOLD` to a directional action.
- Reasons and blockers become the audit trail persisted with each
  decision.

The Decision Engine itself remains synchronous and LLM-free.

### Execution Engine

A future wiring PR will hand `DecisionResult` to `signal-engine` (for
sizing / bracket construction) and then to `execution-engine` (which
already owns broker communication, reconciliation and kill-switches).
Boundary rules:

- `execution-engine` continues to be the sole component allowed to
  place, modify or cancel orders.
- `execution-engine` re-validates every incoming decision through
  the Risk Engine — a Decision Engine `LONG` is never sufficient to
  submit an order on its own.
- Rejected or blocked decisions are persisted with their full
  `reasons` + `blockedBy` for the operator UI.

## Architectural TODOs recorded in code

- `evaluator.ts`: once a second decision consumer appears, split
  `DecisionEngine` into `RuleRunner`, `DecisionAggregator`, and a
  shared freeze utility (currently duplicated with
  `market-context/builder.ts`).
