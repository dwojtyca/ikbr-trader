# Testing & Rollout — Phase 2

> Status (r2, PR15 shipped as commit `87eff1c`): endpoint names,
> idempotency shape, and integration suites reflect the shipped
> code. The ticket endpoint is `POST /execution/execute-ticket`;
> idempotency is `clientOrderId + clientOrderHash` in the JSON
> body. Live is not enabled in any Phase 2 PR.

## Test layers

| Layer | Runs in | What it proves |
| --- | --- | --- |
| **Unit** | `packages/shared`, per-app (node:test) | Pure engine invariants: determinism, freeze, blocker catalogues. |
| **Integration** | Per app, ephemeral Postgres + Redis via docker-compose | signal-engine runtime ↔ `execution-engine` HTTP contract, `proposed_orders` writes, idempotency collision path, reconciliation. |
| **Paper E2E** | Full stack against IB Gateway paper (`4002`) | End-to-end submission, fill capture, reconciliation clean. |
| **Restart / recovery** | Docker-compose kill+restart between phases of a submission | No duplicate submission; no orphan intent; broker state re-adopted via reconciliation. |
| **Fault injection** | Toxiproxy or in-process middleware | Read timeouts, `502/503`, DB write drop, IBKR socket disconnect, reconciliation staleness. |
| **Tooling** | `tools/paper-verify-stack` (PR15.1) | Read-only GET-only allowlist-bound probe covering all 14 endpoints + severity taxonomy + kill-switch cache coupling. |

Every PR must land at least: unit + relevant integration + (from
PR15 onward) touch the tooling scenarios when new endpoints are
introduced.

## Shipped PostgreSQL integration suites

Under `apps/execution-engine/src/`:

- `three-phase.pg-integration.test.ts`
- `three-phase-r5.pg-integration.test.ts`
- `three-phase-r6.pg-integration.test.ts`
- `three-phase-r7.pg-integration.test.ts`
- `three-phase-r8.pg-integration.test.ts`
- `submission-gate.pg-integration.test.ts`
- `matcher-per-row.pg-integration.test.ts`
- `migrations.pg-integration.test.ts`
- `repository.pg-integration.test.ts`

Run via `pnpm test:integration` with a live Postgres
(`TEST_POSTGRES_URL`); CI provides Postgres 16 as a service.

## Paper E2E acceptance ("stable paper")

Required before we declare the pipeline production-grade on
paper (gates PR16 → PR17):

- [ ] ≥ 3 instruments across ≥ 2 exchanges.
- [ ] ≥ 24 h continuous run, no manual restarts.
- [ ] Zero duplicate submissions (`client_order_id` uniqueness
      violations = 0).
- [ ] Zero orphan broker orders (runtime has intent for every
      non-terminal broker order).
- [ ] Reconciliation stayed within
      `EXECUTION_READY_RECONCILIATION_MAX_AGE_S` for ≥ 99 % of
      the window.
- [ ] Every alert kind from
      [FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md) fired
      at least once during fault-injection and routed to
      Telegram + `system_alerts`.
- [ ] No `SUBMIT_UNKNOWN` or `RECON_ORPHAN_BROKER_ORDER`
      unresolved at end of window.
- [ ] Broker P&L matches computed P&L from
      `broker_execution_fills` within rounding.

## Restart / recovery scenarios

1. Kill signal-engine runtime between ticket build and HTTP send
   → no broker submission; next tick generates a new ticket with
   a new `clientOrderId`.
2. Kill runtime after `POST /execute-ticket` 2xx but before local
   state update → restart rehydrates from `proposed_orders`; no
   duplicate submission.
3. Kill `execution-engine` between DB write and `ib.placeOrder`
   → boot flags row as unknown submission; alert fires; operator
   ack path exercised.
4. IBKR Gateway killed for 5 min → runtime pauses loop; after
   reconnect + fresh reconciliation, loop resumes without
   duplicates.
5. Postgres connection dropped mid-submission → `5xx` at
   `execution-engine`; runtime retries same `clientOrderId` after
   backoff; no double row.

## Fault-injection matrix

| Injection point | Faults | Expected |
| --- | --- | --- |
| runtime → `execution-engine` | connect timeout, read timeout after body, `502`, `503`, `401`, `423` | Class-appropriate behaviour per [FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md). |
| `execution-engine` → Postgres | INSERT fails, UNIQUE violation on `client_order_id` | `5xx` or `200 { duplicate: true }` respectively; no broker call. |
| `execution-engine` ↔ IBKR socket | disconnect, pacing violation, cancel 201/320 | Existing terminal-state handling; no state leak to runtime. |
| Redis | key eviction of last tick | `PRICE_NOT_FRESH` blocker; no ticket built. |

## Rollout: local paper → stable paper

Transition criteria (all mandatory):

- All Phase 2 PRs merged.
- Paper E2E acceptance list above 100 %.
- Runbook exists for every alert kind (add to
  `docs/runbooks/` — file per alert — landed with PR17).
  `docs/runbooks/PAPER_STACK_VERIFICATION.md` landed with PR15.1.
- Backup / restore rehearsed for Postgres data owned by
  `execution-engine`.
- Kill switch drill: every switch listed in
  [FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md#kill-switches)
  exercised end-to-end within the last 7 days of promotion.

## Live-readiness (does NOT enable live)

PR18 lands a boot-time gate. The process refuses to run with
`IBKR_ENVIRONMENT=live` unless every item below is satisfied.
`TRADING_ENABLED` stays `false` in that PR.

- [ ] `EXECUTION_API_TOKEN` present, ≥ 32 chars, distinct from
      every paper-env value ever committed.
- [ ] `ALLOWED_LIVE_ACCOUNTS` set and non-empty; disjoint from
      `ALLOWED_PAPER_ACCOUNTS`.
- [ ] `TRADING_ENABLED=false` at first boot on live.
- [ ] Reconciliation runs immediately on boot and is fresh.
- [ ] Startup performs a *dry read* of account summary and logs
      confirmation — no writes.
- [ ] Runbooks for every alert kind exist in `docs/runbooks/`.
- [ ] Last stable-paper window ≥ 7 days concluded within the
      last 14 days.
- [ ] Explicit operator sign-off recorded in
      `docs/implementation/phase2/LIVE_GO_NOGO.md` (created in
      PR18).

None of the above authorises trading. The final flip
(`TRADING_ENABLED=true` on live) is a separate operator action
outside Phase 2.

OUT OF SCOPE: chaos testing beyond the injection matrix,
performance benchmarks, cost dashboards.
