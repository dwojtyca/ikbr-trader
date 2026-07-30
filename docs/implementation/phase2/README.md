# Phase 2 — Runtime Integration (Documentation Kit)

> Status: **PR11–PR15 shipped as commit `87eff1c`**. PR15.1
> reconciles this doc kit with the shipped code. This kit
> continues to guide PR15.2, PR15.3, PR16–PR18. No production
> code changes land in a doc PR.

## Purpose

PRs 6–10 introduced pure, deterministic engines in
`packages/shared` (Market Context, Instrument Registry, Decision,
Risk, Signal, Execution Ticket). None are wired into a running
process yet. Phase 2 designs the orchestration, persistence,
scheduling, and reconciliation needed to run them end-to-end on
IBKR Paper — **without** rewriting `apps/execution-engine`,
`apps/signal-engine`, `apps/ingestion` or `apps/llm-agent`.

## Documents

| File                                                       | Scope                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| [PHASE_2_ROADMAP.md](PHASE_2_ROADMAP.md)                   | Ordered PR-by-PR plan for PR11 → PR18 with acceptance criteria.         |
| [CONFIGURATION.md](CONFIGURATION.md)                       | New env vars introduced across Phase 2 (owner / default / description). |
| [RUNTIME_FLOW.md](RUNTIME_FLOW.md)                         | End-to-end request flow, sync/async boundaries, module ownership.       |
| [STATE_AND_RECONCILIATION.md](STATE_AND_RECONCILIATION.md) | Source of truth, order lifecycle, restart recovery, idempotency.        |
| [FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md)         | Retry taxonomy, timeouts, fail-closed rules, kill switch, alerts.       |
| [TESTING_AND_ROLLOUT.md](TESTING_AND_ROLLOUT.md)           | Test layers, paper E2E gate, live-readiness checklist.                  |

## Non-goals

- Live trading. Live is deferred until an explicit go/no-go review
  after paper stability criteria in
  [TESTING_AND_ROLLOUT.md](TESTING_AND_ROLLOUT.md) are met.
- Rewriting `apps/execution-engine`. All new endpoints — if any —
  are additive and gated by ADR-001 auth.
- Retiring `apps/signal-engine` legacy pipeline. The new pipeline
  runs alongside it; legacy is switched off in a later PR once the
  new one demonstrates parity in paper.
- Multi-account, multi-broker, futures-roll automation.
- `TRADING_MODE` (`shadow` / `advisory` / `autonomous`) semantics
  — that is Phase 8.

## Rules (constitution for every Phase 2 PR)

1. **Paper-first.** Every PR must run against IB Gateway paper
   (`4002`). No live wiring, no live secrets, no live smoke.
2. **Fail-closed.** Any missing precondition (auth, config,
   broker session, reconciliation freshness, idempotency lookup)
   short-circuits to a structured rejection — never a best-effort
   submission.
3. **`execution-engine` is the only component that talks to
   IBKR for writes.** The Orchestrator (PR11) _proposes_; it does
   not `placeOrder`. Broker calls stay in
   [apps/execution-engine/src/tws-execution-client.ts](../../../apps/execution-engine/src/tws-execution-client.ts).
4. **Broker is the source of truth for open orders, fills, and
   positions.** Local Postgres is the source of truth for
   intent (`proposed_orders`) and audit. Divergences resolve in
   favour of the broker. See
   [STATE_AND_RECONCILIATION.md](STATE_AND_RECONCILIATION.md).
5. **Every write carries an idempotency key** end-to-end
   (Orchestrator → `proposed_orders` → broker `clientOrderId`).
   Details in [STATE_AND_RECONCILIATION.md](STATE_AND_RECONCILIATION.md).
6. **No new AI in the execution path.** `llm-agent` remains the
   only LLM caller. Orchestrator, Risk, Signal, Ticket, Execution
   stay deterministic.
7. **No Live.** `IBKR_ENVIRONMENT=live` in any Phase 2 PR is an
   automatic reject at review. Live-readiness work in the last PR
   ships infrastructure and docs only, gated behind
   `TRADING_ENABLED=false`.
8. **No schema drift without a documented migration.** Any change
   to `proposed_orders`, `broker_execution_fills`, or
   `execution_audit_log` requires a numbered migration and a
   backfill note.

## OPEN DECISIONS (all resolved as of PR15)

- OD-1 Orchestrator process placement.
  **Resolved (PR12 + PR13)**: hosted inside `apps/signal-engine`
  under `src/runtime/` (dry-run) and `src/runtime/execution/`
  (write). See MARKET_DATA_RUNTIME.md, EXECUTION_RUNTIME.md.
- OD-2 Ticket persistence: separate table vs. inline.
  **Resolved (PR13, verified PR15)**: no separate table;
  `proposed_orders` carries every order-critical field
  (migration 000005: `partial_take_profits`,
  `trailing_stop_pct`, `trailing_stop_activation_r`).
- OD-3 Idempotency surface.
  **Resolved (PR13)**: `client_order_id` + `client_order_hash`
  on `proposed_orders`, mandatory and server-recomputed via
  `@ikbr/shared/client-order-hash`.
- OD-4 Ticket submission API.
  **Resolved (PR13)**: reuse `POST /execution/execute-ticket`
  with `clientOrderId` + `clientOrderHash` in the JSON body.
  There is no `Idempotency-Key` header.
- OD-5 Scheduler owner.
  **Resolved (PR14)**: internal loop in signal-engine
  (`TRADING_LOOP_INTERVAL_MS`).
- OD-6 Retry ownership.
  **Resolved (PR13/PR15)**: inline in
  `apps/signal-engine/src/runtime/execution/` submitter and
  in `apps/execution-engine/src/reconciliation/submission-service.ts`.
  No new shared retry helper.

## Out of scope for Phase 2

- OUT OF SCOPE: Live trading rollout.
- OUT OF SCOPE: Multi-region / DR.
- OUT OF SCOPE: Order modification / replace / partial close (Phase 3
  in [ROADMAP.md](../ROADMAP.md)).
- OUT OF SCOPE: New strategies.
- OUT OF SCOPE: Advanced observability stack (Grafana dashboards).
  We ship metrics + structured logs; dashboards are a follow-up.
