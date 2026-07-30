# State & Reconciliation — Phase 2

> Status (r2, PR15 shipped as commit `87eff1c`): OD-2, OD-3, and
> OD-4 are resolved (see [README.md](README.md)). No separate
> `execution_tickets` table exists; every order-critical field
> lives on `proposed_orders`. Client-side idempotency is
> `clientOrderId + clientOrderHash` in the request body — not a
> header. Orchestrator = `signal-engine/src/runtime/`.

## Source of truth (SoT) matrix

| Entity | SoT | Local mirror | Reconciler |
| --- | --- | --- | --- |
| Market candles | `apps/ingestion` → Postgres | — | not needed |
| Market last tick | `apps/ingestion` → Redis | — | Redis TTL |
| `SignalEvaluation` | signal-engine runtime, transient | — | n/a |
| `ExecutionTicket` | signal-engine runtime, transient at build | `proposed_orders` (single row) | n/a |
| `proposed_orders` row | `apps/execution-engine` Postgres | runtime holds `{proposedOrderId, clientOrderId, clientOrderHash}` in RAM | n/a |
| Broker open orders | **IBKR** | `apps/execution-engine` snapshot | `execution-engine` reconciliation |
| Broker fills | **IBKR** | `broker_execution_fills` | `execution-engine` reconciliation |
| Broker positions | **IBKR** | `execution-engine` cache | `execution-engine` reconciliation |
| Account state | **IBKR** | `execution-engine` account cache | `execution-engine` reconciliation |

**Broker wins for open orders, fills, positions.** Local state
that disagrees is corrected in favour of the broker. Local state
wins only for *intent* (Was a ticket ever built? Was it approved
by Risk?).

## Minimal order lifecycle

```
INTENT (runtime RAM)
   │  ticket built, clientOrderId + clientOrderHash assigned
   ▼
PROPOSED (proposed_orders row, status=PROPOSED,
          client_order_id + client_order_hash persisted)
   │  POST /execution/execute-ticket → 2xx (or duplicate marker)
   ▼
SUBMITTED (status=SUBMITTED, broker_order_id set)
   │  ib.placeOrder acknowledged by broker
   ▼
WORKING → FILLED | CANCELLED | REJECTED | EXPIRED
   │
   └── all terminal transitions land via broker events
       or reconciliation, never via the runtime.
```

Only the runtime moves `INTENT → PROPOSED`. Only
`execution-engine` moves `PROPOSED → SUBMITTED → terminal`.

## Idempotency contract (PR15)

- **Values.** `clientOrderId` (opaque, generated per intent) and
  `clientOrderHash` (SHA-256 of a canonical serialization of the
  ticket, computed via `@ikbr/shared/client-order-hash`).
- **Scope.** Uniquely identifies one attempted broker submission.
- **Propagation.**
  - runtime → `POST /execution/execute-ticket` — JSON body carries
    both fields.
  - `execution-engine` recomputes the hash server-side and rejects
    on mismatch.
  - Persistence: mandatory `client_order_id` + `client_order_hash`
    columns on `proposed_orders` with `UNIQUE(client_order_id)`.
  - Passed to IBKR as `orderRef` where supported.
- **Behaviour on collision.** Second call returns HTTP 200 with
  `duplicate: true` and one of
  `outcome: DUPLICATE_SUBMITTED | DUPLICATE_TERMINAL |
  DUPLICATE_PENDING_AMBIGUOUS | PENDING_CLAIMED`. **No** second
  `ib.placeOrder`.
- **Retention.** Idempotency mapping outlives the broker order;
  garbage-collect only tickets in terminal `REJECTED_BY_RISK`
  after 90 days.

## Ticket persistence

Every order-critical field lives on `proposed_orders`. Migration
000005 added `partial_take_profits`, `trailing_stop_pct`, and
`trailing_stop_activation_r` so no separate `execution_tickets`
table is needed. This resolves OD-2.

## Restart recovery

### signal-engine runtime restart

On boot:

1. Loads `IBKR_ENVIRONMENT`, whitelist, `TRADING_ENABLED`,
   `RUNTIME_ENABLED`, `EXECUTION_RUNTIME_ENABLED`,
   `TRADING_LOOP_ENABLED`.
2. **Refuses to submit** anything until it has confirmed via
   `GET /execution/ready` that reconciliation is fresh.
3. If the last reconciliation is stale, blocks reads until a
   fresh run is available (recovery is reconciliation-driven,
   not a client-side re-query).

The runtime holds **no in-RAM `Set<clientOrderId>` cache**. It
does not rehydrate any duplicate-suppression state from Postgres
on boot. Correctness after restart depends only on:

- the `client_order_id UNIQUE` constraint on `proposed_orders`,
- the submission-service idempotency-replay outcome union, and
- reconciliation-driven recovery of any ambiguous row.

Non-overlap within a single runtime process is enforced by a
process-local `Map<instrumentId, Promise<void>>` in
`trading-loop-service.ts` — a liveness convenience only.

### `execution-engine` restart

Already handled today. Phase 2 invariant: on boot, if any
`proposed_orders` row is in status `SUBMITTED` without a
`broker_order_id`, `execution-engine` treats it as **unknown
submission** (fail-closed, per AGENTS.md Safety Rules) and
raises `SAFETY:UNKNOWN_SUBMISSION`. Never assume "cancelled".

## Reconciliation

- **Owner.** `apps/execution-engine`
  (`apps/execution-engine/src/reconciliation/`).
- **Frequency.** Defaults from `RECONCILIATION_*`
  (`.env.example:115–128`); `/ready` gates on
  `EXECUTION_READY_RECONCILIATION_MAX_AGE_S` (ADR-001 §3.6).
- **runtime consumption.** Poll
  `GET /execution/reconciliation/latest` (returns `stale`,
  `maxAgeSeconds`, `run.snapshotComplete`, `run.status`) and
  `GET /execution/reconciliation/holds?active=true`. On any active
  hold or `stale=true`, the runtime stops issuing new tickets for
  the affected instrument and defers to
  hold-resolution runbooks — it does **not** auto-close positions.
- **POST endpoints** (`/reconciliation/run`,
  `/holds/:id/acknowledge`, `/holds/:id/resolve`) are operator /
  automation actions, never called by the read-only verify tool.

## Duplicate submission prevention (authoritative layers)

1. `client_order_id UNIQUE` on `proposed_orders` — the
   authoritative gate.
2. Submission-service replay path returns HTTP 200 with
   `duplicate: true` and one of
   `DUPLICATE_SUBMITTED | DUPLICATE_TERMINAL |
   DUPLICATE_PENDING_AMBIGUOUS | PENDING_CLAIMED`.
3. Server-recomputed `clientOrderHash` echoed back on duplicate.
4. `orderRef` echoed to IBKR — deduplicated by broker for the
   session.
5. Reconciliation resolves ambiguous rows.

Process-local: `trading-loop-service.ts` holds a
`Map<instrumentId, Promise<void>>` (`#inFlight`) that prevents
overlapping ticks for the same instrument within a single
runtime process. This is a liveness convenience only — it does
NOT protect against duplicates across restarts or across
processes. That is what layers 1–5 above are for.

## Paper vs Live separation

Handled by existing `IBKR_ENVIRONMENT`, `ALLOWED_PAPER_ACCOUNTS`,
`ALLOWED_LIVE_ACCOUNTS`, `TRADING_ENABLED` (see
[ADR-001](../../adr/ADR-001-execution-security.md) §3.1–§3.3).
Phase 2 additions:

- signal-engine runtime reads `IBKR_ENVIRONMENT` and refuses to
  start in `live` unless PR18 checklist passes.
- No config knob shortens or bypasses reconciliation freshness.

OUT OF SCOPE: cross-account netting, multi-broker.
