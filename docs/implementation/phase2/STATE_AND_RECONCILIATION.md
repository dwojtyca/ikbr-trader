# State & Reconciliation — Phase 2

> Answers the "who owns which state" question end-to-end and
> defines the idempotency contract every write must satisfy.

## Source of truth (SoT) matrix

| Entity | SoT | Local mirror | Reconciler |
| --- | --- | --- | --- |
| Market candles | `apps/ingestion` → Postgres | — | not needed |
| Market last tick | `apps/ingestion` → Redis | — | Redis TTL |
| `SignalEvaluation` | Orchestrator, transient | (persist deferred, see OD-2) | n/a |
| `ExecutionTicket` | Orchestrator, transient at build | `proposed_orders` (JSONB or new table, OD-2) | n/a |
| `proposed_orders` row | `apps/execution-engine` Postgres | Orchestrator holds `{proposedOrderId, idempotencyKey}` in RAM | n/a |
| Broker open orders | **IBKR** | `apps/execution-engine` snapshot | `execution-engine` reconciliation |
| Broker fills | **IBKR** | `broker_execution_fills` | `execution-engine` reconciliation |
| Broker positions | **IBKR** | `execution-engine` cache | `execution-engine` reconciliation |
| Account state | **IBKR** | `execution-engine` account cache | `execution-engine` reconciliation |

**Broker wins for open orders, fills, positions.** Local state that
disagrees is corrected in favour of the broker. Local state wins
only for *intent* (Was a ticket ever built? Was it approved by
Risk?).

## Minimal order lifecycle

```
INTENT (Orchestrator RAM)
   │  ticket built, idempotency key assigned
   ▼
PROPOSED (proposed_orders row, status=PROPOSED)
   │  POST /execution/tickets → 2xx
   ▼
SUBMITTED (status=SUBMITTED, broker_order_id set)
   │  ib.placeOrder acknowledged by broker
   ▼
WORKING → FILLED | CANCELLED | REJECTED | EXPIRED
   │
   └── all terminal transitions land via broker events
       or reconciliation, never via the Orchestrator.
```

Only the Orchestrator moves `INTENT → PROPOSED`. Only
`execution-engine` moves `PROPOSED → SUBMITTED → terminal`.

## Idempotency key

- **Value.** `ExecutionTicket.correlationId` from PR10
  (`crypto.randomUUID` v4, injected via `correlationIdFactory`).
- **Scope.** Uniquely identifies one attempted broker submission.
- **Propagation.**
  - Orchestrator → `POST /execution/tickets` — header
    `Idempotency-Key: <correlationId>`.
  - `execution-engine` → Postgres — new column
    `proposed_orders.client_order_id` (see OD-3) with
    `UNIQUE` constraint.
  - `execution-engine` → IBKR — passed as `orderRef` / native
    `clientOrderId` where supported.
- **Behaviour on collision.** Second call returns the original
  `{proposedOrderId, brokerOrderId?, status}` with HTTP `200` and
  a `duplicate: true` marker. **No** second `ib.placeOrder`.
- **Retention.** Idempotency mapping must outlive the broker
  order (recommended: keep the row indefinitely; garbage-collect
  only tickets in terminal `REJECTED_BY_RISK` after 90 days).

OPEN DECISION (OD-3): store the key as
`proposed_orders.client_order_id UNIQUE` vs. a dedicated
`order_idempotency (key PK, proposed_order_id FK)` table.
Dedicated table is friendlier to future modify/replace flows
because one intent can produce N broker orders; a single column
forces bookkeeping tricks. Decision must land before PR13.

## Ticket persistence

OPEN DECISION (OD-2): dedicated `execution_tickets` table vs.
JSONB column `proposed_orders.execution_ticket`. JSONB is one
migration; a table gives us history for `modify` and cleaner
indexing on `orderType`, `side`, `strategyId`. The kit records the
choice but does not implement it — PR13 owns the migration.

## Restart recovery

### Orchestrator restart

On boot, the Orchestrator:

1. Loads `IBKR_ENVIRONMENT`, whitelist, `TRADING_ENABLED`.
2. **Refuses to submit** anything until it has fetched from
   `execution-engine`:
   - the list of `proposed_orders` rows in non-terminal states
     for the current session,
   - the last reconciliation timestamp and its age.
3. If the last reconciliation is stale
   (> `ORCH_MAX_RECON_AGE_S`), triggers one via
   `POST /execution/reconciliation` and blocks reads until it
   completes.
4. Rebuilds its in-RAM `Set<idempotencyKey>` from the loaded
   rows so any in-flight snapshot recomputation cannot produce
   a duplicate submission.

### `execution-engine` restart

Already handled today. Phase 2 adds one invariant: on boot, if
any `proposed_orders` row is in status `SUBMITTED` without a
`broker_order_id`, `execution-engine` treats it as **unknown
submission** (fail-closed, per AGENTS.md Safety Rules) and
raises `SAFETY:UNKNOWN_SUBMISSION` (existing alert kind
family). Never assume "cancelled".

## Reconciliation

- **Owner.** `apps/execution-engine`
  (`POST /execution/reconciliation` and its scheduled run).
- **Frequency.** Existing default; `/ready` gates on
  `EXECUTION_READY_RECONCILIATION_MAX_AGE_S` (ADR-001 §3.6).
- **Orchestrator consumption.** Poll `GET /execution/reconciliation/latest`
  (add if missing in PR15). On mismatch, Orchestrator does **not**
  auto-close positions — it stops issuing new tickets for the
  affected instrument and raises alert `RECON_MISMATCH_HOLD`.

## Duplicate submission prevention (layered)

1. In-RAM `Set<idempotencyKey>` in Orchestrator.
2. `client_order_id UNIQUE` in Postgres (or table equivalent, OD-3).
3. `orderRef` echoed to IBKR — deduplicated by broker for the
   session.
4. Restart-safe: RAM set is rebuilt from Postgres before any
   submission is allowed.

## Paper vs Live separation

Handled by existing `IBKR_ENVIRONMENT`, `ALLOWED_PAPER_ACCOUNTS`,
`ALLOWED_LIVE_ACCOUNTS`, `TRADING_ENABLED` (see
[ADR-001](../../adr/ADR-001-execution-security.md) §3.1–§3.3).
Phase 2 additions:

- Orchestrator process reads `IBKR_ENVIRONMENT` and refuses to
  start in `live` unless PR18 checklist passes.
- No config knob shortens or bypasses reconciliation freshness.

OUT OF SCOPE: cross-account netting, multi-broker.
