# Trading Loop

> Paper-only scheduler that periodically drives the PR13
> `ExecutionRuntime` per instrument. Adds NO new broker path.

## Scope (PR14)

- Opens new positions only. **Does NOT close positions**, does
  NOT modify existing broker orders, does NOT reconcile.
- Paper only. Live is impossible via config.
- Loop is OFF by default (`TRADING_LOOP_ENABLED=false`) and also
  requires `EXECUTION_RUNTIME_ENABLED=true`.

## PR15.2 — Authoritative instrument binding

The loop refuses to run for any registry instrument that lacks
a binding in the shared `INSTRUMENT_BINDINGS_JSON` payload.

- The signal-engine builds one process-wide
  `InstrumentBindingAuthority` at startup and injects it into
  `TradingLoopService`.
- Every cycle: `getBoundInstrument(instrument.id)` is the first
  gate. Absent → `SKIPPED / INSTRUMENT_BINDING_UNAVAILABLE`,
  zero market-data read, zero dryRun, zero submission.
- Present → the loop threads the bound view through:
  - `MarketDataRuntime` reads Redis market state using the
    exact bound `conId` (via `BindingAwareContractResolver`).
  - `ReconciliationReader` is asked about the bound `conId`.
  - `ExecutionRuntime.executePrepared` receives the bound view;
    the resulting legacy `SignalTicket` carries
    `{ instrument = bound.brokerSymbol, conid = bound.conId,
    instrumentId = bound.instrumentId }`.
- Execution-engine builds its OWN authority from the SAME
  configuration payload and re-verifies the identity server-side
  before any DB or broker write.
- No hot reload of bindings. Rolling a binding = env change +
  service restart. Never automated (no futures roll adapter yet).

## Placement

`apps/signal-engine/src/runtime/trading-loop/` — same process as
signal-engine, isolated lifecycle, three HTTP routes:
`GET /runtime/trading-loop/status`,
`POST /runtime/trading-loop/run-once`,
`GET /runtime/trading-loop/ready`.

## Scheduling model

`setInterval` every `TRADING_LOOP_INTERVAL_MS` (min 5 s, default
30 s). Tick returns quickly — schedules per-instrument runs but
does not await them. Missed ticks NEVER queued.

## Non-overlap

Per-instrument `Map<instrumentId, Promise<void>>` (skip
`RUN_IN_PROGRESS`) + global cap
`TRADING_LOOP_MAX_CONCURRENT_INSTRUMENTS` (skip
`CONCURRENCY_CAP`). Process-local; execution-engine holds the
authoritative cross-process guard (below).

## Exposure enforcement — two layers

### 1. Signal-engine pre-check (fast, best-effort)

Before running the pipeline the loop calls
`TradingExposureReader.readExposure` — Zod-validated shapes,
freshness check on `account/summary.retrievedAt`, four flags
that all block a new intent: `hasOpenPosition`,
`hasActiveOrder`, `hasAmbiguousSubmission`,
`hasPendingProposal`.

### 2. Execution-engine atomic guard (authoritative)

Every `insert_proposed_from_ticket` call runs inside a
transaction guarded by
`pg_advisory_xact_lock(hashtext(instrument))`. Under the same
lock:

1. **Active-intent check** — any non-terminal `PROPOSED` /
   `SUBMITTED` for the instrument under a DIFFERENT
   `client_order_id` → `ACTIVE_INTENT_EXISTS`.
2. **PositionGuardContext (round-5/6)** — caller passes an
   EXPLICIT discriminated context. `PositionGuardContext` is
   **REQUIRED** — the repository signature does not accept
   `undefined`. A compile-time regression test enforces this at
   the type boundary.
   - `{ kind: "unavailable", reason: "no_active_account" }` →
     `POSITION_STATE_UNAVAILABLE` (no active broker account →
     boot-time / bootstrap-pending; fail-closed with no DB
     read).
   - `{ kind: "available", accountId, sessionId, maxSnapshotAgeMs }` →
     probe `broker_snapshot_syncs` — refuses when the row is
     missing / has a different `session_id` (round-6 fix: after
     a restart the previous session's snapshot is not trusted
     even when `observedAt` is still fresh) / observed_at is
     stale (also treats an observation dated non-trivially in
     the future as stale — defensive against clock skew) /
     `complete = false`.
3. **Open-position check — hardcoded no-pyramiding (round-7)**
   — for PR14 the authoritative guard is invoked with
   `allowCrossContractExposure = false` at every server-side
   call site. The value is **NOT** carried on the wire; the
   public `POST /execution/execute-ticket` schema does not
   expose the field. Any strategy that legitimately needs
   cross-contract exposure in a future PR must have that
   resolved from a trusted server-side instrument-registry
   policy — never from the request body.

   Guard semantics (with `allowCrossContractExposure=false`):
   - ANY non-zero position sharing this instrument's broker
     symbol blocks a new intent, regardless of `conid`.
   - Prevents pyramiding across futures rollover / share class
     migrations.

   `Instrument.executionPolicy.allowCrossContractExposure` on
   the shared type is retained for the future
   registry-resolved path but is IGNORED by PR14 (a
   compile-time regression test proves the field is not present
   on the parsed request body type).

   Two partial unique indexes still enforce the split identity
   at the persistence layer for the retained conId-aware code
   path:

   ```sql
   CREATE UNIQUE INDEX broker_position_snapshots_conid_uidx
     ON broker_position_snapshots (account_id, conid)
     WHERE conid IS NOT NULL;
   CREATE UNIQUE INDEX broker_position_snapshots_symbol_uidx
     ON broker_position_snapshots (account_id, instrument)
     WHERE conid IS NULL;
   ```

### 3. Resume path re-runs the exposure guard (round-6 blocker)

**Every broker submission** — fresh INSERT AND resume — MUST
acquire the atomic marker via
`tryStartSubmissionWithExposureGuard`, which under a single
transaction + advisory lock:

1. Takes `pg_advisory_xact_lock(hashtext(instrument))`.
2. Runs the SAME exposure guard body used by
   `insertProposedFromTicket`
   (`#runExposureGuard(client, {instrument, conid, allowCrossContractExposure, guard})`).
3. On a blocking outcome — ROLLBACK, returns the outcome
   unchanged. NO marker set. NO broker call.
4. Otherwise atomically flips `execution_attempted_at` via
   `UPDATE ... WHERE ... RETURNING`. Exactly one concurrent
   caller receives `claimed`; the other receives `not_claimed`.
5. COMMIT.

This closes the hole where a retry with the same
`clientOrderId` on a clean `PROPOSED` row would previously
bypass the account / session / snapshot / open-position check.
After the round-6 fix a resume submission is impossible when:

- no active broker account (`no_active_account`),
- snapshot missing / stale / incomplete,
- snapshot written by a different `session_id` (`wrong_session`),
- non-zero position on the (logical) instrument
  (`open_position_exists`),
- a concurrent submitter holds the marker (`not_claimed` →
  `duplicate_pending_ambiguous`).

### 4. Broker-driven snapshot refresher (round-7 blocker)

Snapshot freshness is no longer tied to a fire-and-forget write
on the `/execution/account/summary` display endpoint. The
authoritative refresher is a per-account serialised
coordinator with a **two-phase** contract:

1. `beginPositionSnapshotRefresh(accountId, sessionId, observedAt)`
   — set `broker_snapshot_syncs.complete = false`. Every
   write-path guard consulted between this call and the matching
   complete-call fail-closes with `POSITION_STATE_UNAVAILABLE
(incomplete)`.
2. Fetch broker state from TWS (`getAccountSnapshot` — no
   transaction held during the network call).
3. `completePositionSnapshotRefresh(accountId, sessionId,
observedAt, positions)` — atomically replace the position
   rows AND flip `complete = true` in a single transaction.

Trigger points:

- **Startup** — first `ensureBrokerSession` success kicks off a
  refresh.
- **Fill event** — every FILLED order in `executePersistedOrder`
  triggers a refresh so subsequent write-path guards see the
  new position.
- **`POST /execution/refresh-position-snapshot`** — explicit
  operator trigger. Returns 200 when healthy, 503 with the
  refresh state otherwise.
- **`GET /execution/account/summary`** — now AWAITS the
  refresher (no more fire-and-forget). Snapshot persistence
  failure surfaces via readiness.

The refresher publishes per-account health
(`healthy | in_flight | failed | never`) that flows into
`GET /ready`. A stale / in-flight / failed refresh flips
`/ready` to 503 with a distinct reason
(`position_snapshot_never_synced`,
`position_snapshot_refresh_in_flight`,
`position_snapshot_refresh_failed`) — operators can
distinguish "broker socket up but write path fail-closed"
from "everything OK".

### 6. Fill-to-position invalidation contract (round-8 blocker)

Every broker-side event that MAY change exposure MUST invalidate
the position snapshot BEFORE the local order-lifecycle
transition that would otherwise unblock a new intent:

- direct `FILLED` from `placeSignalOrder`
- async `orderStatus=FILLED` via `applyBrokerStatusUpdate`
- partial-fill / executionDetails callback
- `runReconciliation` detecting a mismatch

The invariant is:

```
await repo.invalidatePositionSnapshot({ accountId, ... })   // complete=false
markSnapshotInvalidated(accountId)                          // /ready 503
await repo.markFilled(...)                                  // local FILLED
void refreshBrokerPositionSnapshot(accountId)               // fetch broker
                                                            //   state; only
                                                            //   NOW may
                                                            //   complete=true
```

If the follow-up refresh fails, `broker_snapshot_syncs.complete`
stays `false`; the write path stays fail-closed with
`POSITION_STATE_UNAVAILABLE (incomplete)`; `/ready` stays 503
until the next successful refresh.

### 7. Snapshot lock protocol + generation fence (round-8 blocker)

Two advisory-lock keys:

- `hashtext('snap:' || account_id)` — account-level snapshot
  lock. Held by both refresh and submission guard.
- `hashtext(instrument)` — instrument-level intent lock. Held
  by submission guard only.

Stable ordering: **account lock FIRST, then instrument lock.**
Refresh never takes the instrument lock, so no cycle is
possible.

Refresh is generation-fenced against slow-refresh clobbering:

1. `beginPositionSnapshotRefresh` — under account lock:
   `INSERT ... ON CONFLICT DO UPDATE SET generation = generation + 1, complete = FALSE`.
   Returns the new `generation`.
2. Broker fetch runs WITHOUT holding any lock.
3. `completePositionSnapshotRefresh` — under account lock:
   compares stored `generation` to caller-supplied one. If
   another `begin` bumped it in the meantime, returns
   `{ kind: "stale_generation" }` and the caller's stale data
   is discarded. Otherwise atomically replaces rows and flips
   `complete = true`.

`invalidatePositionSnapshot(...)` is a shortcut that runs step
1 only — used by fill / status-update / partial-fill /
reconciliation callbacks to close the fail-closed window
before doing the local terminal transition.

### 8. Account-summary failure semantics (round-8 blocker)

`GET /execution/account/summary` no longer papers over refresh
failures with a 200 that carries a live snapshot. If the
awaited `refreshBrokerPositionSnapshot` ends in
`SnapshotHealth.failed`, the endpoint returns **503** with:

```json
{
  "error": "position_snapshot_persistence_failed",
  "accountId": "...",
  "reason": "<broker fetch error>",
  "positionSnapshotPersistence": { "status": "failed", "error": "..." }
}
```

Readiness stays 503 and the write path stays fail-closed until
the next successful refresh.

### 9. Generation-aware refresh coordinator (round-9 blocker)

A naive coalescer (`if (existing) return existing`) silently
LOSES a refresh request when an invalidation happens WHILE a
refresh is in flight. Concrete scenario:

1. Refresh A begins with `generation = 10`.
2. A fetches broker state (long HTTP round-trip).
3. Fill callback invalidates → `generation = 11`, `complete = false`.
4. Fill callback calls `refreshBrokerPositionSnapshot` again →
   naive coalescer returns A's promise.
5. A completes → `stale_generation` (11 ≠ 10) → no write.
6. No B ever starts → `complete=false` forever, `/ready` 503,
   write path fail-closed forever.

`RefreshCoordinator` (`apps/execution-engine/src/refresh-coordinator.ts`)
solves this with a **generation-fenced loop**:

- Public entry `refresh(accountId)` coalesces onto the running
  loop for the account. Safe because the loop itself handles
  post-invalidation cases by re-iterating.
- The loop iterates `begin → fetch → complete → getStatus`
  until it observes `complete = true` in the persisted state.
- Each iteration bumps generation via `begin`. A concurrent
  invalidation forces the next iteration's `complete` to see
  its own bumped generation (unless yet another invalidation
  races). `getStatus` is the source of truth for the exit
  condition.
- On broker/DB failure (`begin`, fetch, `complete`, or status
  read) the loop marks health `failed` and exits;
  `complete=false` persists, `/ready` stays 503, write path
  stays fail-closed until the next successful refresh.
- `MAX_REFRESH_LOOP_ITERATIONS` (8) bounds pathological churn.
  Exhaustion marks health `failed` with `"did not converge"`.

Round-9 also extends `getPositionSnapshotStatus` to expose
`generation` alongside `complete`, so the coordinator can
recognise "newer refresh already completed on our behalf"
(exit healthy without an extra broker fetch) versus "newer
refresh started but not yet complete" (rerun required).

### 10. Broker callback account identity (round-9 blocker)

- `BrokerExecutionFill.accountId` (from executionDetails) is
  the authoritative source; the fill callback ignores fills
  whose `accountId` does not match the current
  `lastActiveAccountId` — a stale event from a previous
  account CANNOT invalidate the current active account's
  snapshot.
- `BrokerOrderStatusUpdate` does NOT carry `accountId`. The
  callback relies on the SINGLE-ACTIVE-ACCOUNT invariant
  (`ensureBrokerSession` + env-guard whitelist) and uses
  `lastActiveAccountId`. Reconnect / account change resets
  this state before any subsequent callback can fire.

### 5. Snapshot TTL — display vs. guard (round-7 blocker)

Two SEPARATE freshness thresholds:

- `EXECUTION_POSITION_MAX_AGE_S` (default 60 s) — display
  cache TTL for `/execution/account/summary`. UI-facing;
  wide window acceptable.
- `EXECUTION_POSITION_GUARD_MAX_AGE_S` (default 10 s) —
  authoritative write-path exposure guard. Significantly
  shorter because the guard controls exposure-increasing
  writes; a 60 s window is wide enough for many broker fills
  to land undetected between the snapshot and the write.
  Production deployments should tighten further and rely on
  the broker-driven refresh triggers (fill events, reconnect,
  startup) to keep the snapshot within the window.

## Idempotency key — `clientOrderId` identifies the TRIGGER, `clientOrderHash` identifies the PAYLOAD

Format (v4, round-5):

```
clientOrderId    = loop:v4:<instrumentId>:<strategyId>:<triggerId>
clientOrderHash  = computeClientOrderHash(ticket)   (unchanged)
```

Where:

- `strategyId` from `Instrument.executionPolicy.strategyId`
- `triggerId` = `evaluation.<timeframe>.<bucketStartMs>` —
  `snapshot.sections.price.observedAt` rounded DOWN to the
  strategy's timeframe. The label is **`evaluation`**, not
  `candle`, because PR14 has no ingestion-emitted candle-close
  event; `floor(observedAt / timeframe)` returns the START of
  the current wall-clock bucket, not proof of candle close.

### Why the intent hash is NOT in the clientOrderId (round-5 fix)

Baking the payload into the id (`loop:v4:...:<intentHash>`)
turned every payload change into a NEW `clientOrderId`, which
bypassed execution-engine's `duplicate_terminal` /
`idempotency_conflict` semantics — a modified ticket after a
REJECTED / CANCELLED would slip in under a fresh id. Round-5
strips the payload from the id; the payload lives exclusively
in `clientOrderHash` which execution-engine already validates
via the UNIQUE(client_order_id) + hash-match rules.

Guarantees:

| Scenario                                    | Behaviour                                                     |
| ------------------------------------------- | ------------------------------------------------------------- |
| Same trigger + same ticket, many ticks      | Same id + same hash → `DUPLICATE`                             |
| Same trigger + CHANGED order-critical field | Same id + different hash → `CONFLICT`                         |
| New evaluation bucket + identical ticket    | New id + same hash → new submission, subject to atomic guards |
| UNKNOWN retry with same trigger             | Same id                                                       |
| Process restart evaluating the same trigger | Same id (pure function of `(id, strategyId, triggerId)`)      |

### `clientOrderHash` is never trusted from the caller

`ExecutionRuntime.executePrepared` signature accepts only
`{ dryRunResult, idempotencyKey }` — it ALWAYS re-derives the
hash from `dryRunResult.pipeline.ticket` via
`computeClientOrderHash`. There is no seam through which a
caller-supplied stale / swapped hash could reach the submitter.
This preserves the CONFLICT signal when the ticket is mutated
between builds.

The trade-off vs. round-4's optional `precomputedHash`: an extra
SHA-256 per cycle. Cost is negligible vs. HTTP + Postgres + IBKR.

### Two-phase execution (single pipeline call per cycle)

The loop still calls `MarketDataRuntime.dryRun` ONCE per
instrument tick — snapshot + pipeline result. The pipeline
result is forwarded via `executePrepared({ dryRunResult,
idempotencyKey })` which skips its own dry-run but recomputes
the hash.

## Per-instrument execution policy

`Instrument.executionPolicy` supplies every order-critical
parameter: `strategyId`, `timeframe`, `quantity`, `maxQuantity`,
`quantityUnit`, `allowedOrderTypes`, `defaultOrderType`,
`timeInForce`, `outsideRth`, `transmit`, `priceTickSize`,
`priceRoundingMode`, optional bracket distances.

`resolveInstrumentPolicy` fail-closes on missing / invalid
policy, disallowed `defaultOrderType`, `priceTickSize <= 0`, or
resolved quantity <= 0. No global default — `priceTickSize` MUST
come from validated registry / broker metadata.

## Readiness

`GET /runtime/trading-loop/ready` — composite: paper guard,
exposure reader (both endpoints), Redis, Postgres. Disabled
loop → 200 unconditionally, upstream probes NOT fired.

## Startup / shutdown

`TradingLoopService.start()` is a no-op when disabled. On
SIGINT / SIGTERM, `tradingLoopService.stop()` runs first
(refuses new ticks, waits up to
`TRADING_LOOP_SHUTDOWN_TIMEOUT_MS` for in-flight runs to drain),
THEN `app.close()`, Redis, Postgres. `stop()` is idempotent.

## Observability

One structured pino entry per instrument run:

```
{
  component: "trading-loop",
  cycleId, instrumentId,
  startedAt, finishedAt, durationMs,
  kind, idempotencyKey, reason, message, runtimeOutcome
}
```

## Outcome union

| Kind                                                           | Meaning                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUBMITTED` / `DUPLICATE` / `PENDING` / `CONFLICT` / `UNKNOWN` | pass-through from `ExecutionRuntime`                                                                                                                                                                                   |
| `NOT_SUBMITTED` reasons                                        | `NO_TRADE`, `PIPELINE_FAILURE`, `PAPER_GUARD_FAILED`, `UNSUPPORTED_TICKET_SHAPE`, `ACTIVE_INTENT_EXISTS`, `OPEN_POSITION_EXISTS`, `POSITION_STATE_UNAVAILABLE`, `INSTRUMENT_POLICY_UNAVAILABLE`, `TRIGGER_UNAVAILABLE` |
| `SKIPPED / LOOP_DISABLED`                                      | scheduler stopped mid-cycle                                                                                                                                                                                            |
| `SKIPPED / RUN_IN_PROGRESS`                                    | per-instrument non-overlap                                                                                                                                                                                             |
| `SKIPPED / CONCURRENCY_CAP`                                    | global cap reached                                                                                                                                                                                                     |
| `SKIPPED / EXPOSURE_BLOCKED`                                   | any of the four pre-check flags true                                                                                                                                                                                   |
| `SKIPPED / EXPOSURE_READ_FAILED`                               | fail-closed skip on validation / http / stale / timeout                                                                                                                                                                |
| `ERROR`                                                        | unexpected runtime exception                                                                                                                                                                                           |

## Real PostgreSQL integration test

`apps/execution-engine/src/repository.pg-integration.test.ts`
runs when `TEST_POSTGRES_URL` is set. Covers advisory lock
serialisation, per-instrument isolation, ROLLBACK releases,
same-`clientOrderId` retry path, terminal statuses do not block,
`PositionGuardContext=unavailable` fail-closed, snapshot
missing / stale / incomplete / `wrong_session`,
`open_position_exists` on match, `allowCrossContractExposure`
policy semantics (default `false` blocks rollover; explicit
`true` allows exact-conId matching), symbol fallback for
tickets without conId, per-conId uniqueness, AND the round-6
resume-path invariants: `tryStartSubmissionWithExposureGuard`
refuses on `unavailable` / `wrong_session` / open position
without setting the marker, succeeds on a fresh flat snapshot,
and two concurrent resume requests via separate connection
pools serialise so exactly one obtains `claimed`.

## No exit management (PR14 boundary)

Loop does NOT emit close orders. Trailing stop, partial close,
exit signals, and reconciliation of orphan PROPOSED are PR15 /
PR16.
