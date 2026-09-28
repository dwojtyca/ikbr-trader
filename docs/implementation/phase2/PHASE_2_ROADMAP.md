# Phase 2 — Roadmap (PR11 → PR18)

## Documentation status — 2026-09-28

Historical plan/report: dates, test counts, commit evidence, limitations and
next-step instructions below describe the original work package. They are retained
as evidence, not the current delivery queue or authorization to activate trading. The earlier entry-only/PKO-first ordering is superseded by the owner's
production-style Paper objective with independent strategy and instrument
configuration. Mandatory AI and narrow full-close have since been implemented.

Current authority: [capability/evidence matrix](../CURRENT_STATE.md) and [detailed delivery plan](../phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md).

## Historical work-package record

> **Status (reviewed 2026-09-23):** PR11–PR15 shipped as commit `87eff1c`.
> Current local and remotely verified `main`: `9361313` (PR15.5E).
> PR15.5F is uncommitted work; its independent preparation review found
> blockers. See current audit (unpublished local draft `PROJECT_STATUS_REVIEW_2026_09_23.md`).
> PR15.1 (doc reconciliation + read-only paper-verify tool),
> PR15.2 (authoritative instrument binding), and PR15.3
> (entry-only Paper E2E) are follow-up sub-tracks under PR15.
> The pipeline is still **entry-only**; exit management lands
> in the lifecycle track. The legacy `apps/llm-agent` EXECUTE/REJECT gate
> is currently isolated from the new pipeline; its freshly generated legacy
> proposals lack required execution identity. This historical separation is
> the next integration gap to close, not the intended target architecture.
>
> One-line summary per PR; full plans land as
> `docs/implementation/phase2/PR<n>_PLAN.md` when the PR is picked up.
> Each PR follows the owner's updated workflow: detailed PLAN → independent
> plan acceptance → implementation → new independent implementation review
> and corrections → all checks → REPORT → commit/push → GitHub CI → stop.

## PR15 sub-tracks

| Sub-track | Scope                                                                                                                                                                                                                                | Status                                                                                                                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR15      | Three-phase submission + reconciliation + `client_order_id/hash`                                                                                                                                                                     | **shipped `87eff1c`**                                                                                                                                                                                                                                                                                                                                          |
| PR15.1    | Doc reconciliation, CI `pnpm lint`, `paper:verify-stack` tool (read-only, GET-only, allowlist-bound), runbook                                                                                                                        | **shipped** (see [PR15_1_REPORT.md](PR15_1_REPORT.md))                                                                                                                                                                                                                                                                                                         |
| PR15.2    | Authoritative instrument binding (still no `executionEnabled=true` flip)                                                                                                                                                             | **shipped `1472a33`** (see [PR15_2_REPORT.md](PR15_2_REPORT.md))                                                                                                                                                                                                                                                                                               |
| PR15.3    | Entry-only Paper E2E window against IB Gateway paper                                                                                                                                                                                 | **blocked, not ready** — activation rolled back after r2 (Findings 1 & 2), further hardened in r3 (Findings 1–4) and r4 (Findings 1–5: exempt-routes account allowlist, `docker compose exec` fix, full Phase D verifier env, cancel-identifier disambiguation, doc sweep). See [PR15_3_PLAN.md](PR15_3_PLAN.md) §11 and [PR15_3_REPORT.md](PR15_3_REPORT.md). |
| PR15.4    | Strategy attribution + fail-closed direction gate; loop-owned `StrategyPortfolioManager` + attribution chain; typed `SignalBlocker`; exact-`conId` `StrategyContextLoader`; `ExecutionRuntime.executePrepared` four-stage validation | **shipped `53213fe`**; independent review and PR15.4.1 stabilization complete (see [PR15_4_PLAN.md](PR15_4_PLAN.md), [PR15_4_REPORT.md](PR15_4_REPORT.md), and [PR15_4_1_REPORT.md](PR15_4_1_REPORT.md)) |
| PR15.4.1  | Clean-checkout CI, direct dependency declaration, trading-loop error redaction, and vulnerable transitive dependency updates | **shipped `8a2f923`**; CI run `34979744641` green |
| PR15.5    | Controlled entry-only Paper E2E unlock for one instrument | **blocked**; credible D.3 evidence is negative (`REJECTED_FOR_ES`), so ES activation is not eligible |
| PR15.5A   | Static ES compatibility prerequisite closure, profile correction, and contract tests | **shipped `70f7f9b`; terminal `INCONCLUSIVE`; CI run `34986037525` green** |
| PR15.5B   | Futures backtest execution and economics model | **shipped `bcf0344`; CI run `34998202271` green; independent hostile review approved** (see [PR15_5B_REPORT.md](PR15_5B_REPORT.md)) |
| PR15.5C   | Reproducible, fingerprinted ES dataset and contract/calendar metadata | **shipped `5de9de6`; CI run `35064103236` green; independent hostile review approved; data readiness `INCONCLUSIVE`** (see [PR15_5C_REPORT.md](PR15_5C_REPORT.md)) |
| PR15.5C.1 | IBKR ES source parity and immutable dataset acquisition | **COMPLETE / READY: IBKR bundle acquired and imported; provenance `ibkr-es-20250622-20260831-e39a59790324`, fingerprint `6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026`, 99.9858% selected-contract completeness; dataset remains frozen for PR15.5D.2 and any separately approved future attempt** (see [PR15_5C_1_REPORT.md](PR15_5C_1_REPORT.md)) |
| PR15.5D   | Pre-registered ES compatibility experiment on the finalized real dataset | **Authorized attempt closed `INCONCLUSIVE`: continuous-contract projection defect before any order or fill; dataset unchanged; experiment incomplete and remediation required; no ES activation** (see [PR15_5D_STAGE_B_REPORT.md](PR15_5D_STAGE_B_REPORT.md), [PR15_5D_ES_DECISION_RECORD.md](PR15_5D_ES_DECISION_RECORD.md)) |
| PR15.5D.1 | Active-contract projection remediation and newly registered ES compatibility experiment | **TERMINAL `INCONCLUSIVE`: v2 was operator-aborted after 3,085 seconds without reaching the first 10,000-event checkpoint; recovery hash `4bd17e9fab5ea15150810b784da3afa4a04e959ab5511b72dae666ddd520b44c`; performance remediation required** (see [Stage B report](PR15_5D_1_STAGE_B_REPORT.md)) |
| PR15.5D.2 | Backtest hot-path performance remediation and benchmark tooling | **code committed `4bf079f`, `e814a99`, `50a8b07`; separate Stage A closure evidence incomplete; real attempt moved to D.3**. Do not repeat D.2 as the next stage or mark its full benchmark protocol passed (see [plan](PR15_5D_2_PERFORMANCE_REMEDIATION_PLAN.md), [D.3 deviations](PR15_5D_3_STAGE_B_REPORT.md)) |
| PR15.5D.3 | Three-worker parallel execution of the registered ES scenarios | **TERMINAL `REJECTED_FOR_ES`: all three 423,300-event scenarios completed concurrently and reproducibly with zero trades; artifact `9fc53b1618a489524db1717e0b5eb812fb1d7ebdc03e9ac675f1a7198fb129d5`** (see [Stage B report](PR15_5D_3_STAGE_B_REPORT.md)) |
| PR15.5E | Deterministic mechanical backtest E2E through signal, risk, order, fill, lifecycle, persistence, and metrics | **committed `9361313`; exact 6-trade primary, stress, and reproduction paths verified; PostgreSQL fixture rechecked 2026-09-23**. No broker/Paper proof (see [report](PR15_5E_REPORT.md)) |
| PR15.5F | Research-only diagnosis of the terminal ES zero-signal result | **LOCAL IMPLEMENTATION; preparation review BLOCKED: shutdown supervision, effective memory, peak RSS, durable failure reasons, and test coverage**. Full replay remains pending (see plan (unpublished local draft `PR15_5F_ES_SIGNAL_DIAGNOSTICS_PLAN.md`), review (unpublished local draft `PROJECT_STATUS_REVIEW_2026_09_23.md`)) |

## Current priority — owner direction after the 2026-09-23 audit

**Single-instrument Paper mechanics first; instrument-specific strategy tuning
later.** The [mechanics delivery track](PAPER_MECHANICS_DELIVERY.md) supersedes
the ES-first ordering below. PR15.5F remains deferred, unfinished local work,
not a prerequisite for the next Paper mechanics PR. Its findings remain open.

The first integration gap is mandatory AI adjudication of bound runtime
proposals: the runtime currently dispatches directly, while legacy proposals
consumed by `llm-agent` lack the idempotency identity required for execution.
Neither existing path alone proves the requested complete flow. Do not simply
enable the legacy agent or the trading loop and label this Paper-ready.

Implementation PRs follow the owner's process: detailed plan → independent
plan review and correction until accepted → implementation → a new independent
implementation reviewer and correction until accepted → all local checks →
commit/push → verify GitHub CI. The owner authorized this engineering workflow
without repeated approval requests. A plan review does not authorize a broker
window; that remains separate. Keep unrelated unfinished F code out of commits.

## Deferred ES PR sequence — historical proposal from the 2026-09-23 audit

The following sequence is retained for a possible future return to ES research;
it is not the next implementation queue. This sequence does not authorize research runs, strategy changes,
activation, or broker writes. PR labels below are repository work packages;
they are not verified GitHub pull-request numbers.

| Order | Work package | Completion gate |
| --- | --- | --- |
| 1 | Finish PR15.5F preparation in the current PR | Resolve the review findings and §7 checklist; repository gates, disposable fixture/store failure tests, real-source read-only preflight, compiled-image evidence, independent re-review, refreshed forecast |
| 2 | PR15.5F Stage B (separate launch decision) | Owner confirms AC and approves the reviewed replay; exactly 423,300 events, frozen histogram, zero orders/fills, reconciled cohorts, unchanged source, archived artifact and resource/recovery evidence; report one ranked hypothesis |
| 3 | Proposed PR15.5G — one research hypothesis, only if F supports it | Preregister one candidate, frozen economics, independent validation period and acceptance/rejection gates before testing. No broad sweep or retroactive D.3 verdict change; absent a defensible hypothesis, stop the ES branch. A new strategy needs explicit separate scope |
| 4 | Proposed PR17A — minimum operator monitoring | Structured correlation across intent/submission/reconciliation, alerts for unknown submission, stale broker state, disconnect and kill switch, and tested runbooks before any Paper window. Can be developed independently of ES research |
| 5 | Separate production eligibility/activation PR, then PR15.5 controlled Paper window | Positive compatibility evidence plus explicit approval of production strategy/profile support and one exact instrument/contract/policy; fresh binding, risk, reconciliation and rollback/abort checks. Start with one instrument; no automatic `FUT` flag or seed activation |
| 6 | PR16A/B/C — Phase 3 lifecycle work | Ownership/recovery first, then one-instrument full close, then partial close/replace/trailing behavior; separate plans and tests below. Mock/fixture preparation can precede Paper, broker acceptance cannot |
| 7 | PR17B then PR18 | Complete lifecycle observability after PR16; readiness evidence/gates only after Paper acceptance. No live enablement |

An alternative supported non-ES instrument may be proposed in a separate
approved plan; this review does not silently replace the ES research scope.
Do not require three-symbol expansion before the one-instrument lifecycle is
proven. Expand only with explicit per-instrument compatibility and risk gates.

## Ordering rationale

We wire the data edge before the write edge: **Market Data Runtime
(PR12) lands before Execution Runtime (PR13)** because a submission
built on stale or fake prices is worse than no submission at all.
Once real snapshots produce real tickets in memory, we add the
write edge (HTTP + persistence + idempotency) in a single PR,
then layer scheduling, reconciliation, mandatory AI entry adjudication,
minimum safe full-close capability and monitoring, the one-instrument Paper
round-trip window, advanced lifecycle/observability, and a live-readiness gate
that never flips live on.

| PR   | Name                          | Gates on                     |
| ---- | ----------------------------- | ---------------------------- |
| PR11 | Execution Orchestrator        | OD-1, OD-6                   |
| PR12 | Market Data Runtime           | PR11                         |
| PR13 | Execution Runtime             | PR12, OD-1, OD-2, OD-3, OD-4 |
| PR14 | Scheduler / trading loop      | PR13, OD-5                   |
| PR15 | Reconciliation loop           | PR14                         |
| PR16A/B/C | Position / exit management (Phase 3) | PR15 reliability; controlled Paper gate for broker acceptance |
| PR17A | Minimum operator monitoring | PR15; required before Paper window |
| PR17B | Lifecycle observability | PR16 and PR17A |
| PR18 | Live-readiness (docs + gates) | PR17B and completed Paper evidence |

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

- **Goal.** Paper-only scheduler inside `apps/signal-engine` that
  periodically drives the PR13 `ExecutionRuntime` per instrument.
  ENTRY ONLY.
- **Placement.** `apps/signal-engine/src/runtime/trading-loop/`.
  Same process, separate lifecycle, own enable flag
  (`TRADING_LOOP_ENABLED`, default `false`), graceful drain.
  See [../../architecture/TRADING_LOOP.md](../../architecture/TRADING_LOOP.md).
- **Idempotency key (v4, round-5 semantics).**
  - `clientOrderId` = `loop:v4:<instrumentId>:<strategyId>:<triggerId>`
    — identifies the trigger only. NOT the payload.
  - `clientOrderHash` = `computeClientOrderHash(ticket)` —
    identifies the payload. `ExecutionRuntime` always re-derives
    it from the ticket, never trusts a caller-supplied value.
  - `triggerId` = `evaluation.<timeframe>.<bucketStartMs>` —
    labelled `evaluation` (not `candle`) because
    `floor(observedAt / timeframe)` is a bucket, not a proven
    candle close.
  - Same trigger + changed payload → SAME id, different hash →
    execution-engine returns `CONFLICT` (round-5 fix — the
    round-4 format baked payload into id and lost this signal).
- **Per-instrument execution policy.**
  `Instrument.executionPolicy` (new shared type) supplies every
  order-critical parameter — `strategyId`, `timeframe`,
  `quantity`, `maxQuantity`, `priceTickSize`,
  `allowedOrderTypes`, TIF, `outsideRth`, `transmit`, bracket
  distances. No global default; missing / invalid policy →
  fail-closed `INSTRUMENT_POLICY_UNAVAILABLE`. `priceTickSize`
  MUST come from validated registry metadata.
- **Exposure enforcement — two layers.**
  1. Signal-engine reads exposure + summary from execution-engine
     BEFORE the pipeline runs (fast fail-closed pre-check with
     `retrievedAt` freshness validation).
  2. Execution-engine holds the AUTHORITATIVE atomic guard: under
     one `pg_advisory_xact_lock(hashtext(instrument))`, refuses:
     - any non-terminal `PROPOSED` / `SUBMITTED` for the
       instrument under a DIFFERENT `client_order_id` →
       `ACTIVE_INTENT_EXISTS`
     - broker-reported non-zero position (persisted in
       `broker_position_snapshots`, identity policy per
       `Instrument.executionPolicy.allowCrossContractExposure`) →
       `OPEN_POSITION_EXISTS`
     - missing / stale / incomplete broker snapshot →
       `POSITION_STATE_UNAVAILABLE`
     - snapshot written by a different `session_id` than the
       current process (`reason: "wrong_session"`, round-6
       blocker fix) → `POSITION_STATE_UNAVAILABLE`
     - explicit `PositionGuardContext.kind === "unavailable"`
       (no active broker account) → `POSITION_STATE_UNAVAILABLE`
       with `reason: "no_active_account"` (round-5 fail-closed)
- **PositionGuardContext is REQUIRED (round-6).**
  `insertProposedFromTicket` and the new
  `tryStartSubmissionWithExposureGuard` both accept a
  `PositionGuardContext` positional parameter that is NOT
  optional — a compile-time regression test enforces this at
  the type boundary so no code path can bypass the check.
  `PositionGuardContext.available` carries `sessionId` alongside
  `accountId` / `maxSnapshotAgeMs`.
- **Unified pre-submission gate on the RESUME path (round-6).**
  The atomic marker acquisition
  (`tryStartSubmissionWithExposureGuard`) now runs the SAME
  exposure guard body inside the SAME transaction and advisory
  lock as the fresh-INSERT path. This closes the round-5
  hole where a retry on a clean `PROPOSED` row would bypass
  the account / session / snapshot / open-position check.
- **Position identity policy (round-6/7).**
  `Instrument.executionPolicy.allowCrossContractExposure` is
  retained on the shared type for a future registry-resolved
  path, but for PR14 the value is SERVER-SIDE hardcoded
  (`SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE = false`) at every
  guard call site. The public
  `POST /execution/execute-ticket` request body does NOT
  expose the field — a compile-time regression test proves the
  parsed body type has no such property. Any strategy that
  legitimately needs cross-contract exposure in a future PR
  MUST have it resolved from a trusted server-side
  instrument-registry policy — never from the request body.
  Guard semantics under `false`: any non-zero position sharing
  the broker symbol blocks regardless of conId. Partial unique
  indexes still enforce split identity at the persistence
  layer for the retained conId-aware code path.
- **Broker-driven snapshot refresher (round-7).** The write-
  path exposure guard is fed by a per-account serialised
  refresher with a TWO-PHASE contract
  (`beginPositionSnapshotRefresh` +
  `completePositionSnapshotRefresh`). During a refresh
  `broker_snapshot_syncs.complete=false` — the guard
  fail-closes with `POSITION_STATE_UNAVAILABLE (incomplete)`.
  Triggers: startup after `ensureBrokerSession`, every FILLED
  order in `executePersistedOrder`, explicit
  `POST /execution/refresh-position-snapshot`, and
  `GET /execution/account/summary` (now awaited, no more
  fire-and-forget). Refresh health is published to
  `/ready` — `position_snapshot_never_synced` /
  `position_snapshot_refresh_in_flight` /
  `position_snapshot_refresh_failed` distinguish the failure
  mode.
- **Separated TTLs (round-7).** New
  `EXECUTION_POSITION_GUARD_MAX_AGE_S` (default 10 s) —
  authoritative write-path guard freshness. The old
  `EXECUTION_POSITION_MAX_AGE_S` (default 60 s) is now
  DISPLAY-ONLY for the account-summary cache. The write path
  no longer inherits the display TTL.
- **Fill-to-position invalidation contract (round-8).** Every
  broker-side event that MAY change exposure (direct FILLED,
  async orderStatus=FILLED, partial fill / executionDetails,
  reconciliation mismatch) awaits
  `invalidatePositionSnapshot(accountId)` BEFORE the local
  order-lifecycle transition, and only THEN fires the full
  broker-driven refresh. If the refresh fails, the write path
  stays fail-closed until the next successful refresh.
- **Snapshot lock protocol + generation fence (round-8).** Two
  advisory-lock keys — `hashtext('snap:' || account_id)` and
  `hashtext(instrument)`. Submission guard acquires the
  account lock FIRST, then the instrument lock; refresh only
  takes the account lock — deadlock-free by construction.
  `broker_snapshot_syncs` gains a monotonic `generation`
  column; `beginPositionSnapshotRefresh` bumps it and
  `completePositionSnapshotRefresh` refuses to overwrite a
  NEWER generation (`{ kind: "stale_generation" }`), so a
  slow in-flight refresh cannot clobber a fresh one.
- **Account-summary failure semantics (round-8).**
  `GET /execution/account/summary` returns **503** with
  `error: "position_snapshot_persistence_failed"` when the
  awaited refresh ends in `SnapshotHealth.failed`. No more
  silent 200 with a live-but-unpersisted snapshot.
- **Refresh endpoint auth (round-8).**
  `POST /execution/refresh-position-snapshot` inherits the
  standard Bearer + audit middleware. Missing / wrong token →
  401; healthy → 200; failed → 503. Regression-covered by
  `refresh-position-snapshot.route.test.ts`.
- **Generation-aware refresh coordinator (round-9).**
  `RefreshCoordinator` runs a bounded loop that reacts to
  invalidations landing during an in-flight broker fetch —
  fixes the silent-loss race where a naive
  `if (existing) return existing` coalescer would leave
  `complete=false` forever after a fill invalidation. Loop
  exits `healthy` when persisted status is `complete=true` at
  the current generation, `failed` on any unrecoverable
  broker/DB error, and `failed / did not converge` after
  `MAX_REFRESH_LOOP_ITERATIONS`. `getPositionSnapshotStatus`
  exposes `generation` so the coordinator can recognise
  "newer refresh already completed on our behalf" without an
  extra fetch. Regression-covered by
  `refresh-coordinator.test.ts` (7 deterministic tests
  including three-invalidations-during-slow-fetch,
  stale_generation-but-newer-complete, rerun-fetch-failure,
  and MAX_ITERATIONS bound).
- **Broker callback account identity (round-9).** Fill callback
  prefers `fill.accountId` when provided and skips invalidation
  when it does not match `lastActiveAccountId`. Order-status
  callback documents the SINGLE-ACTIVE-ACCOUNT invariant.
- **Acceptance.** Two concurrent requests with different
  `clientOrderId`s but the SAME instrument produce EXACTLY one
  `proposed_orders` row and at MOST one broker submission.
  Historic FILLED with same intent does NOT block a new trigger.
  Open broker position blocks entry via the atomic guard even
  when every prior order row is terminal.
- **PostgreSQL integration test.** New
  `apps/execution-engine/src/repository.pg-integration.test.ts`
  covers the advisory lock against a real Postgres (gated on
  `TEST_POSTGRES_URL`).
- **Manual controls.** `GET /runtime/trading-loop/status`,
  `POST /runtime/trading-loop/run-once`,
  `GET /runtime/trading-loop/ready` (composite: paper guard +
  exposure reader (both endpoints) + Redis + Postgres).
- **Excludes.** Multi-timeframe fan-out, position closes,
  reconciliation of orphan `PROPOSED`, pyramiding, trailing-stop
  management, live trading.

## PR15 — Reconciliation loop

- **Goal.** Signal-engine consumes `execution-engine` reconciliation
  reports (poll or push, resolved in PR15 PLAN) and holds
  affected instruments on mismatch. Adds
  `GET /execution/reconciliation/latest` if missing. Resolves the
  ambiguous PROPOSED + `executionAttemptedAt` state left after a
  crash between marker and broker call (see PR13
  `EXECUTION_RUNTIME.md` §Crash windows).
- **Acceptance.** Restart-recovery test: kill signal-engine after
  submission, restart, verify no duplicate submission and correct
  terminal state pulled from broker within
  `SIGNAL_MAX_RECON_AGE_S`.
- **Excludes.** Automated position closes triggered by
  reconciliation mismatches — alerting only in this PR.

## PR16 — Position / exit management

- **Phase boundary.** This is Phase 3 Order Lifecycle in the main roadmap,
  retained here for sequencing. It does not expand the Phase 2 reliability
  scope or replace existing close/cancel primitives.
- **PR16A — ownership and recovery.** Resolve account, conId, strategy,
  loop-owned position and broker child orders before producing an exit intent.
  Cover restart, manual/foreign positions, partial fills and stale snapshots;
  ambiguous ownership fails closed. Fixtures first, no broker activation.
- **PR16B — full close for one instrument.** Route deterministic exit intent
  through the existing validated execution layer. Reconcile pending entries
  and TP/SL children; cap close quantity to fresh broker exposure; test
  concurrent fill/close/cancel, duplicate intents, timeout/unknown submission
  and restart. No retry of an unknown submission or accidental reversal.
- **PR16C — advanced lifecycle.** Only after the full-close path is accepted,
  add partial close, replace and trailing-stop flows incrementally. Each flow
  must prove child-order quantities, idempotency and recovery independently.
- **Acceptance.** Approved one-instrument Paper window with actual entry and
  exit evidence, restart/reconciliation evidence, and at least 24 hours of
  observation. Elapsed time alone is not a pass. Broader symbol rollout is a
  separately approved follow-up, not a prerequisite for proving the first exit.
- **Excludes.** New strategies, automatic futures roll, live activation.

## PR17 — Observability

- **Split.** PR17A ships minimum entry/reconciliation monitoring before the
  first Paper window; PR17B adds lifecycle metrics and runbooks after PR16.
  Waiting until all exit functionality exists would leave the initial Paper
  validation without a complete operational evidence path.
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
- **Boundary.** An empty checklist or startup gate is not Phase 9 completion.
  Actual live readiness additionally requires the long-term roadmap's security,
  operations and disaster-recovery reviews and a separate rollout decision.
- **Excludes.** Actually flipping live.

---

OUT OF SCOPE for the original Phase 2 reliability PRs: modify / cancel / replace
lifecycle (Phase 3 / PR16 above), new strategies, futures roll, multi-account,
and LLM adjudication. The new mechanics track explicitly adds the mandatory
AI entry gate outside execution-engine; execution remains deterministic.
