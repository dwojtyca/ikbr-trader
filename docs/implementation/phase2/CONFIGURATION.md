# Configuration — Phase 2

> New env vars introduced across Phase 2 (PR11–PR18). Existing
> security / broker vars (`IBKR_ENVIRONMENT`, `TRADING_ENABLED`,
> `EXECUTION_API_TOKEN`, `ALLOWED_PAPER_ACCOUNTS`,
> `ALLOWED_LIVE_ACCOUNTS`, `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`)
> are owned by [ADR-001](../../adr/ADR-001-execution-security.md)
> and are **not** duplicated here.

| Name | Owner | Default | Description |
| --- | --- | --- | --- |
| `ORCH_LOOP_ENABLED` | Orchestrator | `true` | Kill switch for the trading loop. `false` pauses new ticket submissions. Requires restart. |
| `ORCH_MAX_RECON_AGE_S` | Orchestrator | `900` | Max age of the last reconciliation report before the loop pauses. Must be ≤ `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`. |
| `ORCH_TICKET_HTTP_TIMEOUT_MS` | Orchestrator | `5000` | Total timeout for `POST` to the execution-engine ticket endpoint (OD-4). Ambiguous timeout triggers GET-before-retry. |
| `ORCH_TICKET_CONNECT_TIMEOUT_MS` | Orchestrator | `2000` | Connect-only timeout for the same call. |
| `ORCH_RETRY_MAX_ATTEMPTS` | Orchestrator | `3` | Max attempts for transient failure class (see FAILURE_AND_RECOVERY). |
| `ORCH_RETRY_BASE_MS` | Orchestrator | `250` | Base delay for jittered exponential backoff. Cap: 4000 ms. |
| `ORCH_INSTRUMENT_IDS` | Orchestrator | (unset → refuse boot) | CSV of instrument IDs the loop runs for. No default, to prevent accidental fan-out. |
| `ORCH_SNAPSHOT_MAX_PRICE_AGE_MS` | Orchestrator | pending PR12 | Freshness bound for the Redis last-tick used in `MarketContextSnapshot`. Above it → `PRICE_NOT_FRESH`. |
| `ORCH_DRY_RUN_ONLY` | Orchestrator | `true` in PR12, `false` from PR13 | If `true`, the real `TicketSubmitter` is replaced by a noop. Guards PR12 against accidental submission. |
| `EXECUTION_TICKET_ENDPOINT_PATH` | execution-engine | pending OD-4 | Path exposed by `execution-engine` for ticket submission. |
| `EXECUTION_IDEMPOTENCY_HEADER` | execution-engine | `Idempotency-Key` | Header name carrying `ExecutionTicket.correlationId`. |
| `LIVE_STARTUP_DRY_READ` | Orchestrator | `true` | With `IBKR_ENVIRONMENT=live`, boot must log `LIVE_STARTUP_DRY_READ_OK` before any submission. Cannot be disabled — env exists only for test overrides. |

Owner semantics:

- **Orchestrator** — the new runtime process introduced in
  PR11+. Its home process is OD-1; the env prefix `ORCH_` is
  stable regardless of where it lands.
- **execution-engine** — additive env only; no existing var is
  repurposed or renamed.

OPEN DECISION (OD-4): `EXECUTION_TICKET_ENDPOINT_PATH` stays
unresolved until PR13 decides between the new endpoint and
reusing `POST /execution/execute-ticket`.

OUT OF SCOPE: per-strategy overrides, dynamic config reload,
secrets management (already covered in ADR-001).
