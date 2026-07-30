# Configuration — Phase 2

> Status (r2, PR15 shipped as commit `87eff1c`): the earlier
> `ORCH_*` table described a hypothetical orchestrator that
> never landed. PR11–PR15 shipped as an in-process
> `signal-engine` runtime (`apps/signal-engine/src/runtime/`)
> with its own env family. The original `ORCH_*` narrative is
> **superseded** by the tables below and by
> [PHASE_2_ROADMAP.md](PHASE_2_ROADMAP.md).
>
> Existing security / broker vars (`IBKR_ENVIRONMENT`,
> `TRADING_ENABLED`, `EXECUTION_API_TOKEN`,
> `ALLOWED_PAPER_ACCOUNTS`, `ALLOWED_LIVE_ACCOUNTS`,
> `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`) are owned by
> [ADR-001](../../adr/ADR-001-execution-security.md) and are
> **not** duplicated here.

## Signal-engine runtime (`apps/signal-engine/src/runtime/`)

Verified defaults from
`apps/signal-engine/src/runtime/execution/config.ts`,
`apps/signal-engine/src/runtime/trading-loop/config.ts`, and
`apps/signal-engine/src/config.ts`.

| Name | Default | Description |
| --- | --- | --- |
| `RUNTIME_ENABLED` | `true` | Master switch for `/runtime/*` endpoints. When `false`, `/runtime/health`, `/runtime/ready`, `POST /runtime/dry-run` are NOT registered (return HTTP 404). |
| `EXECUTION_RUNTIME_ENABLED` | `false` | Registers `POST /runtime/execute`, `GET /runtime/execute/ready`, AND the trading-loop routes (`GET /runtime/trading-loop/status`, `/ready`, `POST /run-once`). Trading-loop endpoints exist **only** when this flag is `true`; when `true` they always exist regardless of `TRADING_LOOP_ENABLED`. |
| `TRADING_LOOP_ENABLED` | `false` | Starts the internal trading-loop scheduler. Requires `EXECUTION_RUNTIME_ENABLED=true`. When `false`, `GET /runtime/trading-loop/status` still responds and reports `enabled: false`. |
| `TRADING_LOOP_INTERVAL_MS` | see `.env.example:229–235` | Loop tick interval used by the scheduler. |

## Reconciliation (`apps/execution-engine/src/reconciliation/`)

| Name | Default | Description |
| --- | --- | --- |
| `RECONCILIATION_*` | see `.env.example:115–128` | Reconciliation cadence, max age, and hold policy. `GET /execution/reconciliation/latest` returns `stale`, `maxAgeSeconds`, `run.snapshotComplete`, `run.status`. |

## Ticket submission

- Endpoint: `POST /execution/execute-ticket`
  (`apps/execution-engine/src/index.ts:1474`).
- Idempotency: JSON body carries `clientOrderId +
  clientOrderHash`. There is **no** `Idempotency-Key` header
  and no separate `execution_tickets` table; all fields live
  on `proposed_orders` (migration 000005:
  `partial_take_profits`, `trailing_stop_pct`,
  `trailing_stop_activation_r`).
- Server-recomputes `clientOrderHash` via
  `@ikbr/shared/client-order-hash`; mismatch rejects the
  submission.

## Retired / never-implemented vars

The following env vars appear only in earlier drafts and do
NOT exist in any `config.ts`:

- `ORCH_*` (10 vars) — replaced by `TRADING_LOOP_*`,
  `EXECUTION_RUNTIME_*`, `RECONCILIATION_*`, `RUNTIME_ENABLED`.
- `EXECUTION_TICKET_ENDPOINT_PATH` — path is fixed as
  `/execution/execute-ticket`.
- `EXECUTION_IDEMPOTENCY_HEADER` — idempotency is in body,
  not a header.
- `LIVE_STARTUP_DRY_READ` — never implemented.

OUT OF SCOPE: per-strategy overrides, dynamic config reload,
secrets management (already covered in ADR-001).
