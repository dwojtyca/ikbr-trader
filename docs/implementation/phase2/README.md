# Phase 2 — Runtime Integration (Documentation Kit)

> Status: **planning only**. No production code changes. This kit
> establishes the minimum architectural decisions required to wire
> the PR6–PR10 shared engines into a paper-trading runtime backed
> by `apps/execution-engine` and IBKR Paper.

## Purpose

PRs 6–10 introduced pure, deterministic engines in
`packages/shared` (Market Context, Instrument Registry, Decision,
Risk, Signal, Execution Ticket). None are wired into a running
process yet. Phase 2 designs the orchestration, persistence,
scheduling, and reconciliation needed to run them end-to-end on
IBKR Paper — **without** rewriting `apps/execution-engine`,
`apps/signal-engine`, `apps/ingestion` or `apps/llm-agent`.

## Documents

| File | Scope |
| ---- | ----- |
| [PHASE_2_ROADMAP.md](PHASE_2_ROADMAP.md) | Ordered PR-by-PR plan for PR11 → PR18 with acceptance criteria. |
| [CONFIGURATION.md](CONFIGURATION.md) | New env vars introduced across Phase 2 (owner / default / description). |
| [RUNTIME_FLOW.md](RUNTIME_FLOW.md) | End-to-end request flow, sync/async boundaries, module ownership. |
| [STATE_AND_RECONCILIATION.md](STATE_AND_RECONCILIATION.md) | Source of truth, order lifecycle, restart recovery, idempotency. |
| [FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md) | Retry taxonomy, timeouts, fail-closed rules, kill switch, alerts. |
| [TESTING_AND_ROLLOUT.md](TESTING_AND_ROLLOUT.md) | Test layers, paper E2E gate, live-readiness checklist. |

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
   IBKR for writes.** The Orchestrator (PR11) *proposes*; it does
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

## OPEN DECISIONS (tracked across the kit)

The following are recorded as `OPEN DECISION:` inline in the
documents where they arise:

- OD-1 Orchestrator process placement — new dedicated app,
  host inside `apps/signal-engine`, or a third option. Nothing
  in this kit assumes `apps/orchestrator` exists yet.
- OD-2 Ticket persistence: dedicated `execution_tickets` table vs.
  inlined JSONB column on `proposed_orders`.
- OD-3 Idempotency key surface: `client_order_id UNIQUE` column on
  `proposed_orders` vs. dedicated `order_idempotency` table.
- OD-4 Ticket submission API: new `POST /execution/tickets` vs.
  reuse `POST /execution/execute-ticket` with mandatory
  `proposedOrderId`.
- OD-5 Scheduler owner: cron inside Orchestrator vs. external
  trigger from `apps/ingestion` candle-close events.
- OD-6 Retry ownership: Orchestrator only vs. shared retry helper
  in `packages/shared`.

Every open decision is resolved *before* the PR that depends on it
starts. See [PHASE_2_ROADMAP.md](PHASE_2_ROADMAP.md) for gating.

## Out of scope for Phase 2

- OUT OF SCOPE: Live trading rollout.
- OUT OF SCOPE: Multi-region / DR.
- OUT OF SCOPE: Order modification / replace / partial close (Phase 3
  in [ROADMAP.md](../ROADMAP.md)).
- OUT OF SCOPE: New strategies.
- OUT OF SCOPE: Advanced observability stack (Grafana dashboards).
  We ship metrics + structured logs; dashboards are a follow-up.
