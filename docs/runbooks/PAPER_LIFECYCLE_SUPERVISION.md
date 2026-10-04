# PP5 Paper lifecycle supervision

This is the configuration and recovery contract for the
[PP5 implementation](../implementation/phase3/PP5_IMPLEMENTATION_PLAN.md).
It does not authorize deploying these settings, Paper entries, notification probes
or broker actions. PP4 source coverage and PP7 broker acceptance remain separate.
One whole long stock share, original ownership and deterministic close risk remain
the only supported close scope. No new entry AI approval is needed for closing.

## Permission migration

| Setting | Default | Meaning |
| --- | --- | --- |
| `TRADING_ENABLED` | `false` | Existing master switch. Both entry and full-close writes require true. Authenticated cancel/reconciliation exemptions remain. |
| `EXECUTION_ENTRIES_PAUSED` | `true` | Separate startup ceiling on entries. It does not disable owned-position management. |
| Durable account pause | `true` on adoption | Survives process restart. Setting the startup ceiling false never clears this pause. |
| `EXECUTION_LIFECYCLE_AUTOMATION_ENABLED` | `false` | Enables automatic deadline close only after explicit configuration and master/account/risk checks. Observation remains active without it. |
| `EXECUTION_EXIT_BEFORE_CLOSE_MINUTES` | `15`, allowed15..60 | Exit deadline relative to the original verified instrument session. Pinned before entry dispatch; later settings cannot postpone it. |
| `EXECUTION_LIFECYCLE_ADOPT_EXISTING` | `false` | Explicit recovery-policy adoption for older owned entries without a PP5 policy. Requires master=false and entries paused. |

During an authorized rollout, first stop new entries and disable master writes,
preserving broker protection. Apply migrations22–24 and start the reviewed image.
First account-control adoption refuses master=true. Inspect the original ownership
and immutable configuration before enabling automatic management. Missing policy on
older ownership is a visible hold, not a guessed historical deadline. Explicit
disabled adoption needs a fresh verified schedule covering the original attempt;
it records a new recovery policy and cannot invent an unavailable original session.
Turn adoption off on the later compatible startup that enables management.

To pause entries while retaining supported automatic close, keep master=true and
use the durable pause (or startup entry ceiling). Master=false still blocks full
close; it does not close positions or cancel broker protection. Configuration
examples retain writes off, entries paused and automatic close off.

## Authenticated control and observation

All endpoints use the existing execution Bearer authentication and audit. Pause
and observation-only reconciliation additionally require a known allowed account
even when master writes are disabled. No browser secret or new UI control is added.

| Endpoint | Purpose |
| --- | --- |
| `GET /execution/entry-control` | Configured pause, durable state, revision and audit history |
| `POST /execution/entry-control/pause` | Body `{"reason":"operator reason"}`; blocks subsequent entry sends without changing broker orders |
| `POST /execution/entry-control/resume` | Same body; requires master, startup ceiling off, automatic lifecycle, fresh broker/observer state, confirmed alert transport and existing configuration/research checks |
| `GET /execution/lifecycle/supervision` | Observer health, pinned policy, lifecycle observations, active faults, delivery attempts and provider acknowledgement |
| `POST /execution/lifecycle/:id/close` | Existing audited one-share close with UUID requestId and limitPrice; master/risk/ownership checks still apply |
| `POST /execution/lifecycle/:id/close/reconcile` | Existing observation-only diagnostic; the background observer invokes this service automatically |

Resume never resets attempts, acknowledges a broker action, clears a close
reservation or overrides a research/risk failure. Entry dispatch and pause share
the account lock. A send which already happened before pause won the lock remains
an existing broker action; pause is not cancellation.

## Normal operation and deadlines

The observer starts immediately and ticks every5s, with nonoverlapping work and a
database account lock across processes. It discovers durable attempted ownership
and close operations, resolves original configuration even after assignment removal,
and refreshes IBKR positions/reconciliation. Protection requires exact owned TP/SL
shape and typed evidence, not a local declaration. Terminal completion requires
independent broker flat/no-working-order evidence; fees may remain accounting-pending.

The exit session comes from exact instrument calendar identity and broker UTC
intervals. Early closes and DST follow that evidence. Entry and final dispatch are
denied at the pinned exit deadline. Expiring the entry window does not close a
position. At deadline, the enabled supervisor obtains a current validated bid and
uses the existing full-close service. It cancels pending parent/protective orders,
rechecks current quantity and only dispatches SELL for exactly one owned share.
TP/SL winning a race suppresses a redundant SELL. A cancel-only zero-fill completion
requires positive terminal proof for all three original legs.

Original request/attempt markers survive restart. Existing close work is observed,
never blindly repeated. Normal observation and completion require no manual API
polling. Shutdown drains work and leaves broker protection in place.

## Faults and escalation

An intentional protective-cancellation interval is bounded. Errors/unknown outcomes
escalate immediately; slow closing and stale observation are watched independently
of a blocked close promise. Critical local status is generated within15s of an
observed fault. Delivery state is observable within60s when storage/transport are
available. These are supervision targets, not exchange-fill guarantees.

Failed/unknown cancellation, rejected or unfilled LMT close, absent independent
evidence, competing foreign orders, wrong quantity/type, stale/disconnected feeds,
or a missed session deadline retain a durable hold and account reservation. No
automatic cancel/replace/reprotection is implemented. A timeout never proves
cancellation. A close dispatch marker, including a crash before acknowledgement,
is never retried. A crash after automatic intent but before close-operation creation
also remains a visible hold. Subsequent writes require a separately supported,
audited deterministic recovery capability or an authorized owner-operated IBKR
action; a new request UUID is not an escape hatch.

After manual broker intervention, verify current position, outstanding orders,
typed executions and reconciliation through the supported observation flow. Do not
delete local rows or clear safety counters to simulate flat state. If independent
proof stays unavailable, entries stay paused and escalate to the owner.

Faults deduplicate by account/original ownership/code. Fresh exact broker evidence
resolves the active episode; recurrence creates a new one. Delivery or human
acknowledgement is not proof that a safety fault is resolved. Immutable terminal
proofs retain their original IDs/economic fingerprints; later legitimate ownership
does not invalidate old completion, but corrections or old working legs do.

Existing Telegram credentials configure the transport. Each process gets one
durable transport-check message; until confirmed, readiness is UNVERIFIED. This
check is sent only when the configured service is actually started, not by tests.
Provider `ok:true` plus message ID establishes provider acknowledgement, not human
receipt. PENDING/SENDING/FAILED/UNKNOWN/DISABLED remain distinct. There are at most
three charged notification attempts per episode, with5s/15s retry delays and a5s
request deadline. An ambiguous notification can duplicate; broker writes cannot.
Failed/unknown/exhausted critical delivery blocks unattended admission while
supported close/reconciliation continues. No real recipients are used by tests.

During a database outage durable persistence cannot be promised: process-local
critical status/logging and entry denial apply until audit storage recovers. A
restart rebuilds work from DB plus IBKR, never from cached healthy status.

## Rollback

Keep ownership, attempts, original policy, close markers and fault/delivery history.
Do not deploy an old writer that ignores the durable pause or new lifecycle state.
Keep master disabled until a compatible reviewed version can manage existing
ownership. PP5 does not enable the PP7 repeated-entry policy, perform a Paper soak,
prove provider/broker readiness, or change Live authorization.
