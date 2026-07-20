# PR15 — Durable Reconciliation & Recovery — PLAN (revision 6)

> Revision 6 (PR15_REPORT r6) closes the last submission
> hardening gaps:
>
> - `POST /execution/execute-ticket` REQUIRES
>   `clientOrderId + clientOrderHash` for every submission-capable
>   request; the legacy no-idempotency dispatch branch is deleted.
> - `POST /execution/execute-proposed/:id` rejects legacy rows
>   with `client_order_id IS NULL OR client_order_hash IS NULL`
>   (`LEGACY_IDEMPOTENCY_IDENTITY_MISSING`, 409).
> - Server-side `computeClientOrderHash(ticket)` verifies the
>   caller-supplied hash on every submission; mismatch →
>   `CLIENT_ORDER_HASH_MISMATCH`. Shared helper lives in
>   `@ikbr/shared/client-order-hash` (keyed on `SignalTicket`),
>   used by both engines.
> - `tryStartSubmissionWithPlan` fail-closes malformed prepared
>   plans (`invalid_plan`): missing identity, empty legs,
>   missing `brokerOrderId`/`orderRef`, duplicate `orderRef` /
>   `brokerOrderId`.
> - `orderType` is no longer defaulted to `MKT`; MKT is refused
>   under the current server-side policy
>   (`SERVER_ALLOW_MARKET_ORDER=false`).
> - `atomicOperatorLinkAndResolve` aggregates ALL observation
>   rows for `(run, account, session, brokerOrderId)`;
>   non-null identifier conflicts across the group →
>   `CORRELATION_CONFLICT`; missing correlation →
>   `CORRELATION_NOT_FOUND`.
> - New PG integration suite exercises the real production
>   `SubmissionApplicationService` (used by both endpoints) end
>   to end with a fake broker.
>
> Revision 5 addresses reviewer feedback on rev 4. Highlights of
> the delta:
>
> - §6 Enforcement collapses onto a single authoritative
>   `tryStartSubmissionWithPlan` (see §4). The old
>   `tryStartSubmissionWithExposureGuard` /
>   `insertProposedFromTicket` names are gone. `persist=false` is
>   refused BEFORE any authoritative guard runs (§4a).
> - Hold lifecycle preconditions tightened:
>   `auto_snapshot_clean` needs `exposureComplete=true` + zero
>   position diff (NOT `recoveryComplete`); `auto_broker_match`
>   needs completeness of the SOURCE that supplied the positive
>   evidence (not `recoveryComplete`); `recoveryComplete` is
>   still required to conclude "never submitted".
> - `RECONCILIATION_UNAVAILABLE` is not automatic on any
>   `INCOMPLETE`. The write gate reads `source_coverage`: only
>   `exposureComplete=false` blocks globally; on
>   `exposureComplete=true`, `INCOMPLETE` runs pass the global
>   gate and only per-identity holds refuse requests.
> - `ABANDONED` semantics: the LATEST current-session
>   `ABANDONED` blocks readiness and the write path exactly like
>   `FAILED`. Foreign-session runs are always ignored;
>   historical `ABANDONED` is ignored ONLY when superseded by a
>   newer valid current-session `CLEAN`, `MISMATCH`, or
>   `INCOMPLETE` run with `exposureComplete=true`.
> - `prepareBrokerOrderPlan` stays PURE — no DB reads, no
>   collision check. Collision on `broker_order_ref` is caught
>   atomically inside `tryStartSubmissionWithPlan` by the
>   `broker_order_ref_map` PRIMARY KEY / partial-unique
>   constraint (`ON CONFLICT DO NOTHING` + row-count check ⇒
>   `ORDER_REF_COLLISION`, rollback, zero broker calls).
> - `executions` coverage exposes ONLY
>   `exposureWindowComplete` / `recoveryWindowComplete`. The
>   generic `SourceCoverage.boundedWindow` is documented as
>   unused for executions (always `true` if any window returned;
>   the semantic windows drive the run). All prose, tables, and
>   tests updated accordingly.
> - §3 code fence deduplicated; env-key count corrected to
>   **eight** new keys (not seven).
>
> Cumulative rev 2 → rev 4 highlights retained below.
>
> - Runner publication protocol split: `RUNNING` is committed in
>   a short `snap:<acct>` transaction BEFORE broker reads; broker
>   reads run **outside** any DB transaction; final commit lands
>   in a second short `snap:<acct>` transaction on the same
>   `PoolClient` that also holds the session-scoped
>   `recon:<acct>` lock. No claim that broker reads share a DB
>   transaction.
> - Positive evidence vs. absence-of-evidence separated:
>   `exposureWindowComplete` / `recoveryWindowComplete` for
>   executions coverage. A positive match in complete open orders
>   or executions can move to `SUBMITTED` / `FILLED` even if
>   `completedOrders` is unavailable. `recoveryComplete` remains
>   required only to *conclude* an order was NOT submitted.
> - Order plan lifecycle refactor mandated:
>   `prepareBrokerOrderPlan` → `tryStartSubmissionWithPlan`
>   (single tx: guards + `execution_attempted_at` + all
>   `broker_order_links` legs + `broker_order_ref_map`) →
>   `placePreparedOrder`. Same protocol for fresh insert and
>   orphan resume. Persistence failure ⇒ rollback + zero broker
>   calls + `SUBMISSION_PERSIST_FAILED`.
> - `persist=false` direct-ticket path DISABLED for broker
>   submission in PR15 — every broker call requires a durable
>   proposed order + leg links + ref map.
> - Schema tightened: reconciliation_runs.status uses the
>   existing `INCOMPLETE` value + `source_coverage` flags (no
>   parallel `INCOMPLETE` with `exposureComplete=true` and
>   `recoveryComplete=false`); `recovery_source_missing`
>   added to holds reasons; `broker_order_links.account_id`
>   added; `perm_id` uniqueness is `(account_id, perm_id) WHERE
>   perm_id IS NOT NULL`; `orderRef` hash collision detected
>   before any `placeOrder` ⇒ fail-closed;
>   `broker_observed_at` renamed to explicitly mean *snapshot
>   capture completion* time.
> - Single staleness knob: **reuse existing**
>   `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`. No new
>   `RECONCILIATION_MAX_AGE_S`. Readiness and write gate share
>   the value.
> - Lock protocol corrected in checklist: submission is
>   `snap:<acct> → hashtext(instrument)`; runner is
>   `recon:<acct>` session-scoped on a dedicated `PoolClient`
>   released in `finally`, with `snap:<acct>` only during two
>   short publication transactions. There is no `snap → recon →
>   inst` chain. Submission never acquires `recon:*`.
> - Readiness split: an `INCOMPLETE` run whose
>   `exposureComplete=true` and `recoveryComplete=false` is a
>   per-instrument restriction (hold), NOT a global 503. Global
>   503 reserved for exposure-incomplete, RUNNING, FAILED,
>   ABANDONED, stale, wrong-session, no-run-in-session.
>
> Awaiting review per AGENTS.md workflow (§Development Workflow §5).
> Do NOT implement anything below without explicit approval.

## Goal

Turn the current in-RAM `runReconciliation()` fire-and-forget into a
**persistent, scheduled, fail-closed** reconciliation surface that:

- persists every run and every mismatch as a durable *hold*,
- enforces holds authoritatively in `execution-engine` — the write
  path SELECTs `reconciliation_holds` / `reconciliation_runs` under
  the existing PR14 `snap:<acct> → hashtext(instrument)` locks (it
  does NOT acquire `recon:*`), so `signal-engine` and
  `/execution/execute-ticket` cannot bypass,
- recovers ambiguous `PROPOSED + executionAttemptedAt` rows via
  positive `orderRef` / `permId` / `brokerOrderId` matching only,
- refuses to serve write traffic until an
  `exposure`-complete reconciliation exists for the *current*
  execution session; per-instrument `recovery`-incomplete holds
  block only affected identities.

Extends existing `runReconciliation()`. **No parallel system.**

## Non-goals (hard bounds)

- No live path, no auto-close, no auto-cancel on mismatch.
- No exit management, trailing stops, partial closes (PR16).
- No retry of ambiguous submissions.
- No downgrading of any PR13/PR14 guard.
- No edits to `000001_baseline.sql` / `000002_execution_pr13_pr14.sql`.
- No OpenAI, no LLM in the reconciliation path.
- `EXECUTION_ALLOW_DIRECT_TICKET` no longer permits a broker
  submission that bypasses `proposed_orders` /
  `broker_order_links` (see §4a).

---

## 1. Migration `infra/sql/migrations/000003_reconciliation.sql`

Idempotent DDL only. Runs cleanly against fresh DB, `001_init.sql`
DB, and post-PR14 DB. New tables:

### `reconciliation_runs`

| column | type | notes |
| ------ | ---- | ----- |
| `id` | `BIGSERIAL PRIMARY KEY` |
| `account_id` | `TEXT NOT NULL` |
| `session_id` | `TEXT NOT NULL` | `EXECUTION_PROCESS_OWNER_ID` at run start |
| `started_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` |
| `completed_at` | `TIMESTAMPTZ` | NULL while `RUNNING` |
| `status` | `TEXT NOT NULL` | `RUNNING` / `CLEAN` / `MISMATCH` / `FAILED` / `INCOMPLETE` / `ABANDONED`. `INCOMPLETE` is one value; the exposure-vs-recovery distinction is read from `source_coverage`. |
| `snapshot_captured_at` | `TIMESTAMPTZ` | wall-clock moment the broker snapshot finished capturing (all bounded reads returned). NULL while `RUNNING`. Not derived from historical fills. |
| `snapshot_complete` | `BOOLEAN NOT NULL DEFAULT FALSE` | true iff every REQUIRED source in `source_coverage` is `available && boundedWindow (where applicable)` |
| `source_coverage` | `JSONB NOT NULL` | see §3 shape (per-source `{ available, boundedWindow, timedOut, count, reason? }` for `positions`, `openOrders`, `completedOrders`, `executions`, `session`, plus `executions.window` = `{ from, to, exposureWindowComplete, recoveryWindowComplete }`) |
| `expected_positions_count` | `INT` |
| `broker_positions_count` | `INT` |
| `matches` | `INT` |
| `mismatches_count` | `INT` |
| `error` | `TEXT` |
| `report` | `JSONB` | normalised full report |

Partial index: `(account_id, session_id, started_at DESC)`.
Partial index on `status='RUNNING'` for the "in-flight" check.

### `reconciliation_holds`

| column | type | notes |
| ------ | ---- | ----- |
| `id` | `BIGSERIAL PRIMARY KEY` |
| `account_id` | `TEXT NOT NULL` |
| `instrument` | `TEXT NOT NULL` | broker symbol |
| `conid` | `TEXT` |
| `sec_type` | `TEXT` |
| `exchange` | `TEXT` |
| `currency` | `TEXT` |
| `identity_key` | `TEXT NOT NULL` | see §2, canonical identity |
| `reason` | `TEXT NOT NULL` | `position_mismatch` / `orphan_broker_order` / `unknown_submission` / `recovery_source_missing` / `identity_ambiguous` / `manual` |
| `severity` | `TEXT NOT NULL` | `warn` / `error` / `critical` |
| `reconciliation_run_id` | `BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT` |
| `active` | `BOOLEAN NOT NULL DEFAULT TRUE` |
| `payload` | `JSONB` | mismatch snapshot for operator |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` |
| `acknowledged_at` | `TIMESTAMPTZ` | operator acknowledge (does NOT unblock) |
| `acknowledged_by` | `TEXT` | token fingerprint |
| `acknowledge_note` | `TEXT` |
| `resolved_at` | `TIMESTAMPTZ` | NULL while active |
| `resolved_by` | `TEXT` | `system` / operator token fingerprint |
| `resolved_kind` | `TEXT` | `auto_snapshot_clean` / `auto_broker_match` / `operator_resolve` |
| `resolution_note` | `TEXT` |

Partial unique index on `(account_id, identity_key, reason) WHERE active`
(one active hold per identity + reason).

### `broker_order_links` (bracket-aware child mapping)

Replaces "one `broker_order_ref` / `broker_perm_id` pair per row"
because a single `proposed_orders` row can spawn parent + N children
(TP/SL + partial ladder). Reconciliation must recognise **every** leg.

| column | type | notes |
| ------ | ---- | ----- |
| `id` | `BIGSERIAL PRIMARY KEY` |
| `proposed_order_id` | `BIGINT NOT NULL REFERENCES proposed_orders(id) ON DELETE CASCADE` |
| `account_id` | `TEXT NOT NULL` | denormalised for cross-account uniqueness on `perm_id` |
| `role` | `TEXT NOT NULL` | `PARENT` / `TP` / `SL` |
| `role_ordinal` | `INT NOT NULL DEFAULT 0` | ladder rung index, 0 for parent |
| `broker_order_id` | `TEXT` | IBKR numeric orderId as string |
| `perm_id` | `TEXT` | IBKR `permId`, stable across the session |
| `parent_perm_id` | `TEXT` | children carry the parent's `permId` |
| `order_ref` | `TEXT NOT NULL` | the actual short ref sent to broker |
| `status` | `TEXT` | last known broker status |
| `observed_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` |

Indexes:
- Partial UNIQUE `(account_id, perm_id) WHERE perm_id IS NOT NULL`
  (broker `permId` is unique within a broker account, not globally
  across accounts; the composite key is the safe form).
- Partial UNIQUE on `order_ref` per `proposed_order_id`.
- Index on `(proposed_order_id, role, role_ordinal)`.
- Index on `(account_id, order_ref)` to accelerate reverse lookup.

### `broker_order_ref_map`

Persist the short broker ref → clientOrderId correlation so
reconciliation can walk broker rows back to our idempotency key
without embedding secrets in the ref itself.

| column | type | notes |
| ------ | ---- | ----- |
| `broker_order_ref` | `TEXT PRIMARY KEY` | `co-<hash12>` etc. |
| `client_order_id` | `TEXT NOT NULL` |
| `proposed_order_id` | `BIGINT NOT NULL REFERENCES proposed_orders(id) ON DELETE CASCADE` |
| `role` | `TEXT NOT NULL` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` |

Index: `(client_order_id)`.

### `proposed_orders` — no per-row broker ref/perm columns

The revision-1 columns are dropped from the plan — `broker_order_links`
+ `broker_order_ref_map` supersede them.

## 2. Canonical identity

Both expected and broker rows produce a `PositionIdentity` and a
canonical `identity_key` string. Matcher rule (§6 §Identity):

1. If BOTH sides expose `conId` AND both expose `accountId` →
   `identity_key = "conid:<accountId>|<conId>"`.
2. Fallback → `identity_key = "sym:<accountId>|<symbol>|<secType>|<exchange>|<currency>"`
   with each field lowercased + empty-string for missing pieces.
3. Fills without `accountId` are NEVER aggregated across accounts —
   they generate an `identity_ambiguous` hold and mark the run
   `INCOMPLETE`.

The unique-active-hold index uses `identity_key` (not `conid` or
`instrument` alone) so `secType/exchange/currency` differences are
never collapsed. Two identical-symbol futures on different exchanges
generate two independent identities.

## 3. `BrokerReconciliationAdapter`

New file `apps/execution-engine/src/reconciliation/broker-adapter.ts`.
Port + real implementation over `TwsExecutionClient`. Interface:

```ts
interface BrokerReconciliationSnapshot {
  exposureComplete: boolean;      // positions + openOrders + executions exposureWindow
  recoveryComplete: boolean;      // exposureComplete + completedOrders + executions recoveryWindow
  capturedAt: Date;               // time all bounded reads finished
  accountId: string;
  sessionId: string;
  sourceCoverage: {
    positions:        SourceCoverage;
    openOrders:       SourceCoverage;
    executions:       ExecutionsCoverage;   // see below
    completedOrders:  SourceCoverage;       // may be unsupported
    session:          SourceCoverage;
  };
  positions: BrokerPosition[];
  openOrders: BrokerOrder[];
  completedOrders: BrokerOrder[];       // empty when unsupported
  executions: BrokerExecution[];
}

interface SourceCoverage {
  available: boolean;
  boundedWindow: boolean;   // for positions / openOrders /
                            // completedOrders / session. NOT used
                            // for executions — see ExecutionsCoverage.
                            // Runner MUST NOT gate executions decisions
                            // on this field.
  timedOut: boolean;
  count: number;
  reason?: string;   // e.g. "unsupported_by_ib_module"
}

interface ExecutionsCoverage extends Omit<SourceCoverage, "boundedWindow"> {
  window: {
    from: string;                   // ISO
    to: string;                     // ISO
    exposureWindowComplete: boolean; // covers current session's activity
                                    // back to (sessionStart - safetyMargin)
    recoveryWindowComplete: boolean; // covers oldest unresolved
                                    // execution_attempted_at back to
                                    // (windowStart - safetyMargin)
  };
}
```

- Each source has a **bounded timeout**
  (`RECONCILIATION_SOURCE_TIMEOUT_MS`, default 8 s).
- Reads occur strictly OUTSIDE any Postgres transaction (see §7).
- The runner writes to Postgres only in the two short publication
  transactions of §7.

### Positive evidence vs. absence-of-evidence

The runner distinguishes what each snapshot can **prove**:

- **Positive match in one complete source** (open orders OR
  executions OR completed orders) is enough to *update* the
  local record along §9's transition table and to *auto-resolve*
  the associated hold (`auto_broker_match`). A subsequent source
  being missing does NOT invalidate the positive evidence
  already observed. Auto-resolution requires only the coverage
  of the source that supplied the evidence — NOT
  `recoveryComplete`. Concretely:
  - `openOrders.available && boundedWindow` + positive
    ref/perm/broker-order-id match → row may move to `SUBMITTED`
    and any associated hold (`unknown_submission`,
    `recovery_source_missing`, `orphan_broker_order`) on the
    same `proposed_order_id` is `auto_broker_match`-resolved.
  - `executions.available && exposureWindowComplete` +
    full-quantity match → `FILLED` and holds resolved.
  - `executions.available && exposureWindowComplete` + partial
    match → `SUBMITTED` and holds resolved.
  - `completedOrders.available && boundedWindow` + terminal
    match → `FILLED` / `CANCELLED` / `REJECTED` per §9 and
    holds resolved.
- **Absence-of-evidence** conclusions (i.e. "the broker never
  saw this order" → `unknown_submission`) require **every**
  covered source to be complete for the relevant question:
  - Conclusion "not open right now" ⇒ `openOrders.available &&
    boundedWindow`.
  - Conclusion "no execution activity ever occurred for this
    ambiguous row" ⇒ `executions.recoveryWindowComplete` AND
    `completedOrders.available && boundedWindow`.
    (i.e. `recoveryComplete=true`.)
- **Position `auto_snapshot_clean`** resolution requires
  `exposureComplete=true` (i.e. `positions` fully streamed —
  `positionEnd` observed, no timeout — AND `openOrders`
  fully returned) AND a zero position diff for the identity.
  `recoveryComplete` is NOT required and MUST NOT be checked.
- Missing `completedOrders` does NOT invalidate a positive match
  already collected from `openOrders` or `executions`. It only
  blocks the *negative* conclusion needed for
  `unknown_submission` on rows that lack any positive evidence.

Effects on run status (one status value, no parallel
`INCOMPLETE` — the exposure/recovery distinction is
carried by `source_coverage`):

| Snapshot state | Overall status | Global write-path gate | Ambiguous auto-recovery | Instrument-scoped effect |
| -------------- | -------------- | ---------------------- | ----------------------- | ------------------------ |
| `exposureComplete=true`, `recoveryComplete=true`, no mismatch | `CLEAN` | pass | allowed on all evidence | — |
| `exposureComplete=true`, `recoveryComplete=false` (e.g. `completedOrders` unavailable OR `executions.recoveryWindowComplete=false`) | `INCOMPLETE` | **pass for un-affected identities** (per §8) | positive matches still allowed; negative conclusion disallowed | hold `recovery_source_missing` scoped per ambiguous identity |
| `exposureComplete=false` | `INCOMPLETE` | fail-closed globally | disallowed | — |
| Any mismatch found in a complete-enough snapshot | `MISMATCH` | pass for un-affected identities | allowed | targeted holds |
| Runner error | `FAILED` | fail-closed globally | disallowed | — |
| Timed-out in-flight | `ABANDONED` (see §7) | fail-closed globally | disallowed | — |

Missing `completedOrders` therefore never blocks a healthy account.
It blocks only ambiguous PROPOSED identities awaiting completion
evidence. When `ib` gains `reqCompletedOrders`, adapter fills
the source and `recoveryComplete` flips true automatically.

### Broker order classification

Every broker order (open + completed) is tagged with one of:

- `BOT_OWNED` — `order_ref` matches `broker_order_ref_map` AND
  the row's `perm_id` matches a persisted `broker_order_links`
  entry OR the `clientId` on the broker report equals our
  configured `EXECUTION_CLIENT_ID`. Both signals are required to
  avoid impersonation via spoofed `orderRef`.
- `EXTERNAL_API` — non-empty `orderRef` that does NOT match our
  `co-` prefix, or `clientId` reported and differs from ours.
- `MANUAL` — placed via TWS GUI, positively identified: empty
  `orderRef` AND `clientId == 0` AND (broker-provided GUI
  indicator such as `Order.parentId == 0 && orderState.source
  == 'gui'` where available). Absent an unambiguous broker signal
  → `UNKNOWN`, not `MANUAL`.
- `UNKNOWN` — anything not proven `BOT_OWNED` / `EXTERNAL_API`
  / `MANUAL`.

`BOT_OWNED` participates in ambiguous-PROPOSED recovery (§5).
`MANUAL` / `EXTERNAL_API` / `UNKNOWN` open orders create
`orphan_broker_order` holds and DO NOT auto-cancel.

Test double: `FakeBrokerReconciliationAdapter` supports both a
`completedOrders=unsupported` mode and a full-coverage mode.

### Execution lookup window

`reqExecutions` requires a start-time filter. The runner computes:

```
exposureStart = currentSession.startedAt - RECONCILIATION_EXECUTION_SAFETY_MARGIN_MS
recoveryStart = min(
  exposureStart,
  min(proposed_orders.execution_attempted_at
      WHERE status='PROPOSED' AND execution_attempted_at IS NOT NULL
      AND NOT terminal marker) - RECONCILIATION_EXECUTION_SAFETY_MARGIN_MS,
)
windowEnd = now()
```

Broker retention drives coverage:
- If the broker accepts `from = exposureStart` → set
  `sourceCoverage.executions.window.exposureWindowComplete = true`.
- If the broker also accepts `from = recoveryStart` → set
  `recoveryWindowComplete = true`.
- Broker refuses `recoveryStart` (too far back) → issue
  `reqExecutions` with the accepted lower bound,
  `recoveryWindowComplete = false`,
  `reason="window_predates_broker_limit"`. That drives
  `recoveryComplete=false`; `exposureComplete` stays `true` as
  long as `exposureWindowComplete=true`. The affected instrument
  gets a `recovery_source_missing` hold; other identities are
  unaffected.

## 4. `orderRef` / `permId` + atomic order-plan lifecycle

`orderRef` is a **short, deterministic correlation identifier only**.
IBKR does NOT guarantee broker-side idempotency on `orderRef`; do
not rely on it. The idempotency contract stays PR13's
`client_order_id UNIQUE` + Postgres advisory lock.

### Ref derivation

- Never send the raw `clientOrderId` (opaque UUID, 36+ chars).
- Parent: `broker_order_ref = "co-" + hash12` where
  `hash12 = base32Crock(sha256("v1|" + clientOrderId)).slice(0,12)`.
  Total 15 chars, safe for IBKR `orderRef`.
- Children: role suffix — `"co-" + hash10 + "-<role><ord>"`,
  e.g. `co-ab12cd34ef-tp1`, ≤ 20 chars.
- Retries of the SAME `clientOrderId` produce the SAME `orderRef`
  (deterministic hash). No IBKR "duplicate ref" concern because
  the second submission is short-circuited by the DB `UNIQUE`
  index BEFORE reaching IBKR.
- **Collision detection is authoritative in Phase 2, not
  Phase 1.** `prepareBrokerOrderPlan` stays pure and does NOT
  read `broker_order_ref_map`. Collision on the derived
  `broker_order_ref` (astronomically unlikely, but a truncated
  hash can collide across a foreign `client_order_id`) is
  caught atomically by the `broker_order_ref_map` PRIMARY KEY
  inside Phase 2's transaction — `INSERT ... ON CONFLICT DO
  NOTHING RETURNING` with a row-count check. A collision ⇒
  `ROLLBACK` ⇒ `ORDER_REF_COLLISION`. No broker call, no
  partial persistence.

### Three-phase order-plan lifecycle (refactor)

Applies uniformly to fresh insert and orphan resume paths. There
is no way to skip a phase.

**Phase 1 — `prepareBrokerOrderPlan(ticket, ctx)` (pure).**
- Compute deterministic `parentOrderRef` + all child role
  ordinals + all child `orderRef`s.
- Compute planned broker order IDs via the existing sequencer.
- Return `OrderPlan = { parent, children[], refs[], planned
  brokerOrderIds[] }`.
- **NO DB reads. NO DB writes. NO broker calls.** Deterministic
  and side-effect free — trivially unit-testable.

**Phase 2 — `tryStartSubmissionWithPlan(plan, ctx)` (single tx,
same PoolClient acquiring the PR14 locks).**
Under `snap:<account_id>` → `hashtext(instrument)` in ONE
Postgres transaction:
- Run authoritative guards (PR14 exposure guard + reconciliation
  hold check per §6 decision matrix + kill-switch + env guard
  + duplicate check).
- INSERT the `proposed_orders` row with `status='PROPOSED'` if
  fresh, OR acquire the atomic submission marker on the existing
  row if resume.
- SET `execution_attempted_at = NOW()`.
- INSERT/UPSERT `broker_order_links` for the parent AND every
  child leg, `status='PLANNED'`, `account_id` set,
  `role_ordinal` set.
- INSERT `broker_order_ref_map` rows for every leg's `orderRef`
  as plain `INSERT ... ON CONFLICT DO NOTHING RETURNING
  broker_order_ref`. If the returning row count differs from the
  number of planned refs, a collision exists with an earlier
  `client_order_id` / `proposed_order_id` ⇒ `ROLLBACK` ⇒
  return `ORDER_REF_COLLISION`. This is the ONLY authoritative
  collision check; there is no read-before-write step in
  Phase 1 or Phase 2 that races.
- `COMMIT`.
Any failure ⇒ `ROLLBACK` ⇒ `SUBMISSION_PERSIST_FAILED` (or
`ORDER_REF_COLLISION` for the specific case above) returned to
the caller. `execution_attempted_at` NEVER survives a rollback;
no `broker_order_links` row remains; no `broker_order_ref_map`
row remains. Nothing was attempted → no hold created.

**Phase 3 — `placePreparedOrder(plan)` (broker only).**
Only reachable AFTER Phase 2 committed. `ib.placeOrder` calls
happen here in the same order as `plan.orders`. Callback
handlers (`orderStatus` / `openOrder` / `execDetails`) update
each `broker_order_links` row with `broker_order_id`, `perm_id`,
`parent_perm_id`, `status`, `observed_at`.

The `persist=false` legacy path is closed in PR15 (§4a).

## 4a. `EXECUTION_ALLOW_DIRECT_TICKET` / `persist=false` — closed

Rationale: a broker call that does not create a
`proposed_orders` row + `broker_order_links` + `broker_order_ref_map`
row cannot be reconciled — the runner has no way to identify the
resulting broker order, and the ambiguous-recovery path (§5)
cannot function.

Change in PR15:

- `POST /execution/execute-ticket` with `persist=false` is
  REJECTED with `400 direct_ticket_disallowed_in_pr15` (or
  `423 direct_ticket_disallowed_by_reconciliation_scope` — pick
  during implementation, doc'd in
  `RECONCILIATION_RUNTIME.md`).
- `EXECUTION_ALLOW_DIRECT_TICKET=true` still parses (backwards
  config compat) but flips ONE new behaviour: when set, `persist`
  is silently coerced to `true` and the request goes through
  the durable `prepareBrokerOrderPlan → tryStartSubmissionWithPlan
  → placePreparedOrder` flow. If `persist=false` is explicitly
  sent, the request is refused.
- Legacy direct-ticket alerts (`SAFETY:DIRECT_TICKET_USED`) are
  retained for observability; every coerced `persist=false→true`
  emits a distinct alert kind `direct_ticket_migrated`.

Migration for legacy callers is documented in
`docs/architecture/RECONCILIATION_RUNTIME.md`: update callers to
send `persist=true` explicitly; no other change required.

## 5. Ambiguous `PROPOSED` recovery

Semantics: an ambiguous row STAYS `PROPOSED` with
`execution_attempted_at IS NOT NULL`. There is **no new
`RECONCILIATION_REQUIRED` status**. Discoverability comes from
the active `reconciliation_hold` (reason=`unknown_submission` /
`orphan_broker_order` / `recovery_source_missing`) that the row
is associated with in the hold payload. The submission marker is
NEVER cleared and the row is NEVER auto-retried.

Runner loop after snapshot build:

1. Load `PROPOSED` rows with `execution_attempted_at IS NOT NULL`
   and no terminal marker.
2. **Positive match** on this priority chain (a single positive
   match from any covered source suffices — see §3 "Positive
   evidence"):
   a. `broker_order_ref` in `broker_order_ref_map` matched to a
      broker order in the snapshot.
   b. `perm_id` on any leg of `broker_order_links` matches a
      broker row.
   c. `broker_order_id` set locally AND appears in
      `openOrders`, `completedOrders`, or `executions`.
3. On a positive unique match →
   - Update `broker_order_links.status` for every leg observed.
   - Update `proposed_orders.status` per §9 transition table.
   - Any existing hold whose payload references this
     `proposed_order_id` is resolved (`auto_broker_match`) even
     if the hold's reason is `recovery_source_missing` — a
     positive match trumps a missing source.
   - **Never** clear `execution_attempted_at`.
4. On no positive match AND `recoveryComplete=true` → create hold
   `reason='unknown_submission'`. Row stays `PROPOSED` +
   `execution_attempted_at`. No retry.
5. On no positive match AND `recoveryComplete=false` but
   `exposureComplete=true` → create hold
   `reason='recovery_source_missing'` scoped to the ambiguous
   row's `identity_key`. That single instrument is blocked; the
   rest of the account keeps trading. Hold auto-resolves later
   if a `recoveryComplete=true` run finds a
   positive match; otherwise operator resolution (§6) is
   required.
6. On no match with `exposureComplete=false` → NO hold created;
   the run is already `INCOMPLETE` and the write path is globally
   fail-closed (§8).

Pre-`orderRef` legacy rows (no map entry, no `permId`, no
`broker_order_id`) are marked with hold `reason='unknown_submission'`
on the first complete-snapshot run that fails to match them, and
STAY that way until operator resolution (§6).

## 6. Reconciliation holds — server-side enforcement & lifecycle

### Enforcement

- The single authoritative check runs inside
  `tryStartSubmissionWithPlan` (§4) — same transaction, under
  the PR14 `snap:<account_id> → hashtext(instrument)` locks,
  BEFORE INSERT / marker / links / ref-map writes. There is no
  parallel `insertProposedFromTicket` /
  `tryStartSubmissionWithExposureGuard` code path — the older
  names are refactored out of existence by PR15 §4.
- `POST /execution/execute-ticket` with `persist=false` NEVER
  reaches this check — it is refused up-front (§4a). The
  authoritative guard therefore runs for every real broker
  submission by construction.
- Submission NEVER acquires `recon:<account_id>`. It reads
  `reconciliation_holds` and `reconciliation_runs` via a plain
  SELECT inside its transaction — the runner's writes to those
  tables are `COMMIT`-visible via the mutual `snap:<account_id>`
  serialisation (§7 Phase A / Phase C).
- Signal-engine trading-loop pre-check is a fast skip. NOT
  authoritative.

Write-path decision matrix (evaluated in order, first hit wins):

| Condition on latest run(s) for the current `session_id` | Outcome |
| ------------------------------------------------------- | ------- |
| A `status='RUNNING'` row exists for the current `session_id` | `RECONCILIATION_UNAVAILABLE` (`reconciliation_running`) |
| No completed run has ever finalised for this session | `RECONCILIATION_UNAVAILABLE` (`reconciliation_never_ran_in_session`) |
| Latest completed run's `session_id` differs from the current process | `RECONCILIATION_UNAVAILABLE` (`reconciliation_wrong_session`) — foreign-session runs are never trusted |
| Latest current-session run is `FAILED` | `RECONCILIATION_UNAVAILABLE` (`reconciliation_failed`) |
| Latest current-session run is `ABANDONED` | `RECONCILIATION_UNAVAILABLE` (`reconciliation_abandoned`) — the LATEST current-session `ABANDONED` blocks. Historical `ABANDONED` rows are ignored ONLY when a strictly newer valid current-session run (`CLEAN` / `MISMATCH` / `INCOMPLETE` with `exposureComplete=true`) has finalised on top of them |
| Latest completed current-session run has `source_coverage → exposureComplete=false` | `RECONCILIATION_UNAVAILABLE` (`reconciliation_incomplete_exposure`) — global block |
| Latest completed current-session run older than `EXECUTION_READY_RECONCILIATION_MAX_AGE_S` | `RECONCILIATION_STALE` — global block |
| Latest run `exposureComplete=true`, active hold matches `identity_key` | `RECONCILIATION_HOLD` — per-identity block |
| Latest run `exposureComplete=true`, no matching hold | pass through to PR14 exposure guard |

`INCOMPLETE` (whether from `recoveryComplete=false` alone or
from mixed source coverage) DOES NOT auto-trigger
`RECONCILIATION_UNAVAILABLE`. The gate only blocks globally when
`exposureComplete=false`. Runs with `INCOMPLETE` status but
`exposureComplete=true` and `recoveryComplete=false` pass the
global gate and rely on the per-identity
`recovery_source_missing` holds attached to ambiguous PROPOSED
rows for targeted blocking (§5).

### Lifecycle

Auto transitions (`active=true → active=false`):

1. **`auto_snapshot_clean`** — reason ∈ {`position_mismatch`}
   only. Requires the NEXT run for the same `session_id` to
   satisfy BOTH: `exposureComplete=true` AND expected/broker
   position diff for the SAME `identity_key` == 0. Sets
   `resolved_kind='auto_snapshot_clean'`, `resolved_by='system'`,
   `resolution_note` referencing the run id.
   `recoveryComplete` is IRRELEVANT for this transition — a
   position match is provable from `positions` alone (with
   `openOrders` proving nothing is in flight).
2. **`auto_broker_match`** — reason ∈ {`unknown_submission`,
   `recovery_source_missing`, `orphan_broker_order`}. Fires as
   soon as ANY subsequent run supplies a positive match per §5
   priority chain against a source that is complete for that
   evidence type:
     - `openOrders.available && boundedWindow` positive match
       → resolves the hold.
     - `executions.available && exposureWindowComplete`
       positive match → resolves the hold.
     - `completedOrders.available && boundedWindow` positive
       match → resolves the hold.
   `recoveryComplete` is NOT required and MUST NOT be checked
   at this transition — a positive match trumps a missing
   source. `recovery_source_missing` is therefore
   auto-resolvable by an `openOrders` or `executions` positive
   match even while `completedOrders` remains unsupported.

Manual transition: **`operator_resolve`** —
`POST /execution/reconciliation/holds/:id/resolve` requires:

- Bearer `EXECUTION_API_TOKEN` (identifies caller, audit only)
  AND
- Secondary header
  `X-Reconciliation-Resolve-Token: <EXECUTION_RECONCILIATION_RESOLVE_TOKEN>`.
  Unset in config ⇒ endpoint returns `403 resolve_disabled` and
  the hold stays permanently active by design.
- Body `{ disposition: <enum>, note: string, confirmation?: string }`.

Disposition enum (NO free-form dispositions):

| disposition | Meaning | Extra requirements | Side effects |
| ----------- | ------- | ------------------ | ------------ |
| `LINK_TO_BROKER_ORDER` | Operator asserts the PROPOSED row corresponds to a specific broker order and supplies `{ brokerOrderId, permId?, orderRef? }` in the payload. Runner verifies the identifiers against the most recent snapshot; refuses if the identifiers are unknown or already linked to a different `proposed_order_id`. | verified broker identifiers present in latest snapshot; `permId` if the broker returned any | `broker_order_links` insert/update with `role='PARENT'`; `proposed_orders.status` set per §9 table using the broker's status; hold flipped `active=false`, `resolved_kind='operator_resolve'`. No `placeOrder` call; no retry. |
| `CONFIRMED_NOT_SUBMITTED` | Operator asserts the broker never received the order. | Secondary token AND `confirmation === "CONFIRMED_NOT_SUBMITTED"` in the body (exact string); severity=`critical` audit + alert. | Atomic single-transaction terminal move of the `proposed_orders` row to `REJECTED` with `last_error='operator: confirmed not submitted'`; hold flipped resolved; **NEVER** clears `execution_attempted_at` (so future audits still see the ambiguous window); **NEVER** enqueues a retry. |
| `KEEP_BLOCKED` | Operator has decided the hold must persist (e.g. awaiting broker support ticket). | note required | Hold stays `active=true`; sets `acknowledged_at`, `acknowledged_by`, `acknowledge_note`, `resolution_intent='KEEP_BLOCKED'` in payload. No change to the PROPOSED row. Acts as a formal ack, not a resolve. |

Acknowledgement (`POST /holds/:id/acknowledge`) sets
`acknowledged_at` / `acknowledged_by` / `acknowledge_note` and
emits an alert, but **does NOT flip `active=false`** and does
NOT satisfy the resolve disposition contract. A bare `{ note }`
body on the resolve endpoint returns `400 disposition_required`.

Holds with `reason='unknown_submission'` NEVER auto-resolve — they
require either a positive broker match (`auto_broker_match`) or
explicit `LINK_TO_BROKER_ORDER` / `CONFIRMED_NOT_SUBMITTED`.
If the secondary resolve token is not
configured, the hold stays permanently active by design (safe
default).

## 7. Scheduler (execution-engine)

New module `apps/execution-engine/src/reconciliation/scheduler.ts`.
Env knobs (all to `.env.example`):

```
RECONCILIATION_LOOP_ENABLED=true                       # paper default
RECONCILIATION_INTERVAL_MS=60000
RECONCILIATION_STARTUP_DELAY_MS=2000
RECONCILIATION_MIN_INTERVAL_MS=15000                   # floor
RECONCILIATION_SOURCE_TIMEOUT_MS=8000
RECONCILIATION_RUN_TIMEOUT_MS=45000                    # per-tick hard cap
RECONCILIATION_EXECUTION_SAFETY_MARGIN_MS=300000       # 5 min
EXECUTION_RECONCILIATION_RESOLVE_TOKEN=                # empty → resolve endpoint 403
```

### Single staleness source of truth

The existing PR3 env var
**`EXECUTION_READY_RECONCILIATION_MAX_AGE_S`** is the ONLY
staleness knob. PR15 does NOT introduce a parallel
`RECONCILIATION_MAX_AGE_S`. Both `/ready` and the write-path
`RECONCILIATION_STALE` gate consult the same value. Any earlier
draft in this plan that mentions `RECONCILIATION_MAX_AGE_S` is
superseded and MUST be treated as a doc bug at implementation
time.

### Concurrency & lock semantics

Three independent Postgres advisory locks, each with a **specific
scope**. Nobody re-acquires anyone else's lock.

1. **`snap:<account_id>`** (PR14, existing).
   - Held by the position-snapshot refresher for the write path.
   - Held **briefly by the reconciliation runner** in TWO short
     transactions: (i) publish `status='RUNNING'` before broker
     reads; (ii) commit final status + holds after broker reads.
     Between those two, `snap:*` is released — broker reads must
     not hold any DB row lock.
2. **`recon:<account_id>`** (new, PR15).
   - **Session-scoped** `pg_try_advisory_lock`, held on a
     dedicated `PoolClient` for the ENTIRE lifetime of the run
     (Phase A → Phase B → Phase C below). Released with
     `pg_advisory_unlock` in `finally` on the same `PoolClient`.
     `pg_try_advisory_lock=false` ⇒ skip this tick.
   - Held **only by reconciliation runners** to serialise them
     across processes. Submission never touches this key.
     Snapshot refresh never touches this key.
3. **`hashtext(instrument)`** — the raw instrument-level lock
   the PR14 submission guard already uses. **NOT** renamed to
   `inst:`, **NOT** aliased. Untouched by PR15.

### Runner phase sequence (authoritative)

```
Phase A — RUNNING publication (dedicated PoolClient)
  1. clientA = pool.connect()
  2. pg_try_advisory_lock(hashtext('recon:' || accountId)) on clientA
     → false ⇒ release, skip tick
  3. BEGIN on clientA
  4. pg_advisory_xact_lock(hashtext('snap:' || accountId))
  5. Sweep abandoned RUNNING (§7 "Abandoned-RUNNING detection")
  6. INSERT reconciliation_runs (status='RUNNING', session_id=CURRENT)
  7. COMMIT                              ← snap: released, recon: retained

Phase B — broker reads (NO DB transaction, NO snap:, NO instrument locks)
  8. BrokerReconciliationAdapter.capture(abortSignal)
     with per-source bounded timeouts (§3)
  9. Result held only in memory

Phase C — publish result (dedicated PoolClient, same connection)
 10. BEGIN on clientA
 11. pg_advisory_xact_lock(hashtext('snap:' || accountId))
 12. UPDATE reconciliation_runs SET status=<final>, snapshot_captured_at=NOW(),
       source_coverage=..., report=... WHERE id=<Phase A row>;
 13. UPSERT reconciliation_holds (auto-resolve + new-hold rows);
       UPDATE broker_order_links / broker_order_ref_map for positive matches.
 14. COMMIT                              ← snap: released

Finally
 15. pg_advisory_unlock(hashtext('recon:' || accountId)) on clientA
 16. clientA.release()
```

Between Phase A COMMIT and Phase C COMMIT the write path reading
`reconciliation_runs` under `snap:<account_id>` observes
`status='RUNNING'` and returns `RECONCILIATION_UNAVAILABLE`.
This is the reconciliation_running gate. The write path never
acquires `recon:*`.

Timeout / ABANDONED finalisation happens in a THIRD short
transaction on the same `clientA` (still holding `recon:*`):

```
 T.  BEGIN on clientA
 T.  pg_advisory_xact_lock(hashtext('snap:' || accountId))
 T.  UPDATE reconciliation_runs
       SET status='ABANDONED', completed_at=NOW(),
           error='run_timeout' | 'orphaned RUNNING row from prior session'
       WHERE id = <run row> RETURNING ...
 T.  COMMIT
 T.  pg_advisory_unlock(hashtext('recon:' || accountId))
 T.  clientA.release()
```

There is **no** claim that broker reads share a DB transaction.
There is **no** long-running transaction in the runner.

### Lock protocol summary (corrected checklist)

```
Submission (existing PR14, unchanged):
  1. snap:<account_id>       (already acquired during snapshot refresh)
  2. hashtext(instrument)    (existing PR14 key)
  → SELECTs reconciliation_holds / reconciliation_runs
  → never acquires recon:<account_id>

Reconciliation runner:
  Session lock:    recon:<account_id>   (whole run, dedicated PoolClient)
  Publication tx:  snap:<account_id>    (briefly, Phase A + Phase C + timeout)

Snapshot refresh (existing PR14, unchanged):
  1. snap:<account_id>
```

There is NO `snap → recon → inst` chain and any such phrasing
from earlier revisions is superseded. Deadlock impossibility
holds because: submission and refresh never touch `recon:*`; the
runner never touches `hashtext(instrument)`; `snap:*` is always
acquired at the top of its holder's lock stack.

### Abandoned-RUNNING detection

Three sweep triggers, all safe under the same `recon:<account_id>`
lock:

1. Runner startup — flip any `status='RUNNING'` row whose
   `session_id` differs from the current process to `ABANDONED`
   (`error='orphaned RUNNING row from prior session'`).
2. Runner startup AND every tick — flip any `status='RUNNING'`
   row whose `started_at < NOW() - RECONCILIATION_RUN_TIMEOUT_MS`
   to `ABANDONED` (`error='exceeded run timeout'`), **including
   rows from the current `session_id`**. This covers a hung
   in-process run whose promise was already timed out but whose
   row was never finalised.
3. Runner's own timeout branch — when a tick exceeds
   `RECONCILIATION_RUN_TIMEOUT_MS`:
   - the `BrokerReconciliationAdapter` receives `abort()` on an
     `AbortSignal` passed into every source read;
   - every IB event listener registered for this run is
     `.removeListener`ed (documented per-source in the adapter);
   - any pending `Promise` is rejected with `AbortError`;
   - the run row is finalised `ABANDONED` + `error='run_timeout'`
     in the same `recon:<account_id>` transaction that started
     it, so a subsequent tick can proceed.

Readiness ignores foreign-session runs. The latest current-session
ABANDONED blocks readiness and the write path. A historical ABANDONED
is ignored only when superseded by a newer current-session CLEAN,
MISMATCH, or INCOMPLETE run with exposureComplete=true.

### Other contract items

- Non-overlapping via §Concurrency above; no backlog.
- Bounded per-tick timeout (`RECONCILIATION_RUN_TIMEOUT_MS`).
- On broker reconnect (`tws.on('connected')`): fire one immediate
  extra tick.
- Graceful shutdown: SIGINT/SIGTERM awaits the in-flight run.
- Never fire-and-forget without `.catch` + alert.

## 8. HTTP API & startup gating

```
GET  /execution/reconciliation/latest             # persisted state
GET  /execution/reconciliation/holds              # ?active=true|false
POST /execution/reconciliation/run                # trigger, Bearer + audit
POST /execution/reconciliation/holds/:id/acknowledge  # Bearer + audit; does NOT unblock
POST /execution/reconciliation/holds/:id/resolve      # requires resolve-token; Bearer + audit
```

- Reads (`latest`, `holds`) require Bearer + audit.
- `POST /run` requires Bearer + audit but is EXPLICITLY EXEMPT
  from the trading environment write guard so operators can run
  reconciliation on a fresh-boot / hold-blocked cluster to
  diagnose. The runner still refuses to run outside
  `IBKR_ENVIRONMENT=paper` (PR15 scope).
- `acknowledge` requires Bearer + audit; sets metadata only.
- `resolve` requires the SEPARATE
  `EXECUTION_RECONCILIATION_RESOLVE_TOKEN`; 403 if unset.

### Startup gating (single model, no OR)

The server **DOES** start `app.listen` for diagnostics —
`/health`, `/ready`, `/execution/reconciliation/*`, `/execution/alerts`
work immediately. Every exposure-INCREASING write endpoint
(`/execution/execute-ticket` with the coerced `persist=true`
flow of §4a — `persist=false` is refused, not "returns 503";
`/execution/orders` mutations; `/execution/close-position`;
`/runtime/execute` proxy target) returns **503** with reason
`reconciliation_never_ran_in_session` until the FIRST finalised
current-`session_id` run with `exposureComplete=true` lands —
regardless of its top-level `status`. Concretely, `CLEAN`,
`MISMATCH`, and `INCOMPLETE` (when `exposureComplete=true` and
only `recoveryComplete=false`) all satisfy the startup gate.
`recoveryComplete=false` runs pass the gate globally — only
the specific ambiguous instruments carrying a
`recovery_source_missing` hold return `RECONCILIATION_HOLD`
per-request. Reads are unaffected.

### Readiness (`/ready`) reason codes

Global 503 reasons (whole write path fail-closed):

- `reconciliation_never_ran_in_session`
- `reconciliation_running`
- `reconciliation_failed`
- `reconciliation_abandoned`
- `reconciliation_incomplete_exposure` (`exposureComplete=false`)
- `reconciliation_stale` — latest completed run older than
  `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`
- `reconciliation_wrong_session`

Per-instrument 503 reasons (rest of the account keeps trading):

- `reconciliation_incomplete_recovery` — associated with a
  `recovery_source_missing` hold on that identity
- `reconciliation_hold_active` — any other active hold on that
  identity

A run with `INCOMPLETE` status but `exposureComplete=true` and
`recoveryComplete=false` is NEVER a global 503. `/ready` returns 200 for the process
even while some instruments are individually blocked; per-request
guards do the rejection on write.

## 9. Trading loop consumption

`apps/signal-engine/src/runtime/trading-loop/`:
- New `reconciliation-reader.ts` (HTTP + Zod, mirroring
  `exposure-reader.ts` fail-closed contract).
- Loop consults it BEFORE `MarketDataRuntime.dryRun` for the given
  instrument. Active hold or unavailable/stale reconciliation →
  outcome `RECONCILIATION_HOLD` / `RECONCILIATION_UNAVAILABLE`, no
  pipeline call, no broker call.

### Conservative broker → local status transition table (§Recovery mapping)

Applied when reconciliation matches a broker row to a proposed row.
A single covered source with a positive match is sufficient — a
later missing source does not undo the transition. "Requires"
lists the MINIMAL coverage that must hold for the *positive*
transition; conclusions about NON-submission always require full
coverage (`recoveryComplete=true`).

| Broker signal | Minimum coverage for this transition | Local `proposed_orders.status` transition |
| ------------- | ------------------------------------ | ----------------------------------------- |
| `openOrders` status `Submitted`/`PreSubmitted`, positive ref/perm/broker-order-id match | `openOrders.available && boundedWindow` | `PROPOSED → SUBMITTED`; keep `execution_attempted_at` |
| Partial fill (`filled > 0 && remaining > 0`) via `execDetails`, positive match | `executions.available && exposureWindowComplete` | `PROPOSED → SUBMITTED` (do NOT FILL on partial) |
| `executions` full-quantity fill (`sum(shares) >= quantity`), positive match | `executions.available && exposureWindowComplete` | `→ FILLED` |
| `completedOrders` status `Filled` with `remaining=0`, positive match | `completedOrders.available && boundedWindow` | `→ FILLED` |
| `completedOrders` status `Cancelled` unambiguous, positive match | `completedOrders.available && boundedWindow` | `→ CANCELLED` |
| `completedOrders` status `ApiCancelled` / `Inactive` unambiguous, positive match | `completedOrders.available && boundedWindow` | `→ REJECTED` |
| Position diff = 0 for identity | `exposureComplete=true` | (no `proposed_orders` transition) `position_mismatch` hold on this identity is auto-resolved (`auto_snapshot_clean`) |
| Position diff ≠ 0 | `exposureComplete=true` | `position_mismatch` hold created on the affected identity |
| Ambiguous PROPOSED, positive match found in any covered source | as above per row | transition per matching source; ALL associated holds (`unknown_submission`, `recovery_source_missing`, `orphan_broker_order` pointing at this `proposed_order_id`) resolved `auto_broker_match` |
| Ambiguous PROPOSED, no positive match, `recoveryComplete=true` | — | no transition; hold `unknown_submission` |
| Ambiguous PROPOSED, no positive match, `exposureComplete=true` && `recoveryComplete=false` | — | no transition; hold `recovery_source_missing` scoped to identity |
| Ambiguous PROPOSED, `exposureComplete=false` | — | no transition, no hold (global write gate already fails closed) |

## 10. Tests

### Unit
- `broker-adapter.test.ts` — happy path with all sources;
  per-source timeout; `completedOrders=unsupported` → adapter
  reports `sourceCoverage.completedOrders.available=false,
  reason='unsupported_by_ib_module'`, `exposureComplete=true`,
  `recoveryComplete=false`; older ambiguous
  `execution_attempted_at` past broker retention →
  `sourceCoverage.executions.window.recoveryWindowComplete=false`
  and `exposureWindowComplete=true`, `exposureComplete=true`,
  `recoveryComplete=false`, affected instruments only
  (regression: the generic `SourceCoverage.boundedWindow` field
  is asserted NEVER to be consulted for executions decisions);
  missing `positionEnd` → `exposureComplete=false`;
  classification: `MANUAL` requires the explicit broker GUI
  signal — a blank `orderRef` + `clientId=0` WITHOUT it stays
  `UNKNOWN` (regression test); spoofed foreign `orderRef` with
  our `clientId` → `EXTERNAL_API`.
- `order-ref.test.ts` — deterministic `co-<hash12>` derivation;
  parent + TP1/TP2/SL leg suffixes; length bound (≤20 chars);
  never contains the raw `clientOrderId`.
- `identity.test.ts` — canonical `identity_key` for conid path,
  fallback path, empty-field normalisation; two identical-symbol
  futures on different exchanges produce different keys;
  missing-account fills → `identity_ambiguous`.
- `runner.test.ts` — matcher wired through `broker_order_ref_map`
  + `broker_order_links`; parent + all bracket children matched
  in one run; positive match in `openOrders` alone (even with
  `completedOrders` unsupported) transitions to `SUBMITTED` and
  auto-resolves `unknown_submission` / `recovery_source_missing`
  holds on that `proposed_order_id`; positive `executions`
  full-quantity match → `FILLED`; partial fill → `SUBMITTED`;
  no match on `recoveryComplete=true` snapshot →
  `unknown_submission` hold, PROPOSED row untouched,
  `execution_attempted_at` preserved; no match on
  `recoveryComplete=false` but `exposureComplete=true` →
  `recovery_source_missing` hold scoped to the ambiguous row's
  `identity_key` only, other instruments keep trading; no match
  on `exposureComplete=false` → no hold, status INCOMPLETE, no
  auto-retry; legacy pre-ref row → hold, no auto-clear, no
  auto-retry; orphan broker order tagged MANUAL/EXTERNAL/UNKNOWN
  → `orphan_broker_order` hold, NEVER auto-cancels;
  `position_mismatch` auto-resolves under `exposureComplete=true`
  regardless of `recoveryComplete`.
- `execution-window.test.ts` — runner computes
  `exposureStart = sessionStart - safetyMargin` and
  `recoveryStart = min(exposureStart, oldest ambiguous
  execution_attempted_at) - safetyMargin`; broker refuses
  `recoveryStart` → `recoveryWindowComplete=false`,
  `exposureWindowComplete=true`, `exposureComplete=true`,
  `recoveryComplete=false`; per-instrument hold created.
- `order-plan-lifecycle.test.ts` — `prepareBrokerOrderPlan`
  returns a plan with parent + children + refs + planned order
  IDs and performs **ZERO DB reads**, ZERO DB writes, ZERO
  broker calls (assert via an injected `Pool` that throws on
  any call and a broker spy);
  `tryStartSubmissionWithPlan` under the PR14 locks in one tx
  writes `execution_attempted_at`, `broker_order_links` (all
  legs, `status='PLANNED'`, `account_id` set),
  `broker_order_ref_map` (every ref) — and commits atomically;
  `placePreparedOrder` is only invoked after commit; ROLLBACK
  variant with a Postgres error on the `broker_order_links`
  insert leaves NO row in any of the four tables and returns
  `SUBMISSION_PERSIST_FAILED` — zero `placeOrder` calls; the
  same lifecycle exercised for fresh insert AND orphan resume;
  crash between commit and first `placeOrder` leaves the plan
  recoverable on the next reconciliation tick.
- `order-ref-collision.test.ts` — pre-seed `broker_order_ref_map`
  with a row bound to a DIFFERENT `client_order_id` /
  `proposed_order_id`, then submit a ticket whose derived
  `co-<hash12>` collides. `prepareBrokerOrderPlan` stays pure
  and returns the plan unchanged. `tryStartSubmissionWithPlan`
  begins its tx, INSERTs the `proposed_orders` row + links, and
  the `INSERT INTO broker_order_ref_map ... ON CONFLICT DO
  NOTHING RETURNING broker_order_ref` returns fewer rows than
  planned → the code rolls the tx back and returns
  `ORDER_REF_COLLISION`. Verify: no `proposed_orders` row
  survives, no leg row survives, no ref-map row for the new
  client-order-id survives, zero `placeOrder` calls; the
  pre-seeded row is UNAFFECTED.
- `persist=false-blocked.test.ts` — `POST /execution/execute-ticket`
  with `persist=false` returns the refuse status regardless of
  `EXECUTION_ALLOW_DIRECT_TICKET`; when `EXECUTION_ALLOW_DIRECT_TICKET=true`
  and the request body omits `persist`, `persist=true` is
  coerced and the durable Phase 1-2-3 flow runs; alert
  `direct_ticket_migrated` recorded.
- `holds-lifecycle.test.ts` — `auto_snapshot_clean` resolves
  `position_mismatch` under `exposureComplete=true` + zero diff
  even when `recoveryComplete=false` (regression: the code path
  MUST NOT check `recoveryComplete`); `auto_broker_match`
  resolves `recovery_source_missing` when an `openOrders`
  positive match arrives (still `recoveryComplete=false`) —
  proving positive evidence trumps missing source; NEVER
  resolves `unknown_submission` without a positive match; acknowledge does NOT flip
  `active=false`; resolve with body `{ note }` and no
  disposition → `400 disposition_required`; resolve without
  the secondary token → `403 resolve_disabled`; disposition
  `LINK_TO_BROKER_ORDER` with unknown broker identifiers →
  refused; with valid identifiers → `broker_order_links`
  upserted, status per §9, hold resolved, no `placeOrder`;
  disposition `CONFIRMED_NOT_SUBMITTED` without the exact
  confirmation string → refused; with correct token +
  confirmation → atomic terminal move to REJECTED,
  `execution_attempted_at` NOT cleared, no retry; disposition
  `KEEP_BLOCKED` → hold stays active,
  `resolution_intent='KEEP_BLOCKED'` in payload; no resolve
  token configured → 403, hold stays permanently active.
- `scheduler.test.ts` — process-level mutex drops overlapping
  tick; session-scoped `pg_try_advisory_lock('recon:<acct>')`
  on a dedicated `PoolClient` released in `finally` on the SAME
  connection (leak test); Phase A commits `RUNNING` before
  broker reads begin; Phase C commits final status; timeout
  ABANDONED committed in a THIRD short tx on the same
  connection; abandoned RUNNING from prior session flipped to
  ABANDONED at startup; abandoned RUNNING from CURRENT session
  exceeding `RECONCILIATION_RUN_TIMEOUT_MS` also flipped to
  ABANDONED; timeout branch invokes `abort()` on the injected
  `AbortSignal`, verifies every registered IB event listener
  is `.removeListener`ed and every pending promise settles;
  reconnect fires one immediate extra tick; shutdown awaits
  in-flight.
- `readiness.test.ts` — `exposureComplete=true` +
  `recoveryComplete=false` returns `/ready` 200 for the process
  and the write gate returns `RECONCILIATION_HOLD` only for
  identities carrying a `recovery_source_missing` hold; a second
  instrument without a hold passes;
  `exposureComplete=false` returns global 503
  `reconciliation_incomplete_exposure`; `RUNNING` → 503
  `reconciliation_running`; latest current-session `ABANDONED`
  → 503 `reconciliation_abandoned` (historical `ABANDONED`
  followed by a newer `CLEAN` → 200); latest completed run
  from a foreign `session_id` → 503
  `reconciliation_wrong_session` regardless of its status;
  stale (older than `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`)
  → 503 `reconciliation_stale`.
- `reconciliation-reader.test.ts` (signal-engine) — Zod schema
  boundary; stale → `RECONCILIATION_STALE`; transport error →
  `RECONCILIATION_UNAVAILABLE`; active hold for a different
  instrument does NOT block others.

### PostgreSQL integration (gated on `TEST_POSTGRES_URL`)
- Migration 000003 on fresh DB / 001-only DB / post-PR14 DB;
  existing `proposed_orders`, `broker_execution_fills`,
  `broker_position_snapshots`, `broker_snapshot_syncs` rows
  preserved.
- Server-side hold enforcement blocks
  `/execution/execute-ticket` (all persist values through the
  §4a coercion) via `tryStartSubmissionWithPlan` — verified with
  real Postgres + two concurrent submissions.
- **`persist_before_place_order.pg-integration.test.ts`** —
  under a real PG connection, force a `broker_order_links`
  INSERT error mid-Phase-2 via an injected constraint
  violation → transaction rolls back; `proposed_orders` row
  either does not exist (fresh) or has NO
  `execution_attempted_at` marker (resume); no
  `broker_order_ref_map` rows; no holds created; zero
  `placeOrder` calls by the injected fake broker;
  submission response `SUBMISSION_PERSIST_FAILED`.
- **`reconciliation_finalize_vs_submit.pg-integration.test.ts`** —
  real PG race using the three-phase runner protocol against a
  concurrent submission:
    (i) runner has committed Phase A `RUNNING` but not Phase C
        → submission observes `RECONCILIATION_UNAVAILABLE`
        (RUNNING);
   (ii) runner Phase C commits a `MISMATCH` with a hold on the
        identity BEFORE submission acquires `snap:<account>` →
        submission observes the hold and returns
        `RECONCILIATION_HOLD`;
  (iii) submission acquires `snap:<account>` BEFORE runner
        Phase C → submission completes; runner Phase C then
        commits without breaking invariants (submission was on
        pre-run state, next run reconciles the new row).
  Zero `placeOrder` on the losing submission in (i) and (ii).
- **`recon_lock_isolation.pg-integration.test.ts`** — two
  processes attempt `pg_try_advisory_lock('recon:<acct>')` on
  distinct `PoolClient`s — exactly one wins; the winner holds
  the lock across Phases A/B/C; the loser skips the tick; on
  winner crash simulated by `clientA.release()` the loser
  acquires on the next tick.
- Restart recovery: seed `reconciliation_runs` (CLEAN) + active
  holds + `broker_order_links` + `broker_order_ref_map`, restart
  pool, verify `getLatestReconciliation` + `listActiveHolds`
  return the persisted state, and a positive-match resolve
  discovers the persisted `broker_order_links`.
- Session isolation: a CLEAN run under a foreign `session_id`
  does NOT satisfy readiness or the write-path gate.
- Abandoned-RUNNING sweeps: (a) seed a RUNNING row with foreign
  session, runner boot flips it to ABANDONED atomically;
  (b) seed a RUNNING row with CURRENT session and
  `started_at = NOW() - 10 * RECONCILIATION_RUN_TIMEOUT_MS`,
  runner tick flips it to ABANDONED with
  `error='run_timeout'` and starts a fresh run.
- End-to-end with fake broker adapter: one instrument held,
  another passes; parent + 2 TP + 1 SL bracket all reconciled
  via `broker_order_links` in one run; positive match in
  `openOrders` alone (completedOrders unsupported) still
  transitions to SUBMITTED and resolves the associated
  `recovery_source_missing` hold.

### Explicitly NOT tested here
- Real IBKR paper — gated by `RUN_IBKR_PAPER_TESTS=true`, never
  in PR15 default CI, never submits a paper order.

## 11. Docs

- New `docs/architecture/RECONCILIATION_RUNTIME.md` — source of
  truth matrix, canonical identity, orderRef derivation, bracket
  linkage via `broker_order_links`, ambiguous-PROPOSED recovery,
  scheduler + unified lock order, hold lifecycle (auto vs
  operator resolve, secondary token, acknowledge ≠ resolve),
  broker coverage classification (`BOT_OWNED` / `MANUAL` /
  `EXTERNAL_API` / `UNKNOWN`), conservative transition table,
  restart/reconnect, fail-closed matrix, operator review flow.
- Update `PHASE_2_ROADMAP.md` PR15 entry — mark implemented,
  cross-link.
- Append §Reconciliation to `STATE_AND_RECONCILIATION.md`
  including the lock-order rule.
- Append §Reconciliation holds & operator resolution to
  `FAILURE_AND_RECOVERY.md`.
- `.env.example` — eight new keys documented (§7).

## File map (new)

```
apps/execution-engine/src/reconciliation/
  broker-adapter.ts
  broker-adapter.test.ts
  fake-broker-adapter.ts
  identity.ts
  identity.test.ts
  order-ref.ts
  order-ref.test.ts
  runner.ts
  runner.test.ts
  runner.pg-integration.test.ts
  scheduler.ts
  scheduler.test.ts
  holds-repository.ts
  holds-repository.pg-integration.test.ts
  routes.ts
  routes.test.ts

apps/signal-engine/src/runtime/trading-loop/
  reconciliation-reader.ts
  reconciliation-reader.test.ts

infra/sql/migrations/000003_reconciliation.sql

docs/architecture/RECONCILIATION_RUNTIME.md
docs/implementation/phase2/PR15_PLAN.md   (this file)
docs/implementation/phase2/PR15_REPORT.md (on completion)
```

## File map (modified)

- `apps/execution-engine/src/repository.ts` — expected positions
  emit canonical `identity_key`; hold-lookup + creation under the
  unified lock order; new repo methods for `reconciliation_runs`,
  `reconciliation_holds`, `broker_order_links`, and
  `broker_order_ref_map`. No new columns on `proposed_orders`
  (superseded by `broker_order_links`).
- `apps/execution-engine/src/tws-execution-client.ts` — deterministic
  `co-<hash12>` `orderRef` on parent + role-suffixed refs on
  children; persist every ref via `broker_order_ref_map`; capture
  `permId` per leg via `openOrder` / `orderStatus` and persist to
  `broker_order_links`.
- `apps/execution-engine/src/index.ts` — replace `runReconciliation`
  body with delegate to the new runner; wire scheduler into
  `main()`; new routes; startup gating on write endpoints only.
- `apps/execution-engine/src/readiness.ts` — new reason codes
  (§8 Readiness).
- `apps/execution-engine/src/config.ts` — eight new env keys
  (§7 block), including
  `EXECUTION_RECONCILIATION_RESOLVE_TOKEN`.
- `apps/signal-engine/src/runtime/trading-loop/{exposure-reader,trading-loop-service}.ts`
  — reconciliation pre-check that skips the affected instrument
  only when the snapshot is COMPLETE + hold is targeted.
- `.env.example`, `README.md` (link doc).

## Verification checklist

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `TEST_POSTGRES_URL=... pnpm test:integration`
- [ ] `pnpm build`
- [ ] `git diff --check` clean
- [ ] No auto-retry, auto-cancel, or auto-close.
- [ ] `persist=false` is refused for broker submission; every
      broker call has a corresponding durable
      `proposed_orders` row + `broker_order_links` +
      `broker_order_ref_map` entry committed BEFORE
      `placeOrder` (integration-tested, §Tests).
- [ ] All new mutating routes require Bearer + audit;
      `resolve` additionally requires
      `EXECUTION_RECONCILIATION_RESOLVE_TOKEN`.
- [ ] Latest reconciliation + active holds + `broker_order_links`
      + `broker_order_ref_map` survive execution-engine restart
      (integration-tested).
- [ ] Deterministic `orderRef` never contains the raw
      `clientOrderId` (unit-tested, length ≤ 20 chars); collision
      against a foreign `client_order_id` returns
      `ORDER_REF_COLLISION` before any broker call.
- [ ] Bracket parent + children discovered in a single run via
      `broker_order_links` (integration-tested).
- [ ] Lock protocol: submission holds
      `snap:<acct> → hashtext(instrument)`; runner holds
      session-scoped `recon:<acct>` on a dedicated `PoolClient`
      with `snap:<acct>` only in Phase A + Phase C + timeout
      transactions; submission NEVER acquires `recon:*` (static
      + runtime test).
- [ ] Abandoned-RUNNING sweep flips prior-session AND
      current-session-over-timeout rows.
- [ ] Positive `openOrders`/`executions` match transitions
      status and resolves holds even with `completedOrders`
      unsupported.
- [ ] Global `/ready` = 200 while `exposureComplete=true` and
      `recoveryComplete=false`; per-instrument write returns 503
      only for the affected identity.
- [ ] Single staleness knob: `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`.
      No `RECONCILIATION_MAX_AGE_S` in code or config.

## Risks / open questions (revision 5 — reviewer sign-off needed)

1. Bracket children with distinct `orderRef` suffixes — confirm
   IBKR accepts a 20-char ref containing an ASCII hyphen and
   ASCII alphanum only, on both `placeOrder` parent + attached
   children.
2. `ib@0.2.9` DOES NOT expose `reqCompletedOrders`. The
   `exposureComplete` / `recoveryComplete` split handles this
   permanently; confirm the plan's decision to keep the account
   trading on `exposureComplete=true` alone is acceptable.
3. `EXECUTION_RECONCILIATION_RESOLVE_TOKEN` — new secondary
   secret. Confirm the token model (single value read by
   execution-engine only; operator-only) versus reusing an
   auth-service model. Plan keeps it a single value.
4. `persist=false` refuse vs. silent coerce (§4a) — plan
   refuses explicit `persist=false` and coerces only when the
   caller omits `persist` under `EXECUTION_ALLOW_DIRECT_TICKET=true`.
   Confirm this default is acceptable (alternative: refuse
   always, force callers to update).
5. Legacy PROPOSED rows that pre-date `broker_order_links`
   (there should be none in paper, but Postgres data from
   pre-PR15 dev may exist) — the runner treats them as
   ambiguous and creates `unknown_submission` holds on the first
   `recoveryComplete=true` run. Confirm this is the desired
   migration behaviour; operator can `LINK_TO_BROKER_ORDER` or
   `CONFIRMED_NOT_SUBMITTED` to clear.

---

**STOP.** Awaiting approval before implementation begins.


