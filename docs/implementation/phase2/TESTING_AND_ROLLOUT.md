# Testing & Rollout — Phase 2

> Layered test strategy, paper-stability gate before "stable
> paper" status, and the live-readiness checklist that must pass
> **before** anyone changes `IBKR_ENVIRONMENT=live`. Live is not
> enabled in any Phase 2 PR.

## Test layers

| Layer | Runs in | What it proves |
| --- | --- | --- |
| **Unit** | `packages/shared` (node:test) | Pure engine invariants: determinism, freeze, blocker catalogues. |
| **Property / fuzz** | `packages/shared` | Tick rounding, protection side-checks, idempotency-key uniqueness under load. |
| **Integration** | Per app, ephemeral Postgres + Redis via docker-compose | Orchestrator ↔ `execution-engine` HTTP contract, `proposed_orders` writes, idempotency collision path. |
| **Contract** | Orchestrator ↔ `execution-engine` | Request / response schemas; duplicate-key behaviour; error taxonomy from [FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md). Snapshot files checked in. |
| **Paper E2E** | Full stack against IB Gateway paper (`4002`) | End-to-end submission, fill capture, reconciliation clean. |
| **Restart / recovery** | Docker-compose kill+restart of Orchestrator and `execution-engine` between phases of a submission | No duplicate submission; no orphan intent; broker state re-adopted. |
| **Fault injection** | Toxiproxy or in-process middleware | Read timeouts, `502/503`, DB write drop, IBKR socket disconnect, reconciliation staleness. |

Every PR must land at least: unit + relevant integration + (for
PR13 onward) contract test updates.

## Contract test surface

Frozen JSON fixtures under
`apps/execution-engine/src/__contract__/` (introduced in PR13):

- `POST /execution/tickets` — happy path.
- `POST /execution/tickets` — idempotency hit returns same
  `proposedOrderId` with `duplicate: true`.
- `POST /execution/tickets` — `423` when `TRADING_ENABLED=false`.
- `POST /execution/tickets` — `401` on missing / bad token.
- `GET  /execution/reconciliation/latest` (added in PR15).

Fixtures are consumed by Orchestrator tests as the *only* view
of the server. This makes the contract a review artefact, not a
happenstance.

## Paper E2E acceptance ("stable paper")

Required before we declare the pipeline production-grade on paper
(gates PR16 → PR17):

- [ ] ≥ 3 instruments across ≥ 2 exchanges.
- [ ] ≥ 24 h continuous run, no manual restarts.
- [ ] Zero duplicate submissions (grep on
      `client_order_id` uniqueness violations = 0).
- [ ] Zero orphan broker orders (Orchestrator has intent for
      every non-terminal broker order).
- [ ] Reconciliation stayed within `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`
      for ≥ 99 % of the window.
- [ ] Every alert kind from [FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md)
      exercised at least once by fault-injection during the
      window and shown to route to Telegram + `system_alerts`.
- [ ] No `SUBMIT_UNKNOWN` or `RECON_ORPHAN_BROKER_ORDER`
      unresolved at end of window.
- [ ] Broker P&L matches computed P&L from
      `broker_execution_fills` within rounding.

## Restart / recovery scenarios (must pass in PR15 and PR16)

1. Kill Orchestrator between ticket build and HTTP send → no
   broker submission occurs; next tick generates a new ticket
   with a new idempotency key.
2. Kill Orchestrator after `POST /tickets` 2xx but before local
   state update → restart rehydrates from `proposed_orders`,
   no duplicate submission.
3. Kill `execution-engine` between DB write and `ib.placeOrder`
   → boot flags row as unknown submission; alert fires; operator
   ack path exercised.
4. IBKR Gateway killed for 5 min → Orchestrator pauses loop;
   after reconnect + fresh reconciliation, loop resumes without
   duplicates.
5. Postgres connection dropped mid-submission → `5xx` at
   `execution-engine`; Orchestrator retries same idempotency key
   after backoff; no double row.

## Fault-injection matrix

| Injection point | Faults | Expected |
| --- | --- | --- |
| Orchestrator → `execution-engine` | connect timeout, read timeout after body, `502`, `503`, `401`, `423` | Class-appropriate behaviour per [FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md). |
| `execution-engine` → Postgres | INSERT fails, UNIQUE violation on `client_order_id` | `5xx` or `200 { duplicate: true }` respectively; no broker call. |
| `execution-engine` ↔ IBKR socket | disconnect, pacing violation, cancel 201/320 | Existing terminal-state handling; no state leak to Orchestrator. |
| Redis | key eviction of last tick | `PRICE_NOT_FRESH` blocker; no ticket built. |

## Rollout: local paper → stable paper

Transition criteria (all mandatory):

- All Phase 2 PRs merged.
- Paper E2E acceptance list above 100 %.
- Runbook exists for every alert kind (add to
  `docs/runbooks/` — file per alert — landed with PR17).
- Backup / restore rehearsed for Postgres data owned by
  `execution-engine`.
- Kill switch drill: both switches
  ([FAILURE_AND_RECOVERY.md](FAILURE_AND_RECOVERY.md#kill-switch))
  exercised end-to-end within the last 7 days of promotion.

## Live-readiness (does NOT enable live)

PR18 lands the checklist below in code as a boot-time gate. The
process refuses to run with `IBKR_ENVIRONMENT=live` unless every
item is satisfied. `TRADING_ENABLED` stays `false` in this PR.

- [ ] `EXECUTION_API_TOKEN` present, ≥ 32 chars, and different
      from any paper-env value ever committed.
- [ ] `ALLOWED_LIVE_ACCOUNTS` set and non-empty; disjoint from
      `ALLOWED_PAPER_ACCOUNTS`.
- [ ] `TRADING_ENABLED=false` at first boot on live (explicit).
- [ ] Reconciliation runs immediately on boot and is fresh.
- [ ] Startup performs a *dry read* of account summary and
      logs `LIVE_STARTUP_DRY_READ_OK` — no writes.
- [ ] Runbooks for every alert kind exist in `docs/runbooks/`.
- [ ] Last stable-paper window ≥ 7 days concluded within
      the last 14 days.
- [ ] Explicit operator sign-off recorded in
      `docs/implementation/phase2/LIVE_GO_NOGO.md` (created in PR18).

None of the above authorises trading. The final flip
(`TRADING_ENABLED=true` on live) is a separate operator action
outside Phase 2.

OUT OF SCOPE: chaos testing beyond the injection matrix,
performance benchmarks, cost dashboards.
