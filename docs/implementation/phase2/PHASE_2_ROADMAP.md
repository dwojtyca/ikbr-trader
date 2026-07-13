# Phase 2 — Roadmap (PR11 → PR18)

> One-line summary per PR; full plans land as
> `docs/implementation/phase2/PR<n>_PLAN.md` when the PR is picked up.
> Each PR must satisfy AGENTS.md workflow: PLAN → approval → implement →
> typecheck / test / build → hostile review → REPORT → stop.

## Ordering rationale

We wire the data edge before the write edge: **Market Data Runtime
(PR12) lands before Execution Runtime (PR13)** because a submission
built on stale or fake prices is worse than no submission at all.
Once real snapshots produce real tickets in memory, we add the
write edge (HTTP + persistence + idempotency) in a single PR,
then layer scheduling, reconciliation, an E2E paper window,
observability, and a live-readiness gate that never flips live on.

| PR   | Name                             | Gates on               |
| ---- | -------------------------------- | ---------------------- |
| PR11 | Execution Orchestrator           | OD-1, OD-6             |
| PR12 | Market Data Runtime              | PR11                   |
| PR13 | Execution Runtime                | PR12, OD-1, OD-2, OD-3, OD-4 |
| PR14 | Scheduler / trading loop         | PR13, OD-5             |
| PR15 | Reconciliation loop              | PR14                   |
| PR16 | Paper E2E                        | PR15                   |
| PR17 | Observability                    | PR16                   |
| PR18 | Live-readiness (docs + gates)    | PR17                   |

---

## PR11 — Execution Orchestrator

- **Goal.** A thin composition module in `packages/shared` that,
  given `SignalEvaluation + Instrument + Policy`, invokes
  `ExecutionTicketBuilder` and hands the resulting ticket to an
  injected `TicketSubmitter` port. **No new domain wrapper type.**
  Return values are exactly what the composed pieces already
  produce (`SignalEvaluation`, `ExecutionTicketBuildResult`, and
  the submitter's response).
- **Scope.** New `packages/shared/src/orchestrator/` module,
  the `TicketSubmitter` port interface, unit tests with a fake
  submitter, short architecture note in
  [../../architecture/](../../architecture/).
- **Acceptance.**
  - Orchestrator surfaces `ExecutionTicketBuildResult` unchanged
    on non-`ok` outcomes — no re-mapping into a new blocker set.
  - `TicketSubmitter` is the single injection point for I/O; the
    orchestrator itself performs no HTTP, Postgres, or broker call.
  - Unit tests cover: successful submitter dispatch, ticket
    builder failure short-circuits before submitter is invoked,
    idempotency key propagates from ticket to submitter payload.
  - `pnpm --filter @ikbr/shared test` green.
- **Excludes.** New result type, HTTP client, Postgres, broker
  call, scheduler, process shell.

## PR12 — Market Data Runtime

- **Goal.** Introduce the runtime process that instantiates the
  shared engines and the orchestrator, wires a **real**
  `MarketContextSnapshot` from `apps/ingestion` (Redis cache +
  Postgres candles) into it, and runs the pipeline **with a
  noop `TicketSubmitter`**. Snapshot assembly, freshness
  checking, and dry-run inspection land here.
- **Scope.** New runtime process (location per OD-1), snapshot
  adapter, `GET /health` + `GET /ready`, `POST /orchestrator/dry-run`
  returning the raw `ExecutionTicketBuildResult`.
- **Acceptance.**
  - Docker-compose service starts; `/ready` returns 200 only when
    Postgres and Redis reads succeed.
  - Real fixture symbol produces the same
    `ExecutionTicketBuildResult` as the equivalent PR11 unit test.
  - `PRICE_NOT_FRESH` blocker emitted when Redis last-tick age
    exceeds policy — asserted by an integration test.
  - Zero broker calls (verified: `ib.placeOrder` never invoked).
- **Excludes.** Any real submission, persistence, scheduler.

## PR13 — Execution Runtime

- **Goal.** Turn on the write edge: a real HTTP `TicketSubmitter`
  targets `apps/execution-engine`, and the first paper submission
  goes through end-to-end. Idempotency infrastructure lands **in
  the same PR** so no submission ever exists without a persisted,
  unique client-order-id.
- **Scope.**
  - HTTP submitter with the retry / timeout contract from
    [FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md).
  - `execution-engine` migration for idempotency (per OD-3).
  - Ticket persistence (per OD-2).
  - Ticket-submission endpoint (per OD-4).
  - Contract-test fixtures under
    `apps/execution-engine/src/__contract__/`.
- **Acceptance.**
  - Every `proposed_orders` row carries a unique client-order-id;
    unique-violation returns `200 { duplicate: true }` with the
    original `proposedOrderId` — no second `ib.placeOrder`.
  - GET-before-retry path exercised in a fault-injection test.
  - First paper submission observed at IBKR Paper; local state
    matches broker state after 60 s.
  - `TRADING_ENABLED=false` still short-circuits with `423`.
- **Excludes.** Modify / cancel / partial close (Phase 3 in
  main [ROADMAP.md](../ROADMAP.md)), scheduler.

## PR14 — Scheduler / trading loop

- **Goal.** A single trigger source drives orchestrator runs per
  instrument. See OD-5.
- **Acceptance.** Loop is idempotent per `(instrumentId, candleTs)`
  tuple — re-firing the same trigger produces one and only one
  orchestrator run and at most one broker submission.
- **Excludes.** Multi-timeframe fan-out (deferred to a later PR).

## PR15 — Reconciliation loop

- **Goal.** Orchestrator consumes `execution-engine` reconciliation
  reports (poll or push, resolved in PR15 PLAN) and holds
  affected instruments on mismatch. Adds
  `GET /execution/reconciliation/latest` if missing.
- **Acceptance.** Restart-recovery test: kill orchestrator after
  submission, restart, verify no duplicate submission and correct
  terminal state pulled from broker within `ORCH_MAX_RECON_AGE_S`.
- **Excludes.** Automated position closes triggered by
  reconciliation mismatches — alerting only in this PR.

## PR16 — Paper E2E

- **Goal.** Green end-to-end paper run across ≥ 3 symbols,
  ≥ 24 hours, with reconciliation clean and no manual
  intervention.
- **Acceptance.** See "paper stability criteria" in
  [TESTING_AND_ROLLOUT.md](TESTING_AND_ROLLOUT.md).
- **Excludes.** Perf tuning; go/no-go for live.

## PR17 — Observability

- **Goal.** Structured logs, Prometheus-style counters/gauges,
  and alert routing (Telegram already in
  [apps/execution-engine/src/alerts.ts](../../../apps/execution-engine/src/alerts.ts))
  extended to the orchestrator process.
- **Acceptance.** Every kill-switch trip, reconciliation mismatch,
  idempotency hit, and broker-disconnect emits both a metric and an
  alert. Every alert kind has a runbook under `docs/runbooks/`.
- **Excludes.** Grafana dashboards, SLO catalog.

## PR18 — Live-readiness (docs + gates only)

- **Goal.** Document + code-enforce the live cutover checklist.
  `TRADING_ENABLED` stays `false`. Live secrets stay absent.
- **Acceptance.** Startup refuses to boot with
  `IBKR_ENVIRONMENT=live` unless every checklist item passes;
  checklist is copy-pasted into
  [TESTING_AND_ROLLOUT.md](TESTING_AND_ROLLOUT.md) and
  `LIVE_GO_NOGO.md` is created (empty template).
- **Excludes.** Actually flipping live.

---

OUT OF SCOPE across Phase 2: modify / cancel / replace lifecycle
(Phase 3), new strategies, futures roll, multi-account, LLM in the
execution path.
