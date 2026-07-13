# Execution Ticket Builder — Skeleton (PR10)

> Status: **Phase 1, foundation only.** This document describes the
> `packages/shared/src/execution-ticket/` module introduced in PR10.
> The builder is entirely deterministic and produces an
> `ExecutionTicket` — a broker-agnostic order intent. It does NOT
> submit orders, does NOT talk to IBKR, does NOT write to Postgres,
> and does NOT touch `execution-engine`, `signal-engine`,
> `llm-agent` or `ui`. Consumer migration is deferred to a later PR.

## Purpose

Given a `GENERATED` `SignalEvaluation`, its underlying
`MarketContextSnapshot`, the resolved `Instrument`, and a per-strategy
`ExecutionTicketPolicy`, return a discriminated
`ExecutionTicketBuildResult`:

```ts
type ExecutionTicketBuildResult =
  | { ok: true;  ticket: ExecutionTicket;  warnings: readonly TicketWarning[] }
  | { ok: false; ticket: null;             blockers: readonly TicketBlocker[]; warnings: readonly TicketWarning[] };
```

The builder is a pure function of its inputs — no I/O, no
randomness (id / correlation-id factories are injected), no HTTP,
no persistence.

## Non-goals (PR10)

The builder explicitly does **not**:

- talk to `execution-engine`, IBKR or any broker,
- send tickets over HTTP,
- persist to Postgres or write `proposed_orders`,
- support `MKT` orders (every order must carry an explicit price
  envelope),
- call any LLM / external API,
- migrate any existing service.

## Public API

```ts
class ExecutionTicketBuilder {
  constructor(options?: ExecutionTicketBuilderOptions);
  build(input: ExecutionTicketBuildInput): ExecutionTicketBuildResult;
}

interface ExecutionTicketBuildInput {
  readonly signal: SignalEvaluation;
  readonly snapshot: MarketContextSnapshot;
  readonly instrument: Instrument;
  readonly policy: ExecutionTicketPolicy;
}

interface ExecutionTicketBuilderOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly correlationIdFactory?: () => string;
  readonly version?: string;
}
```

## Preconditions

The builder emits a `TicketBlocker` (not an exception) when any of
the following is violated. Blockers are collected per stage and the
builder returns `{ ok: false }` on the first stage that produces any.

| Guard                                                           | Blocker code                  |
| --------------------------------------------------------------- | ----------------------------- |
| `signal.status === "GENERATED"`                                 | `SIGNAL_NOT_GENERATED`        |
| `signal.decision !== null`                                      | `DECISION_MISSING`            |
| `signal.risk !== null`                                          | `RISK_MISSING`                |
| `signal.risk.approved === true`                                 | `RISK_NOT_APPROVED`           |
| `decision.action` ∈ `{ LONG, SHORT }`                           | `NON_DIRECTIONAL_DECISION`    |
| `signal.instrumentId === snapshot.instrumentId === instrument.id` | `INSTRUMENT_MISMATCH`       |
| `instrument.trading.executionEnabled === true`                  | `INSTRUMENT_DISABLED`         |
| `snapshot.sections.price.data !== null`                         | `PRICE_MISSING`               |
| `snapshot.sections.price.status === "fresh"`                    | `PRICE_NOT_FRESH`             |
| `policy.orderType` ∈ `{ LMT, STP, STP_LMT }`                    | `UNSUPPORTED_ORDER_TYPE`      |
| `policy.quantity` positive integer                              | `INVALID_QUANTITY`            |
| `policy.quantity <= instrument.risk.maxQuantity`                | `QUANTITY_LIMIT_EXCEEDED`     |
| `policy.priceTickSize > 0`                                      | `INVALID_TICK_SIZE`           |
| Order type / envelope mismatch                                  | `INVALID_ORDER_CONFIGURATION` |
| Rounded stop-loss / take-profit on wrong side of entry          | `INVALID_PROTECTION_LEVELS`   |
| Unexpected internal failure (reserved)                          | `UNKNOWN`                     |

The builder throws **only** for constructor / call-site
misconfiguration (e.g. `build(undefined)`).

## Direction mapping

| `decision.action` | `order.side` |
| ----------------- | ------------ |
| `LONG`            | `BUY`        |
| `SHORT`           | `SELL`       |
| `HOLD`            | blocker: `NON_DIRECTIONAL_DECISION` |

`HOLD`, `BLOCKED`, `REJECTED` and `ERROR` signals cannot produce a
ticket at all — they are stopped by `SIGNAL_NOT_GENERATED` before
the direction check.

## Pricing

Base price selection ([pricing.ts](../../packages/shared/src/execution-ticket/pricing.ts)):

- **BUY** — prefer `snapshot.sections.price.data.ask`; fall back to
  `last` (emits a `PRICE_SOURCE_FALLBACK` warning).
- **SELL** — prefer `bid`; fall back to `last` (same warning).
- Missing all three → `PRICE_MISSING` blocker.

Entry price:

- `raw = base + entryOffset` for BUY, `raw = base - entryOffset` for
  SELL. `entryOffset` is a magnitude in policy price units.
  `undefined` is treated as `0`.
- Rounded to `policy.priceTickSize` under `policy.priceRoundingMode`.

Protection legs:

- `BUY`  → `stopLoss = entry - stopLossDistance`,
  `takeProfit = entry + takeProfitDistance`.
- `SELL` → `stopLoss = entry + stopLossDistance`,
  `takeProfit = entry - takeProfitDistance`.
- Each computed leg is tick-rounded, then side-checked. If rounding
  pushes the stop / TP onto or across the entry (e.g. tick size 1,
  distance 0.1) the builder emits `INVALID_PROTECTION_LEVELS`
  rather than silently shipping a broken bracket.
- `trailingStopDistance` is carried as an absolute distance onto
  `protection.trailingStop` (tick-rounded); it is not translated
  into a price.
- `bracketEnabled` is `true` iff `stopLoss` or `takeProfit` is set.
  A trailing stop alone does not constitute a bracket in this PR.

Order envelope (per type):

| `orderType` | Requires        | Not used   |
| ----------- | --------------- | ---------- |
| `LMT`       | `limitPrice`    | `stopPrice` |
| `STP`       | `stopPrice`     | `limitPrice` |
| `STP_LMT`   | both            | —          |

`STP_LMT` uses the same rounded entry price as both trigger and
limit — a conservative default; a per-policy limit gap can be added
in a later PR.

## Tick rounding

`roundToTick(price, tickSize, mode)`:

- Uses integer arithmetic on a scaled decimal to sidestep FP drift
  (0.1 + 0.2 etc.).
- `mode`:
  - `nearest` — bankers' rounding.
  - `up`      — ceil to next tick.
  - `down`    — floor to previous tick.
- Non-finite `price` or non-positive `tickSize` return `NaN`; the
  caller converts that into an `INVALID_ORDER_CONFIGURATION` or
  `INVALID_TICK_SIZE` blocker upstream.

Tick size is never guessed. The policy owns it.

## Protection levels

`stopLossDistance`, `takeProfitDistance`, `trailingStopDistance`
must all be positive finite numbers when present. `undefined` means
the leg is not emitted. Any negative or non-finite distance is a
`INVALID_PROTECTION_LEVELS` blocker.

Rounding is applied *after* side-relative computation. Any post-
rounding value that lands at / crosses the entry raises
`INVALID_PROTECTION_LEVELS`. This is the primary defence against
pathological tick / distance combinations.

## Immutability

Every returned `ExecutionTicketBuildResult` (both variants) is
**cycle-safe deep-frozen**: the discriminated wrapper, the
`ExecutionTicket`, `order`, `protection`, `metadata`, `warnings`,
`blockers`, and every element inside every array. Callers may share
references without defensive copies.

The freeze helper is duplicated with `MarketContextBuilder`,
`DecisionEngine`, `RiskEngine` and `SignalEngine` on purpose — see
the architectural TODO recorded in each of those modules for the
planned extraction into a shared utility.

## Blocker catalogue

| Code                          | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `SIGNAL_NOT_GENERATED`        | `signal.status !== "GENERATED"`.                                     |
| `DECISION_MISSING`            | `signal.decision === null`.                                          |
| `RISK_MISSING`                | `signal.risk === null`.                                              |
| `RISK_NOT_APPROVED`           | `signal.risk.approved === false`.                                    |
| `NON_DIRECTIONAL_DECISION`    | `decision.action` is `HOLD` (unreachable through `GENERATED` in production but validated defensively). |
| `INSTRUMENT_MISMATCH`         | `signal.instrumentId`, `snapshot.instrumentId`, `instrument.id` disagree. |
| `INSTRUMENT_DISABLED`         | `instrument.trading.executionEnabled === false`.                     |
| `PRICE_MISSING`               | `snapshot.sections.price.data === null` or no usable ask/bid/last.   |
| `PRICE_NOT_FRESH`             | `snapshot.sections.price.status !== "fresh"`.                        |
| `INVALID_QUANTITY`            | `policy.quantity` non-positive / non-integer / non-finite.           |
| `QUANTITY_LIMIT_EXCEEDED`     | `policy.quantity > instrument.risk.maxQuantity`.                     |
| `INVALID_TICK_SIZE`           | `policy.priceTickSize <= 0` or non-finite.                           |
| `INVALID_ORDER_CONFIGURATION` | Envelope required by `orderType` is incomplete (missing price).      |
| `INVALID_PROTECTION_LEVELS`   | Stop or take-profit lands on / across entry after rounding.          |
| `UNSUPPORTED_ORDER_TYPE`      | `policy.orderType` not in `{ LMT, STP, STP_LMT }` (notably `MKT`).   |
| `UNKNOWN`                     | Reserved for internal failure paths; not emitted in PR10.            |

## Relation with Signal Engine

The Signal Engine returns a deep-frozen `SignalEvaluation`. The
builder inspects it but never mutates it. Every version string on
`ExecutionTicketMetadata` is copied from the signal's
`metadata.engineVersions` (or from the engines' own `metadata` as a
fallback), so an audit trail from ticket back to signal / decision /
risk versions is preserved without re-running any engine.

Wiring is deferred — no consumer is touched in PR10. In a later PR
the flow will look like:

```ts
const snapshot   = await marketContextBuilder.build({ instrumentId });
const evaluation = signalEngine.evaluate(snapshot);
if (evaluation.status !== "GENERATED") return;
const result = ticketBuilder.build({
  signal: evaluation,
  snapshot,
  instrument: registry.getInstrumentOrThrow(evaluation.instrumentId),
  policy: strategyPolicy,
});
if (!result.ok) return operator.rejectSignal(evaluation, result.blockers);
executionClient.submit(result.ticket);
```

## Future relation with Execution Engine

- `execution-engine` remains the sole component allowed to place,
  modify or cancel orders. This builder is upstream and passive.
- `execution-engine` will consume `ExecutionTicket` values and
  translate them into IBKR-shaped contract / order objects, apply
  its own account-level guards (buying power, position limits,
  broker kill-switch), and persist a `proposed_orders` row. None of
  that lives here.
- The ticket's `metadata.correlationId` is intended as the join key
  for cross-service tracing (signal → ticket → broker order → fill),
  but the shared package does not prescribe a specific correlator.

## Architectural TODOs recorded in code

- `builder.ts`: once a second builder / consumer appears, extract
  the freeze helper into a shared engine utility (mirroring TODOs
  already recorded on `MarketContextBuilder`, `DecisionEngine`,
  `RiskEngine`, `SignalEngine`).
- Extensibility: per-order-type limit gap, per-instrument tick-size
  registry lookup, and MKT support are all explicitly deferred to
  later PRs.
