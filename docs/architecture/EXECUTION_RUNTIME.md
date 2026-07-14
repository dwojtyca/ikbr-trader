# Execution Runtime (PR13)

> Paper-only, single-shot submit. Composes the PR12 dry-run flow
> with a duplicate-safe HTTP call to `execution-engine`. Kill-switch
> `EXECUTION_RUNTIME_ENABLED=false` by default. No scheduler, no
> reconciliation loop, no live path.

## Placement (OD-1 for the write-runtime scope)

Hosted **inside `apps/signal-engine`** under
`src/runtime/execution/`, next to the PR12 dry-run runtime. Reuses
the existing Fastify server, Postgres pool, Redis client, and
logger. The Bearer token for `POST /runtime/execute` is the same
`EXECUTION_API_TOKEN` every internal service already carries
(AGENTS.md: "Phase 1 token model — jeden `EXECUTION_API_TOKEN`").

Rejected alternative: a new `apps/orchestrator` process. Would
duplicate all wiring and require its own docker-compose entry for
a single write endpoint that already shares 100% of its runtime
dependencies with the PR12 module.

## Ownership (OD-4 resolved: reuse `POST /execution/execute-ticket`)

- `execution-runtime`: builds the ticket inside its own dry-run
  call and hands it off to `execution-engine` in one HTTP request.
  Never inserts `proposed_orders` directly. Never places broker
  orders. Never bypasses the shared pipeline.
- `execution-engine`: sole owner of `proposed_orders` writes and
  the sole component that talks to IBKR. PR13 extends its existing
  `/execution/execute-ticket` endpoint with a `clientOrderId +
clientOrderHash` idempotency contract; no new endpoint.

## Request flow

```
POST /runtime/execute
  Authorization: Bearer <EXECUTION_API_TOKEN>
  { instrumentId, policy, idempotencyKey }
  → Bearer auth check (401 on fail)
  → MarketDataRuntime.dryRun(instrumentId, policy)
    → TradingPipelineResult
  → outcome !== SUCCESS → NOT_SUBMITTED (NO_TRADE | PIPELINE_FAILURE)
  → PaperGuard.check() (GET /execution/ready on execution-engine)
    → environment !== "paper" OR ready = false → NOT_SUBMITTED / PAPER_GUARD_FAILED
  → toLegacySignalTicket(ticket)
    → STP_LMT or STP+bracket → NOT_SUBMITTED / UNSUPPORTED_TICKET_SHAPE
  → clientOrderHash = sha256(canonicalise(ticket))
  → POST /execution/execute-ticket
      { ticket: <legacy shape>, persist: true, strategy,
        clientOrderId: <idempotencyKey>, clientOrderHash }
    → 200 { execution }               → SUBMITTED
    → 200 { duplicate: true, order }  → DUPLICATE
    → 409 idempotency_conflict        → CONFLICT
    → 4xx (400/423/etc.)              → NOT_SUBMITTED
    → 5xx / timeout / network error   → UNKNOWN (no retry)
```

The runtime NEVER accepts an arbitrary ticket from the client. The
ticket is generated inside the same call from the shared
`TradingPipeline` and cannot be swapped between validation and
submission.

## Idempotency

`proposed_orders` gains two columns (PR13 migration executed by
`SignalRepository.init()`):

| Column              | Type   | Notes                                                                            |
| ------------------- | ------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `client_order_id`   | `TEXT` | Client-supplied opaque key. `NULL` allowed for pre-PR13 rows and legacy callers. |
| `client_order_hash` | `TEXT` | Server-visible fingerprint of the order-critical fields. Versioned (`v1          | …`) — a bump invalidates all prior hashes and correctly surfaces as CONFLICT for in-flight retries. |

Plus a partial unique index:

```
CREATE UNIQUE INDEX proposed_orders_client_order_id_uidx
  ON proposed_orders (client_order_id)
  WHERE client_order_id IS NOT NULL;
```

### State-aware decision (`decideIdempotency` + `orchestrateExecuteTicket`)

Duplicate handling considers **both** the hash AND the row's
lifecycle status, with an atomic submission claim shared by both
the fresh-INSERT path and the resume path to survive concurrent
retries. Matching the hash is NOT proof the broker ever received
the order — an INSERT that succeeded and then crashed before the
atomic submission claim leaves a `PROPOSED` row without the
fencing marker that is safe to **resume** on the next retry.

| Existing row | Hash                         | Status / evidence                                                                      | Orchestrator outcome                                                                                                                                                     | HTTP body `outcome`               |
| ------------ | ---------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| none         | —                            | —                                                                                      | `submitted` (INSERT + `tryStartSubmission` + execute)                                                                                                                    | `SUBMITTED`                       |
| yes          | differs                      | any                                                                                    | `conflict`                                                                                                                                                               | 409 `CONFLICT`                    |
| yes          | `NULL` (pre-PR13 legacy row) | any                                                                                    | `conflict`                                                                                                                                                               | 409                               |
| yes          | matches                      | `SUBMITTED` / `FILLED`                                                                 | `duplicate_submitted`                                                                                                                                                    | 200 `DUPLICATE_SUBMITTED`         |
| yes          | matches                      | `REJECTED` / `CANCELLED` / `SUPERSEDED` / `EXPIRED`                                    | `duplicate_terminal`                                                                                                                                                     | 200 `DUPLICATE_TERMINAL`          |
| yes          | matches                      | `PROPOSED` + `executionAttemptedAt` or `brokerOrderId` set (ambiguous)                 | `duplicate_pending_ambiguous`                                                                                                                                            | 200 `DUPLICATE_PENDING_AMBIGUOUS` |
| yes          | matches                      | `PROPOSED`, no `executionAttemptedAt`, no `brokerOrderId`, **atomic claim acquired**   | `resumed` (re-drive `executePersistedOrder`)                                                                                                                             | 200 `RESUMED`                     |
| yes          | matches                      | same as above but **claim held by another request** (marker set atomically with claim) | (re-classified from freshest row: `duplicate_submitted` / `duplicate_terminal` / `duplicate_pending_ambiguous`) OR `pending_claimed` when the marker was not yet visible | 200 as above                      |

### Unified atomic submission claim with a fencing marker

**INSERT success alone does NOT grant the right to submit.** Both
the fresh-INSERT path and the resume path share the same
repository-level atomic UPDATE — `tryStartSubmission` — which
acquires the claim AND sets a fencing marker in the same
statement:

```
UPDATE proposed_orders
SET processing_owner = $owner,
    processing_claimed_at = NOW(),
    execution_attempted_at = NOW()   -- fencing marker
WHERE id = $id
  AND status = 'PROPOSED'
  AND execution_attempted_at IS NULL
  AND broker_order_id IS NULL
RETURNING id;
```

Only the request that receives a `RETURNING` row is allowed to
call `executePersistedOrder`. Losers of the claim race do a
fresh SELECT and classify from the freshest visible state (see
below) — they NEVER contact the broker.

The UNIQUE constraint on `client_order_id` alone does NOT prevent
a double submission. The race the marker closes:

1. Request A INSERTs (row `PROPOSED`, no marker) and pauses.
2. Request B arrives with the same `clientOrderId`. Either
   B's up-front `getIdempotencyRecord` sees A's row and reaches
   the resume branch, or B's own INSERT fails with UNIQUE and B
   re-consults the record.
3. Both paths call `tryStartSubmission`. B wins the atomic UPDATE
   (marker set for B).
4. A resumes. A also calls `tryStartSubmission` (fresh-INSERT
   path now goes through the same gate). A's UPDATE affects zero
   rows (marker already set) → A re-reads → classifies as
   `duplicate_pending_ambiguous` / `duplicate_submitted` /
   `duplicate_terminal`. A never contacts the broker.

**The `execution_attempted_at` SET in the same UPDATE is the safety
guarantee — NOT a TTL lease.** Once the first winner's UPDATE
lands, the row's `execution_attempted_at` is non-null and no
subsequent `tryStartSubmission` can satisfy the `IS NULL`
predicate, for the entire lifetime of the row. Even if the winner
pauses arbitrarily long (network hang, slow broker, GC pause)
before completing `executePersistedOrder`, a second request
CANNOT take over and submit a second order to the broker. This is
the intentional at-most-once trade-off: we prefer "reconciliation
required" over "broker gets two orders".

`processing_owner` / `processing_claimed_at` remain populated for
observability — every terminal transition (`markSubmitted`,
`markFilled`, `markCancelled`, `markRejected`) clears them.

#### Post-claim-failure classification

After a losing `tryStartSubmission`, the orchestrator does a
fresh SELECT and classifies from the observed state — never
blind-returns `pending_claimed` when the row already transitioned:

| Freshest state                                                 | Outcome                       |
| -------------------------------------------------------------- | ----------------------------- |
| `SUBMITTED` / `FILLED`                                         | `duplicate_submitted`         |
| `REJECTED` / `CANCELLED` / `SUPERSEDED` / `EXPIRED`            | `duplicate_terminal`          |
| `PROPOSED` + `executionAttemptedAt` (or `brokerOrderId`)       | `duplicate_pending_ambiguous` |
| `PROPOSED`, no marker, no broker id (rare read/write ordering) | `pending_claimed`             |

#### Crash windows

1. **After INSERT, before marker** → row is `PROPOSED` with no
   `executionAttemptedAt`. No broker call could have happened yet.
   **Safe to retry** — the next retry acquires the marker via
   `tryStartSubmission` and submits exactly once.
2. **After marker, before broker call** → row is `PROPOSED` with
   `executionAttemptedAt` set. **Ambiguous** — the broker may or
   may not have received the order (spoiler: it did not, because
   `executePersistedOrder` sets the marker via
   `markExecutionAttempt` before the broker call, and our atomic
   marker is set BEFORE `executePersistedOrder` runs; but from
   the orchestrator's perspective without reconciliation this
   cannot be distinguished from a crash further in the flow).
   Subsequent retries return `duplicate_pending_ambiguous`
   without contacting the broker. **Reconciliation is the only
   recovery path** for such rows (planned separately for a later
   Phase 2 PR).
3. **After broker call** → row is `SUBMITTED` / `FILLED` /
   `REJECTED` / `CANCELLED`. Subsequent retries return
   `duplicate_submitted` or `duplicate_terminal` based on the
   persisted broker state.

### Duplicate vs. Pending — runtime semantics

The runtime maps the six execution-engine outcomes to four
public runtime outcomes so callers can act correctly without
guessing at the wire format:

| Submitter kind                | Runtime `outcome`                        | Meaning for the caller                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitted`                   | `SUBMITTED`                              | Fresh submission — broker got the order.                                                                                                                                                       |
| `resumed`                     | `SUBMITTED` (with `resumed: true`)       | Orphan row was re-driven — broker got the order.                                                                                                                                               |
| `duplicate_submitted`         | `DUPLICATE`                              | A prior attempt with the same key already succeeded (`previousExecution.order.status` = SUBMITTED / FILLED).                                                                                   |
| `duplicate_terminal`          | `DUPLICATE`                              | A prior attempt terminated non-successfully (`previousExecution.order.status` = REJECTED / CANCELLED / SUPERSEDED / EXPIRED). **NOT a success** — a fresh retry needs a fresh idempotency key. |
| `duplicate_pending_ambiguous` | `PENDING` (reason `ambiguous_attempt`)   | The broker MAY have received the order; reconciliation resolves. Do NOT resubmit.                                                                                                              |
| `pending_claimed`             | `PENDING` (reason `claim_held_by_other`) | Another request is running the submission right now. Retry AFTER it finishes.                                                                                                                  |
| `conflict`                    | `CONFLICT`                               | Same key, different intent.                                                                                                                                                                    |

`clientOrderHash` covers: instrument identity, order side / qty /
type / TIF / limit / stop / rth flag / transmit flag, and every
protection field. It is INSENSITIVE to metadata (`signalId`,
`decisionId`, `ticketId`, timestamps, engine versions) so the
same order derived from a re-run pipeline does not look different.
The canonical form is versioned with a `v<N>|` prefix (currently
`v1`); any change to the field list or serialisation must bump
the version.

## `proposed_order` lifecycle

Unchanged from Phase 1: the endpoint inserts the row `PROPOSED`,
then transitions it to `SUBMITTED` / `FILLED` / `CANCELLED` via
the existing `executePersistedOrder` path. The runtime never
touches the row after handoff.

Resume path uses the SAME `executePersistedOrder` — no separate
"resumer" service, no second INSERT, no drift from the Phase 1
status transitions. `executePersistedOrder` internally re-runs
`validateExecutableTicket`, `findActiveSubmittedByInstrument`,
`assertKillSwitchOk`, and `ensureBrokerSession` on the resumed
row.

## Supported order types

The write endpoint's `policy.orderType` accepts:

- `LMT` — passes through as `LMT`; `entry` = `limitPrice`.
  Bracket protection (`stopLoss` → `stop`, `takeProfit` →
  `takeProfit`) is fully supported.
- `STP` — passes through as `STP`; `stop` = `stopPrice`.
  **Bracket protection is NOT supported for `STP` parents.**

`STP_LMT` is **not supported on the write edge**. The legacy
`SignalTicket` wire type consumed by `execution-engine` only
accepts `LMT | STP | MKT`, and the IBKR adapter has no `STP_LMT`
branch. The runtime rejects `orderType: "STP_LMT"` with HTTP 400
`invalid_body` rather than silently coerce to `STP` (which would
drop the limit price and place a different order type at the
broker). `STP_LMT` remains available in the PR12 dry-run
endpoint because the shared `ExecutionTicketBuilder` handles it —
end-to-end support requires an execution-engine schema + adapter
change and is out of scope for PR13.

### `STP` + bracket protection is REJECTED

The legacy `SignalTicket` has a **single** `stop` field. It can
carry either the parent STP trigger OR the bracket protective
stop-loss — never both. Prior to the PR13 blocker fix, the
mapper silently let the bracket `stopLoss` overwrite the parent
`stopPrice`, placing a stop order at the wrong trigger price. The
current mapper detects any STP ticket carrying
`protection.bracketEnabled`, `protection.stopLoss`,
`protection.takeProfit`, or `protection.trailingStop` and throws
`UnsupportedOrderCombinationError`. The runtime translates the
throw into `NOT_SUBMITTED / UNSUPPORTED_TICKET_SHAPE` — the
broker is never contacted and the row is never inserted.

Supporting bracketed STP parents requires either (a) extending
the legacy `SignalTicket` wire type with a separate parent-trigger
field, or (b) routing bracket protection through a distinct
child-order shape; both are out of scope for PR13.

## Paper-only guard

Two independent layers, either of which alone refuses live:

1. Config schema: `EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT` is
   `z.literal("paper")`. Any other value fails startup.
2. Per-request probe: every submission first GETs
   `execution-engine`'s `/ready` and requires
   `environment === "paper"`, `ready === true`, and
   `checks.accountMatchesEnvironment === true`. Any negative
   signal → `NOT_SUBMITTED / PAPER_GUARD_FAILED`. No submission.

Enabling live requires: a code change to the schema, a code
change to the `PaperGuard` constructor guard, and the
`docs/implementation/phase2/PHASE_2_ROADMAP.md` live-readiness
checklist (PR18).

## Timeout / ambiguous submission

The submitter uses `AbortController` bounded by
`EXECUTION_RUNTIME_REQUEST_TIMEOUT_MS` (default 5 000 ms). On:

- timeout / abort → `UNKNOWN { reason: "…timed out after Nms" }`
- network error → `UNKNOWN { reason: "…failed: <message>" }`
- HTTP 5xx → `UNKNOWN { reason: "…returned 5xx …" }`
- HTTP 200 with unrecognised body → `UNKNOWN` (defensive; a
  schema change on execution-engine cannot silently fall through
  to SUBMITTED)

`UNKNOWN` is a terminal outcome for PR13. There is NO automatic
retry — the runtime NEVER re-submits with the same
`idempotencyKey` after an ambiguous response, and NEVER
regenerates the key. A future PR will introduce a reconciliation
loop that resolves broker state; until then a human operator
resolves via `GET /execution/orders`.

## Auth

- Incoming (`POST /runtime/execute`): Bearer token compared with
  `EXECUTION_API_TOKEN` in constant time (`crypto.timingSafeEqual`
  with padding). Empty configured token → deny all. `GET
/runtime/execute/ready` is NOT authenticated (same policy as
  the PR12 `/runtime/ready`).
- Outgoing (`POST /execution/execute-ticket`): sends
  `Authorization: Bearer <EXECUTION_API_TOKEN>` — the shared
  Phase-1 token consumed by every other internal caller.

## Readiness

`GET /runtime/execute/ready` (only registered when
`EXECUTION_RUNTIME_ENABLED=true`) probes:

- Redis `PING`
- Postgres `SELECT 1`
- execution-engine `/ready` reports paper + ready + account match

The PR12 dry-run readiness (`GET /runtime/ready`) is untouched
when the write runtime is disabled.

## What PR13 does NOT do

- No scheduler / cron / trading loop (PR14).
- No reconciliation loop (PR15).
- No automatic retry on 5xx / timeout / connection error.
- No modify / cancel / partial-close (Phase 3).
- No LLM in the write path.
- No live trading (env-literal + paper-guard both block).
- No direct IBKR access from `signal-engine`.

## Configuration

| Env                                      | Default                     | Purpose                                                          |
| ---------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `EXECUTION_RUNTIME_ENABLED`              | `"false"`                   | Kill-switch for `POST /runtime/execute` and its readiness route. |
| `EXECUTION_RUNTIME_ENGINE_URL`           | `SIGNAL_EXECUTION_BASE_URL` | Execution-engine base URL.                                       |
| `EXECUTION_RUNTIME_REQUEST_TIMEOUT_MS`   | `5000`                      | Per-request total timeout.                                       |
| `EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT` | `"paper"`                   | `z.literal("paper")`. Non-paper values fail startup.             |
| `EXECUTION_API_TOKEN`                    | (existing)                  | Bearer for incoming AND outgoing calls.                          |
