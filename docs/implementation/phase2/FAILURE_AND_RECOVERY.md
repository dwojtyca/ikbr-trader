# Failure & Recovery — Phase 2

> Every failure mode reachable from Orchestrator → `execution-engine`
> → IBKR Paper, classified by retry safety and terminal action.
> Fail-closed everywhere: unknown state ≠ safe state.

## Retry taxonomy

| Class | Examples | Retry? | Owner | Notes |
| --- | --- | --- | --- | --- |
| **Deterministic reject** | `INVALID_QUANTITY`, `RISK_NOT_APPROVED`, `INSTRUMENT_DISABLED`, HTTP `400`, `422`, `423` (`live_trading_disabled`), `403` | **No** | Orchestrator | Record `REJECTED_BY_*`; no retry. |
| **Auth failure** | HTTP `401` | **No** | Orchestrator | Alert `AUTH_FAILURE`; refuse further submissions until config reloaded. |
| **Idempotency hit** | HTTP `200 { duplicate: true }` | **No** | Orchestrator | Update local state from response; **do not** resend. |
| **Network / transient** | ECONNRESET, connect timeout, HTTP `502/503/504` | **Yes**, bounded | Orchestrator | Same idempotency key. Max attempts + jittered backoff (see below). |
| **Ambiguous** | Read timeout on `POST /execution/tickets` after body sent | **No** — treat as unknown submission | Orchestrator | Re-query `GET /execution/orders?key=<id>` first. Only if authoritative "not found" → retry. |
| **Broker session down** | `execution-engine` reports `503` from `/ready` or `SUBMIT_REJECTED_BROKER_DOWN` | Pause loop | Orchestrator | Halt new submissions; resume when `/ready` returns 200. |
| **IBKR-level reject** | Cancel codes `201`, `320`, pacing violations | **No** | `execution-engine` (existing) | Alert + terminal state. |
| **DB write failure** | Postgres error mid-INSERT of `proposed_orders` | Fail-closed | `execution-engine` | Return `5xx`; do not `placeOrder`. |

## Timeouts (defaults, revisited in PR13 PLAN)

| Hop | Connect | Total | Notes |
| --- | --- | --- | --- |
| Orchestrator → `execution-engine` `POST /tickets` | 2 s | **5 s** | Short; ambiguous timeout triggers re-query. |
| Orchestrator → `execution-engine` `GET /reconciliation/latest` | 2 s | 5 s | Read-only, safe to retry. |
| `execution-engine` → IBKR `placeOrder` ack | broker-side | existing | Not changed by Phase 2. |
| Orchestrator internal per-instrument run | — | **1 s hard** | Pure compute; longer means bug. |

## Backoff

- Base: 250 ms, factor 2, jitter ±30 %, cap 4 s.
- Max attempts on transient class: **3**.
- On exhaustion → move ticket to `SUBMISSION_FAILED` + alert
  `SUBMISSION_EXHAUSTED`; **no further automatic retry**.

## Duplicate-submission prevention

Contract mandated by [STATE_AND_RECONCILIATION.md](STATE_AND_RECONCILIATION.md).
Enforced at four layers; failure at any one must fail-closed:

1. Orchestrator in-RAM key set (checked before HTTP call).
2. `client_order_id UNIQUE` at `execution-engine` (or OD-3
   equivalent).
3. `orderRef` echoed to IBKR — broker-side session dedup.
4. On ambiguous timeout, mandatory GET-before-retry.

Any code path that "just retries" without steps 1 and 4 is a
rejected review.

## Partial failures

| Scenario | Behaviour |
| --- | --- |
| `POST /tickets` returns `500` after DB row written but before broker send | `execution-engine` alerts `SUBMIT_UNKNOWN`; row stays `PROPOSED`. Orchestrator retries same key; server no-ops via `client_order_id UNIQUE`. |
| Broker acked but ack lost on socket bounce | Reconciliation reassigns `broker_order_id` on next report. Orchestrator holds the instrument until reconciliation is fresh. |
| Reconciliation finds broker order Orchestrator doesn't know about | Alert `RECON_ORPHAN_BROKER_ORDER`. Orchestrator refuses new tickets for that instrument until operator ack. |
| Orchestrator dies between ticket build and HTTP send | Ticket is lost — that is fine. No side effect at broker. Next snapshot recomputes; new idempotency key. |
| Orchestrator dies after `2xx` but before persisting the mapping locally | Recovery step (see STATE_AND_RECONCILIATION.md) rebuilds RAM set from Postgres. |

## IBKR connection loss

- `apps/execution-engine` behaviour already defined. Phase 2
  addition: Orchestrator **must** treat `/ready` = 503 or
  reconciliation staleness > `ORCH_MAX_RECON_AGE_S` as a
  loop-pause condition — not a per-request error. It stops
  enqueueing snapshots for evaluation until `/ready` returns 200.
- No auto-cancel on disconnect. Broker retains working orders.
  Reconciliation is what teaches us their state.

## Fail-closed rules (constitution)

- Missing / invalid Bearer → refuse.
- `IBKR_ENVIRONMENT=live` + `TRADING_ENABLED=false` → refuse
  (`423`, ADR-001).
- Instrument disabled → skip in Orchestrator run.
- `PRICE_NOT_FRESH` → do not build ticket.
- Reconciliation stale → pause loop, alert.
- Ambiguous submission state → do not retry blindly; query first.
- Unknown `proposed_orders` state at boot → alert, refuse
  submissions for the affected key.

## Kill switch

Two independent switches, either one halts writes:

1. **Master (existing).** `TRADING_ENABLED=false` on
   `execution-engine`. Restart required. `423` on every write
   endpoint.
2. **Orchestrator loop pause (new, PR11).** `ORCH_LOOP_ENABLED=false`
   env plus `POST /orchestrator/kill` runtime toggle (no restart).
   Loop pauses; already-submitted tickets are unaffected.

Neither switch cancels or modifies open broker orders. That is a
Phase 3 concern.

## Alerts (routing to existing Telegram + DB `system_alerts`)

| Kind | Trigger | Severity |
| --- | --- | --- |
| `AUTH_FAILURE` | `401` from `execution-engine` | HIGH |
| `SUBMISSION_EXHAUSTED` | Transient class hit max attempts | HIGH |
| `SUBMIT_UNKNOWN` | Post-body timeout, GET-before-retry inconclusive | CRITICAL |
| `RECON_MISMATCH_HOLD` | Orchestrator halts an instrument due to reconciliation | HIGH |
| `RECON_ORPHAN_BROKER_ORDER` | Reconciliation reports a broker order Orchestrator doesn't own | CRITICAL |
| `ORCH_LOOP_PAUSED` | Kill switch tripped | INFO |
| `BROKER_SESSION_DOWN` | `/ready` = 503 for > 60 s | HIGH |

OPEN DECISION (OD-6): Retry helper location — inline in
Orchestrator vs. shared `packages/shared/src/utils/retry.ts`.
Shared helper is cheap; inline avoids a public surface until we
have a second caller. Resolved before PR14.

OUT OF SCOPE: circuit-breaker across instruments, adaptive
backoff based on broker pacing headers.
