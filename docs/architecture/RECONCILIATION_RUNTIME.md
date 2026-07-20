# Reconciliation Runtime (PR15)

Durable, scheduled, fail-closed reconciliation for the
execution-engine. See
[`docs/implementation/phase2/PR15_PLAN.md`](../implementation/phase2/PR15_PLAN.md)
for the full plan; this file is the operator-facing runtime
reference.

## Source of truth

- **Broker (IBKR)** — positions, open orders, executions, fills.
- **`reconciliation_runs`** (Postgres) — every run's status +
  `source_coverage`; consumed by `/ready`, `/execution/reconciliation/latest`,
  and the write-path submission gate.
- **`reconciliation_holds`** — active per-identity blocks.
- **`broker_order_links`**, **`broker_order_ref_map`** — the ONLY
  authoritative mapping from a broker order back to a
  `proposed_orders` row. `startsWith` prefix matches on `orderRef`
  are NEVER treated as ownership — a spoofed lookalike ref does not
  own our order.

## Identity

Canonical `identity_key` (see `reconciliation/identity.ts`):

1. `conid:<accountId>|<conId>` when both present.
2. `sym:<accountId>|<symbol>|<secType>|<exchange>|<currency>` fallback.
3. Missing `accountId` → `identity_ambiguous` — NEVER aggregated
   across accounts.

Two identical-symbol futures on different exchanges have DISTINCT
keys.

## Scheduler

Env knobs (see `.env.example` block "PR15 — Durable
reconciliation & recovery"):

| Env | Default | Meaning |
| --- | ------- | ------- |
| `RECONCILIATION_LOOP_ENABLED` | `true` | Master switch. |
| `RECONCILIATION_INTERVAL_MS` | `60000` | Tick period. |
| `RECONCILIATION_STARTUP_DELAY_MS` | `2000` | Delay before first tick. |
| `RECONCILIATION_MIN_INTERVAL_MS` | `15000` | Safety floor. |
| `RECONCILIATION_SOURCE_TIMEOUT_MS` | `8000` | Per-source read timeout. |
| `RECONCILIATION_RUN_TIMEOUT_MS` | `45000` | Hard cap; ABANDONED after this. |
| `RECONCILIATION_EXECUTION_SAFETY_MARGIN_MS` | `300000` | Prepended to `reqExecutions` windowStart. |
| `EXECUTION_RECONCILIATION_RESOLVE_TOKEN` | *(empty)* | Secondary token for `POST /holds/:id/resolve`. Empty → 403. |
| `EXECUTION_READY_RECONCILIATION_MAX_AGE_S` | *(existing)* | The ONE staleness knob — used by `/ready` AND the submission gate. |

Non-overlapping via an in-process mutex + PG session-scoped
`pg_try_advisory_lock(hashtext('recon:<account>'))` on a dedicated
`PoolClient` released in `finally`.

## Three-phase run

- **Phase A** (short DB tx under `snap:<account>`): sweep
  ABANDONED (prior session AND current-session RUNNING past
  `RECONCILIATION_RUN_TIMEOUT_MS`), INSERT the run row with
  `status='RUNNING'`.
- **Phase B** (NO DB tx): `IbBrokerReconciliationAdapter.capture`
  fires `reqPositions/positionEnd`, `reqAllOpenOrders/openOrderEnd`,
  and `reqExecutions/execDetailsEnd` in parallel; every source
  has an independent bounded timeout and honours the run-level
  `AbortSignal`. All IB listeners are removed on success / error
  / timeout / abort (leak-safe).
- **Phase C** (short DB tx under `snap:<account>`): finalise the
  run row + apply hold inserts/resolves atomically.

Timeout finalisation runs in a third short tx on the same
connection with the same `recon:<account>` lock.

## Broker source coverage

- **`exposureComplete`** — `positions` + `openOrders` + `executions`
  all `available` and (for executions) `exposureWindowComplete`.
- **`recoveryComplete`** — `exposureComplete` AND
  `executions.recoveryWindowComplete` AND
  `completedOrders.available`.
- `ib@0.2.9` does NOT expose `reqCompletedOrders` — reported as
  `available=false, reason='unsupported_by_ib_module'`. On its
  own that only blocks *ambiguous instruments* (via a
  `recovery_source_missing` hold), never the whole account.

Broker order classification (`BOT_OWNED` / `EXTERNAL_API` /
`MANUAL` / `UNKNOWN`) NEVER classifies as `BOT_OWNED` on a mere
prefix — either an exact `broker_order_ref_map` hit or a `permId`
we persisted plus a matching `clientId`.

## Authoritative submission gate

Runs INSIDE the same PR14 transaction and advisory locks
(`snap:<account>` → `hashtext(instrument)`) as the exposure
guard. Lives in
`reconciliation/submission-gate.ts::buildReconciliationSubmissionGate`
and is injected into `insertProposedFromTicket` and
`tryStartSubmissionWithExposureGuard` via the
`reconciliationGate` option. Decision matrix (first hit wins):

1. RUNNING in current session → `reconciliation_running`.
2. No completed run for current session → `reconciliation_never_ran_in_session`.
3. Latest run's `sessionId` ≠ current → `reconciliation_wrong_session`.
4. Latest run FAILED → `reconciliation_failed`.
5. Latest run ABANDONED → `reconciliation_abandoned`.
6. Latest run `exposureComplete=false` → `reconciliation_incomplete_exposure`.
7. Latest run older than `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`
   → `reconciliation_stale`.
8. Active hold for canonical identity → `reconciliation_hold`.
9. Otherwise → pass.

Submission NEVER acquires `recon:<account>`. The read is a plain
SELECT under the caller's tx; the runner's writes are
made visible via the shared `snap:<account>` xact lock the runner
briefly takes in Phase A and Phase C.

## Submission three-phase — atomic

Broker submission is orchestrated by a single production
service:
`apps/execution-engine/src/reconciliation/submission-service.ts::buildSubmissionApplicationService`.
BOTH `POST /execution/execute-ticket` and
`POST /execution/execute-proposed/:id` — plus the PR15 r7
integration suite — construct THE SAME module. Tests inject a
`BrokerOrderDispatcher` fake for the broker port; every other
dep (repository, hash function, MKT policy, kill switch,
alerts, reconciliation trigger, position guard, prepare
function) is the production implementation.

Broker dispatch requires idempotency identity. `POST /execution/
execute-ticket` refuses `persist=true` without BOTH
`clientOrderId` and `clientOrderHash` (400,
`idempotency_identity_missing`); the execution-engine NEVER
generates identifiers. `POST /execution/execute-proposed/:id`
refuses rows with `client_order_id IS NULL OR client_order_hash
IS NULL` (409, `LEGACY_IDEMPOTENCY_IDENTITY_MISSING`) — legacy
rows must be resolved via `LINK_TO_BROKER_ORDER` /
`CONFIRMED_NOT_SUBMITTED`. `REJECTED` rows are immutable;
`overrideRejected=true` returns
`REJECTED_ORDER_IMMUTABLE` (409). Both the initial submit and
every resume recompute `computeClientOrderHash(persistedTicket)`
and refuse on divergence (`CLIENT_ORDER_HASH_MISMATCH`).

`ExecutionRepository.tryStartSubmissionWithPlan(...)` first
fail-closes malformed plans (`invalid_plan` outcome: missing
`clientOrderId`, `clientOrderHash`, `instrument`, empty legs,
missing `brokerOrderId`, missing `orderRef`, duplicate
`orderRef`, duplicate `brokerOrderId`). On a well-shaped plan
it runs Phase B in ONE tx under `snap:<accountId>` +
`hashtext(instrument)`:

1. reconciliation gate + exposure guard;
2. `SELECT ... FOR UPDATE` on `proposed_orders` + verify
   `id`, `client_order_id`, `client_order_hash`, `instrument`,
   `conid` match the prepared plan (any mismatch →
   `submission_identity_mismatch`, ROLLBACK);
3. atomic claim (`execution_attempted_at IS NULL` UPDATE) +
   `execution_account_id` + decision metadata;
4. INSERT every `broker_order_links` row (PLANNED, with
   pre-allocated `broker_order_id`) — persistence is
   UNCONDITIONAL, the pre-tx shape checks guarantee non-empty
   input;
5. UNNEST INSERT `broker_order_ref_map`
   (`ON CONFLICT (broker_order_ref) DO NOTHING RETURNING`);
   any missing row → `plan_collision`, ROLLBACK the entire tx.

Only `{ kind: "claimed_with_persisted_plan" }` permits
`dispatchPreparedOrder`. Fresh insert and resume both use this
method — the orchestrator's `tryStartSubmission` dep IS this
call (index.ts). Phase A (`prepareBrokerOrderPlan`) runs BEFORE
the tx and does zero DB writes; Phase C
(`dispatchPreparedOrder`) uses the persisted IDs verbatim and
never allocates new order IDs or rebuilds the bracket.

### Crash matrix

| Crash window | State | Recovery |
|---|---|---|
| Before atomic commit | No marker. No plan. No broker call. | Safe retry — next request runs the full atomic method. |
| After atomic commit, before dispatch | Marker + full plan (legs + refs) persisted. | Reconciliation matches on `broker_order_ref_map` / `permId` / `brokerOrderId` and posts a lifecycle transition. Retry cannot re-claim (marker fails `IS NULL`). |
| During partial dispatch (≥1 `placeOrder` accepted) | Marker + plan preserved. Local exception. | `dispatch_unknown` CRITICAL alert + reconciliation triggered. Row is NEVER marked CANCELLED locally. |
| IBKR accepted, no callback landed | Marker + plan preserved. | Next reconciliation sees the broker order via `permId` / `orderRef` / `brokerOrderId` and drives lifecycle. |

## Ambiguous-PROPOSED recovery

Match priority (exact only — NO prefix ownership):

1. `broker_order_ref_map` exact match.
2. `permId` on `broker_order_links` for the same `proposed_order_id`.
3. `broker_order_id` present locally AND observed in `openOrders`
   / `completedOrders` / `executions`.

- Positive match → resolve `unknown_submission` /
  `recovery_source_missing` / `orphan_broker_order` via
  `auto_broker_match`; `execution_attempted_at` is NEVER cleared;
  no auto-retry.
- No match on `recoveryComplete=true` snapshot → create hold
  `unknown_submission`.
- No match on `exposureComplete=true, recoveryComplete=false` →
  create hold `recovery_source_missing` (per-identity only).
- No match on `exposureComplete=false` → NO hold; global write
  gate already fail-closes.

## Operator resolution — atomic

`POST /execution/reconciliation/holds/:id/resolve` requires the
secondary `EXECUTION_RECONCILIATION_RESOLVE_TOKEN` header
(`X-Reconciliation-Resolve-Token`). Body carries a disposition
enum:

- **`LINK_TO_BROKER_ORDER`** — verify hold + account + identifiers
  in one tx under `snap:<account>`, refuse if the target broker
  order is already linked to a DIFFERENT `proposed_order_id`,
  UPSERT `broker_order_links` + `broker_order_ref_map`, flip the
  hold. `atomicOperatorLinkAndResolve`.

  PR15 r6 correlated verification: the same tx SELECTs EVERY
  observation row for
  `(reconciliation_run_id, account_id, session_id,
  broker_order_id)` — one broker order can produce
  openOrder + completedOrder + execution rows, each carrying
  a subset of identifiers. Correlation invariants:
    * every row shares account_id + session_id + run + bid
      (guaranteed by the SELECT),
    * any two non-null `perm_id` values MUST agree,
    * any two non-null `order_ref` values MUST agree,
    * an operator-supplied `permId` MUST be present on some
      row, same for `orderRef`.
  Identifiers are NEVER combined across different broker_
  order_id / run / account / session. Downstream writes use
  the verified observation values, not the operator-supplied
  strings.

  Refusal codes:
    * `broker_order_not_observed` — `brokerOrderId` absent
      from the reference run,
    * `CORRELATION_CONFLICT` — non-null identifiers disagree
      across observations of the same broker order,
    * `CORRELATION_NOT_FOUND` — operator-supplied identifier
      not present on any observation row in the group,
    * `snapshot_stale` — reference run older than threshold,
    * `no_complete_snapshot_for_session` — no complete run
      for the current session,
    * `broker_order_already_linked` / `order_ref_already_linked`
      — same brokerOrderId / orderRef already links a
      different `proposed_order_id`.
  Refusal keeps the hold active, produces no
  `proposed_orders` / `broker_order_links` mutation, and
  records a full audit event.
- **`CONFIRMED_NOT_SUBMITTED`** — one tx: refuse if any positive
  broker link exists for the proposed order, terminal-mark
  REJECTED (never clearing `execution_attempted_at`), flip the
  hold. `atomicOperatorConfirmNotSubmitted`. Never enqueues
  a retry.
- **`KEEP_BLOCKED`** — records `resolution_intent`, keeps hold
  active.

Bare `{ note }` on the resolve endpoint returns
`400 disposition_required`. Missing secondary token returns
`403 resolve_disabled` — hold stays permanently active by design.

## Legacy compatibility

`POST /execution/reconciliation` remains as a thin alias that
delegates to `reconScheduler.triggerNow()`. `runReconciliation()`
in `index.ts` is a compatibility shim built on top of the new
runner — the in-memory implementation was removed. Startup
reconciliation is performed by the scheduler on its first tick,
not by a bespoke bootstrapping routine.

## Signal-engine fail-closed reader

`apps/signal-engine/src/runtime/trading-loop/reconciliation-reader.ts`
polls `/latest` + `/holds?active=true` before the trading loop
runs the pipeline. Any of RUNNING / FAILED / ABANDONED /
wrong-session / exposure-incomplete / stale / matching hold /
transport error / malformed body → SKIP the instrument. The
execution-engine remains the authoritative gate.

## Test surface

- `reconciliation/order-ref.test.ts` — deterministic short ref.
- `reconciliation/identity.test.ts` — canonical identity.
- `reconciliation/fake-broker-adapter.test.ts` — completeness
  matrix.
- `reconciliation/runner.pg-integration.test.ts` — Phase A/B/C,
  wrong-session, INCOMPLETE (recovery vs exposure), mismatch
  hold, auto_snapshot_clean, concurrent-runner serialisation.
- `reconciliation/submission-gate.pg-integration.test.ts` —
  authoritative gate blocks under the SAME PR14 tx (hold,
  wrong-session, never-ran).
- `reconciliation/matcher.pg-integration.test.ts` — spoofed
  prefix does NOT create `auto_broker_match` (regression).
- `runtime/trading-loop/reconciliation-reader.test.ts` — signal-
  engine fail-closed cases.
