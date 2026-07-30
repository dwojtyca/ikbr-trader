# Failure & Recovery — Phase 2

> Status (r2, PR15 shipped as commit `87eff1c`): the retry
> taxonomy below reflects the shipped `submission-service` +
> `execute-ticket` orchestrator, not the earlier
> orchestrator-as-separate-process draft. Endpoint is
> `POST /execution/execute-ticket`; ambiguous outcomes are
> resolved by reconciliation, not by a client-side re-query.

## Retry taxonomy

| Class | Examples | Retry? | Owner | Notes |
| --- | --- | --- | --- | --- |
| **Deterministic reject** | `INVALID_QUANTITY`, `RISK_NOT_APPROVED`, `INSTRUMENT_DISABLED`, HTTP `400`, `422`, `423` (`live_trading_disabled`), `403` | **No** | signal-engine runtime | Record `REJECTED_BY_*`; no retry. |
| **Auth failure** | HTTP `401` | **No** | runtime | Alert `AUTH_FAILURE`; refuse further submissions until config reloaded. |
| **Idempotency hit** | HTTP `200 { duplicate: true, outcome: DUPLICATE_* \| PENDING_CLAIMED }` | **No** | runtime | Update local state from response; **do not** resend. |
| **UNKNOWN (network / timeout / 5xx)** | ECONNRESET, connect timeout, HTTP `500/502/503/504` | **No auto-retry** | runtime | The submitter classifies these as `UNKNOWN` and returns without resending. Row stays `PROPOSED`; recovery is reconciliation-driven. Manual re-drive is an operator action, never a client-side loop. |
| **Ambiguous (server-side)** | HTTP 200 with `outcome: DUPLICATE_PENDING_AMBIGUOUS` | **No** | runtime | Row stays `PROPOSED` with ambiguous marker + persisted plan; reconciliation resolves. |
| **Broker session down** | `execution-engine` reports `503` from `/ready` or `SUBMIT_REJECTED_BROKER_DOWN` | Pause loop | runtime | Halt new submissions; resume when `/ready` returns 200. |
| **IBKR-level reject** | Cancel codes `201`, `320`, pacing violations | **No** | `execution-engine` (existing) | Alert + terminal state. |
| **DB write failure** | Postgres error mid-INSERT of `proposed_orders` | Fail-closed | `execution-engine` | Return `5xx`; do not `placeOrder`. |

## Timeouts (defaults)

| Hop | Connect | Total | Notes |
| --- | --- | --- | --- |
| runtime → `execution-engine` `POST /execute-ticket` | 2 s | **5 s** | On timeout the outcome is `UNKNOWN`; no auto-retry. |
| runtime → `execution-engine` `GET /reconciliation/latest` | 2 s | 5 s | Read-only, safe to re-run manually. |
| runtime → `execution-engine` `GET /reconciliation/holds?active=…` | 2 s | 5 s | Read-only. |
| `execution-engine` → IBKR `placeOrder` ack | broker-side | existing | Not changed by Phase 2. |
| runtime per-instrument cycle | — | **1 s hard** | Pure compute; longer means bug. |

## No client-side backoff

The runtime does **not** ship a retry helper, exponential
backoff, or a `Set<clientOrderId>` cache. Duplicate-suppression
is authoritative in the database (`client_order_id UNIQUE` on
`proposed_orders`) and in the submission service (idempotency
replay outcome union). The runtime's job is to submit once, log
the outcome, and let reconciliation resolve anything ambiguous.

If a caller ever re-submits the same trigger, the server-side
idempotency layer returns HTTP 200 with `duplicate: true` and one
of `DUPLICATE_SUBMITTED | DUPLICATE_TERMINAL |
DUPLICATE_PENDING_AMBIGUOUS | PENDING_CLAIMED` — no second
`ib.placeOrder`.

## Duplicate-submission prevention

Enforced authoritatively at the database + service layers (see
[STATE_AND_RECONCILIATION.md](STATE_AND_RECONCILIATION.md)):

1. `client_order_id UNIQUE` on `proposed_orders`.
2. Server-recomputed `clientOrderHash` echoed back on duplicate.
3. Submission-service replay path returns
   `DUPLICATE_SUBMITTED | DUPLICATE_TERMINAL |
   DUPLICATE_PENDING_AMBIGUOUS | PENDING_CLAIMED` without a
   second `ib.placeOrder`.
4. `orderRef` echoed to IBKR — broker-side session dedup.
5. Process-local `Map<instrumentId, Promise<void>>` in
   `trading-loop-service` prevents overlapping ticks for the
   same instrument within a single runtime process. This is a
   liveness guarantee, not a correctness guarantee — the
   authoritative dedup is layers 1–4.

Nothing in the runtime keeps an in-RAM `Set<clientOrderId>`;
correctness after restart therefore depends only on the DB
`UNIQUE` constraint and the reconciliation layer, not on
cache rehydration.

## Partial failures

| Scenario | Behaviour |
| --- | --- |
| `POST /execute-ticket` returns `500` after DB row written but before broker send | `execution-engine` alerts `SUBMIT_UNKNOWN`; row stays `PROPOSED`. runtime retry via same `clientOrderId` no-ops server-side. |
| Broker acked but ack lost on socket bounce | Reconciliation reassigns `broker_order_id` on next report. runtime holds the instrument until reconciliation is fresh. |
| Reconciliation finds broker order runtime doesn't know about | Alert `RECON_ORPHAN_BROKER_ORDER`. runtime refuses new tickets for that instrument until operator acknowledges the reconciliation hold. |
| runtime dies between ticket build and HTTP send | Ticket is lost — no side effect at broker. Next cycle recomputes; new `clientOrderId`. |
| runtime dies after `2xx` but before persisting the mapping locally | Recovery step rebuilds RAM set from Postgres before any submission is allowed. |

## IBKR connection loss

- `apps/execution-engine` behaviour unchanged. runtime must treat
  `/ready` = 503 or reconciliation staleness as a loop-pause
  condition — not a per-request error. It stops enqueueing
  snapshots for evaluation until `/ready` returns 200.
- No auto-cancel on disconnect. Broker retains working orders.
  Reconciliation is what teaches us their state.

## Fail-closed rules (constitution)

- Missing / invalid Bearer → refuse.
- `IBKR_ENVIRONMENT=live` + `TRADING_ENABLED=false` → refuse
  (`423`, ADR-001).
- Instrument disabled → skip in runtime.
- `PRICE_NOT_FRESH` → do not build ticket.
- Reconciliation stale OR active hold → pause loop, alert.
- Ambiguous submission state → do not retry; wait for
  reconciliation.
- Unknown `proposed_orders` state at boot → alert, refuse
  submissions for the affected key.

## Kill switches

Multiple independent switches; either one halts writes:

1. **Master (existing).** `TRADING_ENABLED=false` on
   `execution-engine`. Restart required. `423` on every write
   endpoint.
2. **Runtime pause.** `EXECUTION_RUNTIME_ENABLED=false` or
   `TRADING_LOOP_ENABLED=false` on signal-engine boot.
3. **Daily-loss guard.** `execution-engine` kill-switch state
   surfaced via `GET /execution/kill-switch`; `triggered=true`
   halts submissions.

None of these switches cancels or modifies open broker orders.
Cancels / modifies are a Phase 3 concern.

## Alerts (routing to existing Telegram + DB `system_alerts`)

| Kind | Trigger | Severity |
| --- | --- | --- |
| `AUTH_FAILURE` | `401` from `execution-engine` | HIGH |
| `SUBMIT_UNKNOWN` | Post-body timeout or 5xx from `execute-ticket`; no reconciliation resolution yet | CRITICAL |
| `RECON_MISMATCH_HOLD` | Reconciliation places an active hold | HIGH |
| `RECON_ORPHAN_BROKER_ORDER` | Reconciliation reports a broker order the runtime doesn't own | CRITICAL |
| `TRADING_LOOP_PAUSED` | Runtime or scheduler disabled | INFO |
| `BROKER_SESSION_DOWN` | `/ready` = 503 for > 60 s | HIGH |

OUT OF SCOPE: circuit-breaker across instruments, adaptive
backoff based on broker pacing headers, exit management (PR16).
