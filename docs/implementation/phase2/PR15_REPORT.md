# PR15 — Durable Reconciliation & Recovery — REPORT (r7)

Seventh revision unifies the production submission pipeline
behind a single `SubmissionApplicationService`. Both
`/execution/execute-ticket` and `/execution/execute-proposed/:id`
delegate to the very same module the r7 PostgreSQL integration
suite exercises. See [`PR15_PLAN.md`](./PR15_PLAN.md).

## Delivered — r7

- **Single production submission service.**
  `apps/execution-engine/src/reconciliation/submission-service.ts`
  is now the ONLY code path for broker submission. `index.ts`
  builds ONE instance during startup, wired with the real
  `TwsExecutionClient.prepareBrokerOrderPlan` /
  `dispatchPreparedOrder`, the real `ExecutionRepository`,
  `ensureBrokerSession`, `alerts.record`,
  `reconScheduler.triggerNow`, `assertKillSwitchOk`,
  `EXECUTION_PROCESS_OWNER_ID`, and server-side policies. The
  parallel r6 helpers (`prepareThreePhase`,
  `claimAndPersistThreePhase`, `dispatchAndMarkThreePhase`,
  outer `executePersistedOrder`) are DELETED. So is the
  unused `execute-ticket-orchestrator.*`.
- **Neutral broker port.** The service takes a
  `BrokerOrderDispatcher` port (`dispatch(BrokerDispatchPayload)`);
  production plugs in `TwsExecutionClient.dispatchPreparedOrder`
  behind it, tests inject a spy. No `FakeBroker*` types remain
  in production code.
- **Atomic identity binding.**
  `PlanPersistenceInput` now requires non-null `clientOrderId`,
  `clientOrderHash`, `instrument`, and explicit `conid`. Inside
  the same Phase B tx (after locks + guards) the repo
  `SELECT ... FOR UPDATE`s the `proposed_orders` row and refuses
  with `submission_identity_mismatch` on any deviation of `id`,
  `client_order_id`, `client_order_hash`, `instrument`, or
  `conid`. A row that is no longer PROPOSED / marker set /
  broker_order_id present returns `not_claimed`. Plan persistence
  is now UNCONDITIONAL — the pre-tx shape checks guarantee a
  non-empty legs array + non-empty ids.
- **Server-side hash re-verification on resume.**
  `executeProposed` fetches `client_order_id` + `client_order_hash`
  via the new `getExecutableProposedById`, recomputes
  `computeClientOrderHash` from the persisted row's fields, and
  refuses with `client_order_hash_mismatch` on divergence. No
  marker, no plan, no broker call.
- **REJECTED is immutable.** `overrideRejected=true` no longer
  attempts to reactivate the old row — it returns
  `REJECTED_ORDER_IMMUTABLE` (409). Operators must create a new
  proposal with a fresh `clientOrderId`.
- **HTTP handlers are pure adapters.** `sendSubmissionOutcome`
  maps the discriminated union to the documented HTTP contracts
  (`ACTIVE_INTENT_EXISTS`, `OPEN_POSITION_EXISTS`,
  `POSITION_STATE_UNAVAILABLE`, `RECONCILIATION_*`,
  `DUPLICATE_*`, `PENDING_CLAIMED`, `SUBMITTED`, `RESUMED`,
  new `SUBMISSION_IDENTITY_MISMATCH`,
  `CLIENT_ORDER_HASH_MISMATCH`, `MARKET_ORDER_NOT_ALLOWED`,
  `IDEMPOTENCY_IDENTITY_MISSING`,
  `LEGACY_IDEMPOTENCY_IDENTITY_MISSING`,
  `REJECTED_ORDER_IMMUTABLE`).
- **Signal-engine hash unified.** The legacy
  `apps/signal-engine/src/runtime/execution/client-order-hash.*`
  is deleted; every production import now targets
  `@ikbr/shared/client-order-hash`.

## Verification

```
$ pnpm typecheck                        # 7 projects OK
$ pnpm test                             # 788 pass, 0 fail, 0 skipped
$ TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/ikbr_trader \
    pnpm --filter execution-engine test # 322 pass, 0 fail, 0 skipped
$ pnpm lint                             # 0 errors
$ pnpm build                            # OK
$ git diff --check                      # clean
```

New PG integration tests
(`three-phase-r7.pg-integration.test.ts`) exercise the real
production `SubmissionApplicationService` module (§7 wiring
proof + scenarios A–H).

## Broker-dispatch call sites (hostile review)

- `apps/execution-engine/src/tws-execution-client.ts:749` —
  `this.ib.placeOrder(...)` — sole IBKR broker call.
- `apps/execution-engine/src/tws-execution-client.ts:593` —
  `dispatchPreparedOrder` — wraps `placeOrder`.
- `apps/execution-engine/src/index.ts:878` — production
  `SubmissionApplicationService` deps.dispatcher wires
  `tws.dispatchPreparedOrder(prepared)`.
- `apps/execution-engine/src/reconciliation/submission-service.ts:294`
  — sole caller of `tryStartSubmissionWithPlan`.

Marker + full plan commit atomically; identity binding refuses
any mismatch. No alternate execution paths remain.

## Remaining blockers

Brak.

Not committed. Ready for review.
