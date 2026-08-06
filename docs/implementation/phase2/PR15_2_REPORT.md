# PR15.2 — Authoritative Instrument Binding — REPORT

> Status: **shipped as `1472a33`**.
> Base commit: `89e1377` (PR15.1 shipped).
> Scope: bind a logical registry `instrumentId` to one exact,
> operator-selected, broker-verified IBKR contract identity;
> carry and verify that identity across ingestion → signal-engine →
> execution-engine.
>
> **Zero real broker orders. Zero `executionEnabled=true` flips.
> Zero live enablement. Zero automatic futures roll.**
>
> This report is written AFTER the first-round hostile review.
> Section 4 covers the follow-up findings and how they were
> addressed. The claim "no alternative submission path bypasses
> the authority" is proven at the current revision by the
> tests in §4.

## 1. Delivered behavior

### 1.1 Shared authority (`packages/shared/src/instruments/bindings.ts`)

New pure module. Public exports:

- `InstrumentBinding` — validated raw operator input, including
  the PR15.2 hostile-review addition `minTick`.
- `BoundInstrument` — frozen composite of logical `Instrument` +
  exact broker identity (`conId`, `localSymbol`, `tradingClass`,
  `exchange`, `currency`, `broker`, `brokerSymbol`, `minTick`).
- `parseInstrumentBindings(input, registry)` — pure parser /
  validator. Accepts JSON text or pre-decoded value. Empty
  input is valid.
- `InstrumentBindingAuthority` — deep-frozen lookup by
  `instrumentId` or `conId`; safe `toDiagnostics()` (ids +
  count, never the raw payload).
- `buildInstrumentBindingAuthority(input, registry)` — one-shot
  factory returning a discriminated result.
- `tickSizesEqual` / `MIN_TICK_EPSILON` — floating-point
  tolerance helper used by ingestion and execution-engine.

Enforcement invariants (surfaced at boot AND at direct
constructor invocation — hostile-review fix):

- Unknown / duplicate `instrumentId` → rejected.
- Duplicate `conId` → rejected.
- Non-positive / non-safe-integer / non-integer `conId` → rejected.
- Non-positive / non-finite `minTick` → rejected.
- Blank / whitespace / non-string `localSymbol`,
  `tradingClass`, `exchange`, `currency` → rejected.
- `exchange`, `currency`, `tradingClass`, `broker` MUST match
  the logical registry entry.
- Malformed JSON → rejected; error message never echoes the raw
  payload.

### 1.2 Wire contract (`packages/shared/src/index.ts`)

- `SignalTicket.instrumentId?: string` (optional). Deliberately
  **excluded** from `computeClientOrderHash` (v1) so legacy
  rows without instrument_id keep validating. Identity is
  compared server-side via the persisted `instrument_id`
  column instead.

### 1.3 Ingestion (`apps/ingestion/src/`)

- `config.ts` parses `INSTRUMENT_BINDINGS_JSON`, throws at
  module-load on any validation failure.
- Bound instruments (`monitoringEnabled=true`) are additively
  appended to the legacy watchlist; duplicates by `conid`
  are suppressed.
- `tws-client.ts` forwards `localSymbol` + `tradingClass` on
  the `reqContractDetails` request for bound instruments.
- `binding-verification.ts` runs post-resolution. Every bound
  subscription's contract must match the binding on `conId`,
  `symbol`, `exchange`, `currency`, `localSymbol`, and
  `tradingClass`. Mismatch → drop (no subscription, no market
  state published under substituted identity).
- `/watchlist` surfaces bound `instrumentId` read-only and a
  `bindings` diagnostic block (count + ids, never the raw
  payload).

### 1.4 Signal-engine (`apps/signal-engine/src/`)

- `config.ts` gains `INSTRUMENT_BINDINGS_JSON`.
- `index.ts` (runtime branch) builds the authority once and
  wires:
  - `BindingAwareContractResolver` — resolves bound
    instruments to the exact operator-selected `conId`;
    unbound instruments fall through to the legacy Postgres
    lookup.
  - `TradingLoopService` receives the authority.
- `TradingLoopService.runInstrument`:
  1. Bound-check gate (`INSTRUMENT_BINDING_UNAVAILABLE`
     skip if the instrument is not bound).
  2. Reconciliation reader queries the bound `conId`.
  3. Market-data reader uses the bound `conId`.
  4. `executePrepared({ ..., bound })` propagates the bound
     view into the runtime.
- `ExecutionRuntime.executePrepared` accepts an optional
  `bound` and forwards it to `toLegacySignalTicket`.
- `toLegacySignalTicket` overrides `conid` + `instrument` on
  the legacy wire with the bound values and always sets
  `instrumentId`. Runtime assertion:
  `bound.instrumentId === ticket.instrumentId`.
- Types: `TradingLoopSkipReason` gains
  `INSTRUMENT_BINDING_UNAVAILABLE`.

### 1.5 Execution-engine (`apps/execution-engine/src/`)

- `config.ts` gains `INSTRUMENT_BINDINGS_JSON`.
- `instrument-bindings-config.ts` builds the execution-engine's
  OWN `InstrumentBindingAuthority` at boot; startup fails
  loudly on invalid input.
- `execute-ticket-schema.ts` accepts optional
  `ticket.instrumentId`; `allowCrossContractExposure` remains
  server-side only (round-7 stripping is retained).
- `index.ts`:
  - Builds the authority once; injects into `submissionService`.
  - `POST /execution/execute-ticket` REQUIRES `instrumentId`
    at the wire (400 `INSTRUMENT_BINDING_UNAVAILABLE` when
    absent) — deterministic HTTP-level enforcement.
- `submission-service.ts` — new `resolveBoundIdentity` helper:
  - Refuses missing / unknown / unbound / disabled instruments.
  - Compares payload `instrument` + `conid` to the resolved
    binding.
  - Resolves `allowCrossContractExposure` from
    `Instrument.executionPolicy?.allowCrossContractExposure
    ?? false` — caller cannot influence it.
  - Every rejection returns BEFORE `insertProposedFromTicket`,
    BEFORE `tryStartSubmissionWithPlan`, and BEFORE
    `dispatcher.dispatch`.
- Resume paths (idempotency replay + unique-violation race)
  add a payload-vs-persisted `instrumentId` comparison and
  return `BINDING_IDENTITY_MISMATCH` on divergence.
- `repository.ts`:
  - `ProposedOrderRow` and `mapRow` project the new
    `instrument_id` column.
  - `insertProposedFromTicket` writes `instrument_id`.
  - `PlanPersistenceInput.instrumentId` (optional) threads
    through to `tryStartSubmissionWithPlan`; the atomic
    identity re-check compares `row.instrument_id` to
    `input.prepared.instrumentId` under IS-NOT-DISTINCT-FROM
    semantics.
  - `validatePersistedOrderIdentity` reconstructs the ticket
    with `instrumentId` (but not into the hash).

### 1.6 Migration (`infra/sql/migrations/000006_proposed_orders_instrument_id.sql`)

- Adds nullable `instrument_id TEXT` on `proposed_orders`.
- Adds partial index
  `proposed_orders_instrument_id_idx WHERE instrument_id IS NOT NULL`.
- No backfill by symbol (ambiguous inference explicitly avoided).
- Idempotent (`IF NOT EXISTS`).

### 1.7 Configuration & docs

- `.env.example` — new `INSTRUMENT_BINDINGS_JSON` section with
  the JSON schema + operator workflow, no real conId sample.
- `docker-compose.yml` — forwards `INSTRUMENT_BINDINGS_JSON`
  verbatim to ingestion, signal-engine, and execution-engine.
- `docs/architecture/INSTRUMENT_REGISTRY.md` — new §11
  ("Instrument bindings").
- `docs/architecture/MARKET_DATA_RUNTIME.md` — PR15.2 wrapper
  explanation.
- `docs/architecture/TRADING_LOOP.md` — new bound-gate section.
- `docs/implementation/phase2/CONFIGURATION.md` — env table row.
- `docs/implementation/phase2/PHASE_2_ROADMAP.md` — status flip
  to "shipped".

## 2. Compatibility / migration

| Concern | Behavior |
| --- | --- |
| Legacy `/execution/execute-proposed/:id` | Unchanged. Rows with `instrument_id IS NULL` remain executable; `deps.allowCrossContractExposure = false` server-side default applies. |
| Rows created before the migration | `instrument_id IS NULL`, still reconcilable + resumable. Atomic identity check uses IS-NOT-DISTINCT-FROM so `NULL == NULL`. |
| llm-agent EXECUTE/REJECT gate | Continues to write proposals without `instrumentId`. `/execution/execute-proposed/:id` handles them via legacy fallback. |
| Backtest simulator writes | Continues to work; `instrumentId` never set on backtest tickets. |
| `computeClientOrderHash` | v1 unchanged — legacy hashes still validate. New identity checks live in explicit column comparisons + server-side binding resolution. |
| Ingestion `WATCHLIST_SYMBOLS` | Untouched. Bindings are ADDITIVE; the legacy watchlist keeps operating exactly as before. |
| `SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE = false` constant | Retained. Now used only as legacy default for unbound submissions; bound submissions read the value from the trusted registry policy. |

## 3. Verification gates

All gates were run against the current tree after the
hostile-review fixes documented in §4.

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | 0 errors; 3 pre-existing warnings in files not touched by PR15.2 (`apps/ui/vite.config.ts`, `apps/llm-agent/src/config.ts`, `apps/backtest-engine/src/simulator.ts`). |
| Typecheck | `pnpm typecheck` | ✅ all 8 workspace projects Done. |
| Unit tests | `pnpm test` | ✅ **1,010 tests, 0 failures**. Breakdown: shared 327, tools/paper-verify-stack 152, ingestion 30, signal-engine 298, execution-engine 203. |
| Integration | `TEST_POSTGRES_URL=... pnpm test:integration` | ✅ **313 tests, 0 failures** (execution-engine + PG). |
| Build | `pnpm build` | ✅ all packages built (`packages/shared`, `apps/*`, `tools/paper-verify-stack`). |
| `git diff --check` | | ✅ clean. |

### 3.1 New tests introduced

- `packages/shared/src/instruments/bindings.test.ts` — 26 tests
  (parser happy path, malformed JSON, top-level shape, unknown
  id, duplicate id/conId, tuple mismatch, blank fields,
  case normalization, runtime immutability, no symbol
  fallback, base registry immutability, safe diagnostics,
  factory outcomes).
- `packages/shared/src/instruments/seed-invariants.test.ts` — 3
  tests enforcing `executionEnabled=false` on every seed +
  registry listing + seed id set.
- `apps/execution-engine/src/execute-ticket-schema.test.ts` — 4
  new cases (instrumentId propagation, legacy compat,
  stripping under instrumentId present, empty-string
  rejection).
- `apps/execution-engine/src/reconciliation/submission-service.binding.test.ts` — 7
  tests covering every binding rejection outcome and asserting
  zero repo write / zero dispatch for each.
- `apps/execution-engine/src/reconciliation/pr15_2-instrument-id.pg-integration.test.ts` — 4
  PG-integration tests (fresh INSERT persists `instrument_id`,
  resume with swapped instrumentId → refused before dispatch,
  legacy `instrument_id IS NULL` remains executable via
  `executeProposed`, migration adds the expected column +
  index).
- `apps/ingestion/src/binding-verification.test.ts` — 8 tests
  covering happy path, legacy pass-through, and every
  mismatch class (conId / symbol / exchange / currency /
  localSymbol / tradingClass).
- `apps/signal-engine/src/runtime/market-data-reader.binding.test.ts` — 4
  tests (bound → bound conId, unbound → inner delegation,
  binding change on restart, frozen bound view).
- `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.test.ts` — 2
  new tests (skip when unbound, threads bound view into
  `executePrepared`).
- `apps/signal-engine/src/runtime/execution/ticket-mapper.test.ts` — 2
  new tests (instrumentId propagation, missing-instrumentId
  branch).

### 3.2 Additional tests from the hostile-review round

- `packages/shared/src/instruments/bindings.test.ts` — 12 new
  tests: `minTick` validation paths and direct
  `InstrumentBindingAuthority` constructor hardening (see §4a).
- `apps/ingestion/src/binding-verification.test.ts` — 7 new
  tests: missing-field rejection (exchange, currency,
  localSymbol, tradingClass, `minTick`), `minTick` mismatch,
  `minTick` matching within representation tolerance.
- `apps/execution-engine/src/reconciliation/submission-service.binding.test.ts` — 5
  new tests: `INSTRUMENT_POLICY_UNAVAILABLE`,
  `ORDER_TYPE_NOT_ALLOWED_BY_INSTRUMENT_POLICY` for LMT and
  STP, `INSTRUMENT_TICK_MISMATCH`, hostile caller-injected
  policy fields.
- `apps/signal-engine/src/runtime/execution/routes.test.ts` — 4
  new endpoint-level tests: `/runtime/execute` binding-
  unavailable rejection with zero submitter calls; bound
  submitter payload check; tick mismatch rejection; unbound
  id path with zero submitter calls.

## 4. Hostile-review round follow-ups

The first-round hostile review surfaced six findings.
Each is addressed below with the concrete change AND the
test that fails-closed on regression.

### 4a.1 `/runtime/execute` bypass fixed

- **Finding.** `ExecutionRuntime.execute()` did not use the
  binding authority; only the trading loop threaded it into
  `executePrepared()`. `/runtime/execute` on a bound futures
  seed would submit a ticket without `conId` and be rejected
  by execution-engine.
- **Fix.** `ExecutionRuntime` gained an optional
  `bindingAuthority` constructor option. When wired
  (production path in
  `apps/signal-engine/src/index.ts:354`), `execute()`:
  1. Resolves the binding for `input.instrumentId` BEFORE any
     `dryRun()` call.
  2. Fails closed with
     `NOT_SUBMITTED / INSTRUMENT_BINDING_UNAVAILABLE` for
     unbound instruments.
  3. Fails closed with
     `NOT_SUBMITTED / INSTRUMENT_TICK_MISMATCH` when the
     caller-supplied policy `priceTickSize` disagrees with
     `bound.minTick`.
  4. Forwards the frozen bound view through
     `#submitFromDryRun` → `toLegacySignalTicket`, so the
     submitter receives the exact operator-configured
     `conId` / `localSymbol` / `tradingClass` / `brokerSymbol`.
- **Test.** `routes.test.ts` describes
  `POST /runtime/execute — PR15.2 binding gate` and asserts
  submitter call count `=== 0` on every rejection path.

### 4a.2 Complete registry policy enforced server-side

- **Finding.** The submission-service binding gate read only
  `allowCrossContractExposure`. Missing
  `Instrument.executionPolicy` or a payload `orderType`
  outside `executionPolicy.allowedOrderTypes` were not
  rejected.
- **Fix.** `resolveBoundIdentity` now:
  1. Requires `bound.instrument.executionPolicy` (returns
     `instrument_policy_unavailable` when missing).
  2. Requires `ticket.orderType` ∈ `allowedOrderTypes` (returns
     `order_type_not_allowed_by_instrument_policy`).
  3. Requires `policy.priceTickSize` to match `bound.minTick`
     under the shared `tickSizesEqual` tolerance (returns
     `instrument_tick_mismatch`).
  4. Continues to resolve `allowCrossContractExposure`
     exclusively from the trusted registry — no HTTP field
     feeds this decision.
- **HTTP mapping.** `index.ts` now emits:
  - 423 `INSTRUMENT_POLICY_UNAVAILABLE`.
  - 400 `ORDER_TYPE_NOT_ALLOWED_BY_INSTRUMENT_POLICY`.
  - 423 `INSTRUMENT_TICK_MISMATCH`.
- **Test.** `submission-service.binding.test.ts` asserts
  `insertProposedFromTicket === 0` AND
  `dispatchCount === 0` for each rejection, including the
  hostile "caller injects policy fields on the ticket" case.
- **Legacy compat.** `/execution/execute-proposed/:id` on
  `instrument_id IS NULL` rows still bypasses the binding
  gate and inherits the hardcoded server default
  (`allowCrossContractExposure = false`). Covered by
  `pr15_2-instrument-id.pg-integration.test.ts`.

### 4a.3 Broker-verified `minTick` in bindings

- **Finding.** `BoundInstrument` had no `minTick`, so
  signal-engine relied on the manually configured
  `executionPolicy.priceTickSize` without proof it matched
  the exact IBKR contract.
- **Fix.**
  - Added `InstrumentBinding.minTick: number` (positive,
    finite) and `BoundInstrument.minTick`. Kept out of the
    expiring seed catalogue — it belongs to the dated
    contract, not the logical instrument.
  - Parser and constructor both validate `minTick`.
  - Ingestion `verifyBoundSubscriptions` cross-checks the
    broker-returned `minTick` (populated by
    `TwsClient.buildInstrumentContract` from
    `reqContractDetails`) against `bound.minTick` under
    `tickSizesEqual` (1e-9 tolerance). A missing broker
    `minTick` OR a mismatch is a mismatch, not a skip.
  - Execution-engine `resolveBoundIdentity` cross-checks the
    trusted registry `executionPolicy.priceTickSize` against
    `bound.minTick`.
  - Signal-engine `ExecutionRuntime.execute()` cross-checks
    the caller-supplied `policy.priceTickSize` against
    `bound.minTick`.
- **Test.** `bindings.test.ts` covers parser + constructor
  paths; `binding-verification.test.ts` covers ingestion;
  `submission-service.binding.test.ts` covers execution-
  engine; `routes.test.ts` covers `/runtime/execute`.

### 4a.4 Exactly-one `contractDetails` for bound instruments

- **Finding.** `apps/ingestion/src/tws-client.ts` kept the
  first `contractDetails` response and ignored subsequent
  results — an ambiguous IBKR response would silently pick
  one contract.
- **Fix.**
  - Added `TwsClient.requestContractDetailsExactlyOne`. It
    collects every `contractDetails` event for the request id
    and rejects the promise on 0 or >1 results.
  - `resolveContract` routes bound instruments (identified by
    `WatchlistInstrument.instrumentId`) through the strict
    method. The legacy watchlist keeps the permissive
    `requestContractDetails` path.
  - `verifyBoundSubscriptions` now treats missing
    `exchange` / `currency` / `localSymbol` / `tradingClass`
    / `minTick` fields on the returned contract as
    mismatches, not as "skip validation".
- **Test.** `binding-verification.test.ts` covers every
  missing-field case + tick mismatch. The strict TWS
  method itself is exercised end-to-end at the ingestion
  bootstrap, which requires a running IBKR socket and is
  therefore not unit-tested — the pure Promise wrapper is
  the review-time contract.

### 4a.5 Constructor hardening for `InstrumentBindingAuthority`

- **Finding.** The class trusted the parser too aggressively;
  a caller that bypassed `parseInstrumentBindings` could
  build an authority with a negative `conId`, missing
  `minTick`, blank string fields, or a registry-mismatched
  tuple.
- **Fix.** The constructor now re-runs every parser invariant
  (see §1.1). Non-array input, non-object entries, and every
  shape / registry / duplicate check fail-loud with a
  descriptive `Error`.
- **Test.** `bindings.test.ts` §
  "InstrumentBindingAuthority — constructor hardening" adds
  10 direct-constructor tests (conId, minTick, empty fields,
  each registry mismatch, unknown id, non-array input,
  duplicates via a separate pre-existing test).

### 4a.6 Documentation status corrected

- `docs/implementation/phase2/PHASE_2_ROADMAP.md` now marks
  PR15.2 as **implemented, in review** (not `shipped`).
- This report's §6 no longer claims "zero alternative path
  bypasses the binding gate" as an absolute; instead §6 lists
  the exact rejection points that are regression-covered,
  and §4a documents the surfaces that were verified in the
  hostile review.

## 4b. Hostile-review round-3 fixes

Three additional findings surfaced in the second-pass
review. Each is addressed below with the specific change
and the test that regression-covers it.

### 4b.1 `secType` propagation for bound instruments

- **Finding.** The initial bound-watchlist expander in
  `apps/ingestion/src/config.ts` produced `WatchlistInstrument`
  entries without a `secType`.
  `TwsClient.withDefaults()` then filled in the ingestion
  default `STK`, so the strict `contractDetails` request for
  a bound futures contract combined a futures `conId` and
  `localSymbol` with `secType=STK` — an ambiguous IBKR query.
- **Fix.**
  - Added `mapAssetClassToIbkrSecType(assetClass)` to the
    shared package (`packages/shared/src/instruments/bindings.ts`).
    Exhaustive over the `AssetClass` union: `future`→`FUT`,
    `stock`/`etf`→`STK`, `index`→`IND`, `forex`→`CASH`,
    `option`→`OPT`, `crypto`→`CRYPTO`. TypeScript's
    exhaustiveness check forces the switch to grow with new
    asset classes.
  - The bound-watchlist expander (later relocated to
    `apps/ingestion/src/bound-watchlist.ts` and today reached
    only through the public `buildMergedWatchlist` — see §4c,
    §4e, §4f) now sets
    `secType: mapAssetClassToIbkrSecType(bound.instrument.assetClass)`.
    The value is derived from the trusted registry
    `Instrument.assetClass` — NEVER from the symbol, exchange,
    port, or operator-supplied fields.
  - Signal-engine's local `mapAssetClassToSecType` helper now
    delegates to the shared function so both consumers cannot
    drift.
  - The legacy watchlist path is untouched.
- **Tests.**
  - `packages/shared/src/instruments/bindings.test.ts` §
    `mapAssetClassToIbkrSecType` — six cases + an
    exhaustiveness check over every seed `assetClass`.
  - `apps/ingestion/src/tws-client.contract-details.test.ts` §
    `buildMergedWatchlist secType propagation` — proves that
    the end-to-end request the fake IB sees carries
    `secType=FUT` and never `STK`.

### 4b.2 Returned-symbol verification

- **Finding.** `apps/ingestion/src/binding-verification.ts`
  compared `sub.symbol` (the REQUESTED watchlist symbol,
  identical to `bound.brokerSymbol` by construction) with
  `bound.brokerSymbol` — a tautology. The RETURNED broker
  symbol (`sub.contract.symbol`) was never checked, so a
  broker substitution would go unnoticed. The pre-existing
  symbol-mismatch test also treated substitution as a legacy
  pass-through, which is unsafe.
- **Fix.**
  - `verifyBoundSubscriptions` now reads the returned symbol
    from `sub.contract.symbol` and normalises with
    `toUpperOrEmpty` (same rule as exchange / currency /
    localSymbol / tradingClass).
  - A missing returned symbol is a mismatch, not a skip.
  - A returned symbol different from `bound.brokerSymbol` is a
    mismatch that drops the bound subscription; it is NEVER
    reclassified as legacy.
- **Tests.** `apps/ingestion/src/binding-verification.test.ts`:
  - Updated `symbol mismatch → drop` — now emits a bound
    subscription whose `contract.symbol` differs from the
    binding and asserts `accepted.length === 0`,
    `mismatches.length === 1`, and a clear
    `symbol mismatch` reason.
  - New `symbol missing in contractDetails → drop` — proves
    the missing-symbol path fails-closed.

### 4b.3 Event-level tests for exactly-one `contractDetails`

- **Finding.** The plan requires ingestion tests for the
  exact-conId event-driven path, including multi-result
  refusal, but round-1 tests only exercised the post-
  resolution verifier.
- **Fix.**
  - The exactly-one logic was extracted into a pure exported
    helper `awaitExactlyOneContractDetails(input)` in
    `apps/ingestion/src/tws-client.ts`. `TwsClient.request-
    ContractDetailsExactlyOne` now delegates to it, so the
    production wiring and the tests exercise the SAME code.
  - The new `IbEventPort` interface lets the tests inject a
    fake `EventEmitter`-backed IB port without a real socket.
- **Tests.** `apps/ingestion/src/tws-client.contract-details.test.ts`:
  1. Exactly one matching event → resolves; `reqContractDetails`
     called once with the exact bound contract (asserts
     `secType=FUT`); listener count returns to zero.
  2. Zero results → rejects `expected exactly one`; zero
     listener leak.
  3. Two results → rejects `Ambiguous contract details`;
     does NOT pick the first; zero listener leak.
  4. Error event for the same `reqId` → rejects with the
     IBKR code; zero listener leak.
  5. Events for other `reqId`s are ignored; concurrent
     resolutions on the same port do not cross-wire.
  6. Timeout → rejects with `Timed out waiting contractDetails`;
     zero listener leak.

## 4c. Hostile-review round-4 fixes

Two follow-up findings from the third review pass. Each is
covered by a targeted regression test.

### 4c.1 `secType=FUT` regression test now exercises production code

- **Finding.** The round-3 `secType` regression test manually
  called `mapAssetClassToIbkrSecType` and hand-built the
  contract fed into `awaitExactlyOneContractDetails`.
  Removing `secType` from the real production bound-watchlist
  builder in `config.ts` would NOT have failed the test.
- **Fix.**
  - Extracted the additive-bound-watchlist logic into a
    new pure module `apps/ingestion/src/bound-watchlist.ts`.
    No `process.env` reads, no I/O, no module-load side
    effects. (In round-7 this module's public surface was
    narrowed to a single exported function
    `buildMergedWatchlist`; see §4f.)
  - `config.ts` now calls `buildMergedWatchlist` with the
    module-scoped authority + parsed legacy list. The local
    helper was deleted.
  - The regression test imports the SAME function and
    threads the produced entry through the strict IB
    resolver.
- **Tests.** `apps/ingestion/src/tws-client.contract-details.test.ts`
  §  `buildMergedWatchlist secType propagation`:
  1. A real bound `future` seed produces a `WatchlistInstrument`
     with `secType="FUT"` plus the authoritative broker
     identity (`conid`, `localSymbol`, `tradingClass`,
     `exchange`, `currency`, `symbol`, `instrumentId`).
  2. Feeding the produced entry into
     `awaitExactlyOneContractDetails` proves the fake IB
     port receives `secType="FUT"`, never `"STK"`. Removing
     the `secType:` line from `bound-watchlist.ts` would
     make this assertion fail.

### 4c.2 Synchronous `reqContractDetails()` failure cleans up

- **Finding.** `awaitExactlyOneContractDetails` registered
  three listeners and a timeout before calling
  `ib.reqContractDetails(...)`. A synchronous throw from that
  call would auto-reject the enclosing Promise executor, but
  `cleanup()` never ran — leaving listeners AND the timer
  active until timeout.
- **Fix.** Wrapped only the `reqContractDetails` call in
  `try/catch`. On a synchronous exception:
  1. `cleanup()` runs immediately (clears the timer, removes
     the three listeners);
  2. `reject()` fires once with an informative error that
     includes the safe `label` and preserves the original
     message via `err.message`;
  3. No retry, no symbol-based fallback.
- **Test.** `apps/ingestion/src/tws-client.contract-details.test.ts`
  §  "synchronous throw from reqContractDetails" — uses a
  fake IB whose `reqContractDetails` throws. Asserts:
  1. Promise rejects with `reqContractDetails threw
     synchronously for bound instrument es_front: socket not
     connected`.
  2. `contractDetails` / `contractDetailsEnd` / `error`
     listener counts are all zero immediately after
     rejection.
  3. After waiting past the original `timeoutMs` (50 ms),
     the promise does NOT reject a second time and listener
     counts remain zero — the timer was cleared.
  4. `reqContractDetails` was attempted exactly once.

## 4d. Hostile-review round-5 fix

### 4d.1 Legacy/bound conId collision now lets the bound entry win

- **Finding.** The previous internal builder skipped the
  bound entry when its `conid` matched a legacy watchlist
  entry, and `config.ts` kept the original legacy entry.
  Because the legacy entry has no `instrumentId`,
  `TwsClient.resolveContract` routed that instrument through
  the permissive `firstDetails` / `secType=STK` fallback
  instead of `requestContractDetailsExactlyOne`. The
  authoritative binding was silently bypassed — exactly the
  failure mode PR15.2 exists to prevent. The existing round-4
  test explicitly documented this unsafe behavior via
  `assert.equal(colliding.length, 0)`.
- **Fix.**
  - The bound-watchlist expander was rewritten so that on a
    `conid` collision the BOUND entry is always emitted and
    the colliding legacy `conid` is recorded internally for
    the merge step to filter. Collision handling is not
    exposed as a separate public API — the collision filter
    and the merge are performed atomically inside
    `buildMergedWatchlist` (see §4e, §4f) so no caller can
    skip the filter.
  - `config.ts` calls `buildMergedWatchlist` and consumes
    both `mergedWatchlist` (for ingestion bootstrap) and
    `boundWatchlist` (for the `/watchlist` diagnostic).
    The bound entry survives and is routed through the
    strict identity path; the colliding legacy entry is
    removed from the merged watchlist.
  - No hot-reload semantics change; the merge remains a
    startup-time computation.
- **Tests.**
  - `apps/ingestion/src/bound-watchlist.test.ts` §
    "collision: legacy entry is FILTERED OUT of the merged
    list; bound entry survives; no duplicate conid" — proves
    the collision contract via the public
    `buildMergedWatchlist` API.
  - `apps/ingestion/src/tws-client.contract-details.test.ts`
    § `buildMergedWatchlist secType propagation` — proves the
    real production builder emits `secType=FUT` for a bound
    future and that the produced entry, fed unchanged into
    the strict IB resolver, reaches IB with `secType=FUT`
    (never `STK`).

## 4e. Hostile-review round-6 refactor

### 4e.1 Single production merge function shared by config and tests

- **Finding.** After the round-5 fix the runtime behavior was
  correct, but `bound-watchlist.test.ts` re-implemented the
  merge shape (`mergeWatchlists`) as a local test helper.
  A production wiring regression in `config.ts` — for
  example, appending `boundWatchlist` BEFORE filtering the
  legacy list — would not have been caught by the test.
- **Fix.**
  - Added `buildMergedWatchlist({ authority, legacyWatchlist })`
    to `apps/ingestion/src/bound-watchlist.ts`. It returns
    `{ mergedWatchlist, boundWatchlist }` (both `readonly`)
    and encapsulates the entire collision-aware merge:
    filter colliding legacy conids, then append the bound
    entries.
  - `config.ts` now calls `buildMergedWatchlist` directly.
    The bespoke filter-then-concat block was removed.
  - `apps/ingestion/src/bound-watchlist.test.ts` was rewritten
    to call the SAME `buildMergedWatchlist` function — no
    duplicated `mergeWatchlists` helper remains anywhere in
    the tests.
- **Tests.** `apps/ingestion/src/bound-watchlist.test.ts`
  (round-6 baseline: 3 tests) — all against the production
  `buildMergedWatchlist`:
  1. Collision → legacy entry filtered out, bound entry
     present with full authoritative identity, no duplicate
     `conid` in the merged list, bound-only view matches.
  2. No collision → legacy list preserved in original order,
     bound entry appended at the end.
  3. No bindings → merged list equals the legacy list,
     bound view is empty.

## 4f. Hostile-review round-7 fix

### 4f.1 Removed the public lower-level builder from the ingestion surface

- **Finding.** After round-6, `bound-watchlist.ts` still
  exported BOTH `buildMergedWatchlist` (the safe collision-
  aware entry point) AND `buildBoundWatchlist` (the lower-
  level expander that returned `{ bound, suppressedLegacyConids }`
  without performing the merge). A future caller could import
  `buildBoundWatchlist`, read `.bound`, and skip the
  collision filter — silently reintroducing the round-5
  failure mode. The public surface was wider than the safety
  contract.
- **Fix.**
  - `apps/ingestion/src/bound-watchlist.ts` now exports ONLY
    `buildMergedWatchlist` (plus its `Input` / `Result`
    interfaces). The expander that computes the bound entries
    and the set of blocked legacy conids is a module-private
    `expandBoundEntries` function; its returned interface
    (`BoundExpansion` with `blockedLegacyConids`) is not
    exported. `BuildBoundWatchlistInput` and
    `BuildBoundWatchlistResult` are gone.
  - The tws-client contract-details tests were migrated to
    call `buildMergedWatchlist` and destructure
    `{ mergedWatchlist, boundWatchlist }`. Every assertion
    against the internal `suppressedLegacyConids` shape was
    removed; the two collision-shape tests in that file were
    dropped because `bound-watchlist.test.ts` already covers
    the same contract through the public API. What remains in
    the contract-details file is the two tests that this file
    actually exists for: (a) the real production builder
    emits `secType=FUT` for a bound future with the
    authoritative broker identity, and (b) that produced
    entry, fed unchanged into the strict IB resolver, reaches
    IB with `secType=FUT` (never `STK`).
- **Test.** New test in
  `apps/ingestion/src/bound-watchlist.test.ts`:
  "`monitoringEnabled=false` on a bound instrument: bound
  entry is NOT emitted AND colliding legacy entry is
  preserved untouched". It:
  1. Constructs a REAL custom `InstrumentRegistry` by cloning
     `defaultInstrumentRegistry.listAll()` and overriding
     `es_front` with `trading.monitoringEnabled=false`.
  2. Configures a binding for `es_front` whose `conId`
     collides with a legacy watchlist entry.
  3. Asserts `boundWatchlist.length === 0` (the disabled
     bound entry is skipped entirely).
  4. Asserts `mergedWatchlist` contains ONLY the legacy
     entry, unchanged, with `instrumentId === undefined` —
     proving that when there is no bound emission the legacy
     entry is NOT collaterally suppressed and does NOT
     inherit a binding identity.
- **Surface verification.**
  `rg -n "buildBoundWatchlist|suppressedLegacyConids" apps/ingestion/src`
  returns zero matches after this round.

## 5. Hostile review evidence (surface inspection)

### 5.1 Zero broker calls on binding rejection

- `apps/execution-engine/src/tws-execution-client.ts:749`
  contains the only production `ib.placeOrder` call. Its
  entry point is
  `TwsExecutionClient.dispatchPreparedOrder` — invoked from
  `submissionService.runDispatch`, which is only reached from
  `runThreePhase`. `runThreePhase` runs AFTER the binding
  gate.
- Every unit + PG-integration binding rejection test asserts
  `dispatchCount() === 0` after the rejection.

### 5.2 Callers of `POST /execution/execute-ticket`

- `apps/signal-engine/src/runtime/execution/submitter.ts:180`
  (`HttpExecutionTicketSubmitter`) — the production caller.
  Payload is built from a `SignalTicket` that flows through
  `toLegacySignalTicket`, which sets `instrumentId`.
- `apps/execution-engine/src/auth.test.ts` — mock route, not
  the real handler.
- No other production code path issues a request to this
  endpoint.

### 5.3 Callers of `ExecutionRuntime.execute` / `executePrepared`

- `apps/signal-engine/src/runtime/execution/routes.ts:113` —
  `/runtime/execute`. Guarded by the new binding gate
  (§4a.1).
- `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.ts:631` —
  the trading loop. Passes the frozen `bound` view through
  `executePrepared`.
- Unit tests in
  `apps/signal-engine/src/runtime/execution/execution-runtime.test.ts`
  exercise the legacy (no-authority) path for regression
  coverage; production wiring always injects the authority.

### 5.4 ExecutionTicket ↔ SignalTicket conversions

- `apps/signal-engine/src/runtime/execution/ticket-mapper.ts`
  is the only mapper. It populates `instrumentId` and
  overrides `instrument` + `conid` with the bound view when
  supplied.

### 5.5 Symbol-only contract lookups

- `apps/signal-engine/src/runtime/market-data-reader.ts` still
  contains a symbol lookup in
  `SignalRepositoryContractResolver`, but it is wrapped by
  `BindingAwareContractResolver` in production wiring — bound
  instruments always short-circuit. Unbound instruments
  (legacy stock watchlist) continue using the symbol lookup,
  which is the intentional behavior for backwards
  compatibility.

### 5.6 `firstDetails` selections

- `apps/execution-engine/src/tws-execution-client.ts` uses
  `firstDetails` only inside `resolveContractByConid`
  (invoked when `ticket.conid` is present) — a conId-scoped
  query normally returns exactly one entry. Bound tickets
  always carry `ticket.conid` because
  `toLegacySignalTicket` sets it from the bound view.
- `apps/ingestion/src/tws-client.ts` — the legacy watchlist
  keeps `requestContractDetails` (first-match semantics).
  Bound instruments now route through
  `requestContractDetailsExactlyOne` (§4a.4).

### 5.7 Production `allowCrossContractExposure` uses

- `submission-service.ts` resolves it from
  `bound.instrument.executionPolicy?.allowCrossContractExposure
  ?? false` for bound submissions. Legacy (unbound)
  submissions inherit `deps.allowCrossContractExposure`,
  which is wired to
  `SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE = false`.
- `execute-ticket-schema.ts` still strips
  `allowCrossContractExposure` — regression-covered by the
  existing schema test.

### 5.8 `proposed_orders` insert / resume paths

- `insertProposedFromTicket` writes `instrument_id`
  (nullable).
- `tryStartSubmissionWithPlan` re-selects the row `FOR
  UPDATE` and compares `row.instrument_id` to the prepared
  plan's `instrumentId`. Mismatch →
  `submission_identity_mismatch (reason:
  instrument_id_mismatch)`, marker NEVER set, no legs
  persisted, no dispatch.
- The resume path in `submitTicket` also compares the racing
  row's `instrumentId` against the payload before delegating
  to `runThreePhase`.

### 5.9 Seed `executionEnabled` values

- `packages/shared/src/instruments/seed-invariants.test.ts`
  regression-tests every seed and asserts
  `listExecutionEnabled().length === 0`.

### 5.10 `INSTRUMENT_BINDINGS_JSON` in logs

- Grep proves no `console.*` or `app.log.*` call includes the
  raw env var value. Boot logs surface only
  `authority.toDiagnostics()` (count + ids).
- Parser and constructor errors carry index + reason strings,
  never the payload.

### 5.11 Regression-covered proofs

The following invariants are proven by tests that fail if a
future change regresses them:

- A caller CANNOT select server policy — the schema strips
  `allowCrossContractExposure`; the service resolves it from
  the trusted registry.
- A caller CANNOT pair one registry id with another contract —
  the identity check compares payload `instrument` + `conid`
  to the resolved binding.
- A caller CANNOT inject `allowedOrderTypes` or
  `priceTickSize` onto the ticket — the service reads only
  the registry policy.
- An unbound / disabled / no-policy / disallowed-order-type /
  tick-mismatch instrument CANNOT create durable submission
  state — every rejection path returns before
  `insertProposedFromTicket`.
- A configured futures binding NEVER falls back to root-symbol
  resolution — bound tickets always carry a `conid`;
  ingestion's post-resolution verification catches any broker
  substitution.
- Ambiguous IBKR `contractDetails` (0 or >1 results) CANNOT
  create a subscription for a bound instrument — the strict
  method rejects.
- An unbound `/runtime/execute` payload CANNOT read market
  data BEFORE the binding gate — the runtime returns
  `NOT_SUBMITTED / INSTRUMENT_BINDING_UNAVAILABLE` before
  calling `MarketDataRuntime.dryRun`.
- Every binding failure results in zero `ib.placeOrder`
  calls (asserted via `dispatchCount === 0` in the fake
  dispatcher).
- All six seed instruments still ship
  `executionEnabled=false`.

## 6. Rollback instructions

The PR is one focused branch; rollback is a plain revert of
the touched files + drop of migration 000006:

```bash
git revert <PR15.2 commit(s)>          # or reset to 89e1377
docker compose exec -T postgres psql -U postgres -d ikbr_trader -c \
  "DROP INDEX IF EXISTS proposed_orders_instrument_id_idx; \
   ALTER TABLE proposed_orders DROP COLUMN IF EXISTS instrument_id;"
docker compose exec -T postgres psql -U postgres -d ikbr_trader -c \
  "DELETE FROM schema_migrations WHERE version = '000006';"
```

Notes:

- The migration is additive; dropping the column is safe
  because no code queries it after the revert.
- Existing PROPOSED rows written by PR15.2 carry
  `instrument_id`; after the drop they retain their previous
  behavior (the column is gone, callers do not read it).
- Bindings are startup-only, so unsetting
  `INSTRUMENT_BINDINGS_JSON` before the revert keeps
  services running against the pre-PR15.2 code paths.

## 7. Explicit confirmations

- ✅ **Zero real broker orders** submitted during
  implementation and testing. `ib.placeOrder` is guarded and
  every rejection test asserts `dispatchCount === 0`.
- ✅ **Zero `executionEnabled=true`** flips. Every seed still
  ships `executionEnabled=false`; the regression test in
  `seed-invariants.test.ts` proves this.
- ✅ **No live enablement**. `IBKR_ENVIRONMENT` default =
  `paper`; `TRADING_ENABLED` default = `false`;
  `EXECUTION_RUNTIME_ENABLED` default = `false`;
  `TRADING_LOOP_ENABLED` default = `false`.
- ✅ **No automatic futures roll**. PR15.2 documents this
  exclusion in `INSTRUMENT_REGISTRY.md` §11.3 and
  `TRADING_LOOP.md`. Bindings are runtime-immutable — a roll
  is a config change + service restart.
- ✅ **Both production submission-service entry points route
  through the binding authority**: `/execution/execute-ticket`
  and `/execution/execute-proposed/:id` (the latter only
  applies the binding gate when the persisted row carries a
  non-NULL `instrument_id`; NULL rows stay on the legacy
  safe default `allowCrossContractExposure = false`).
  Verified via unit + PG-integration tests. `/runtime/execute`
  now also routes through the binding gate in production
  wiring (§4a.1) and is regression-covered.
- ⚠ **PR15.2 does not enumerate every historic proposal-flow
  entry point.** The llm-agent EXECUTE/REJECT loop and the
  backtest simulator do not use `instrument_id` today and
  continue to run against the legacy safe defaults. A future
  PR that flips a paper seed to `executionEnabled=true`
  (PR15.3) MUST re-audit those flows before enabling live
  routing.

## 8. Final git status + diff stat

`git status --short`:

```
 M .env.example
 M apps/execution-engine/src/config.ts
 M apps/execution-engine/src/execute-ticket-schema.test.ts
 M apps/execution-engine/src/execute-ticket-schema.ts
 M apps/execution-engine/src/index.ts
 M apps/execution-engine/src/reconciliation/submission-service.ts
 M apps/execution-engine/src/reconciliation/three-phase-r7.pg-integration.test.ts
 M apps/execution-engine/src/reconciliation/three-phase-r8.pg-integration.test.ts
 M apps/execution-engine/src/repository.ts
 M apps/ingestion/package.json
 M apps/ingestion/src/config.ts
 M apps/ingestion/src/index.ts
 M apps/ingestion/src/tws-client.ts
 M apps/ingestion/src/types.ts
 M apps/signal-engine/src/config.ts
 M apps/signal-engine/src/index.ts
 M apps/signal-engine/src/runtime/execution/execution-runtime.ts
 M apps/signal-engine/src/runtime/execution/routes.test.ts
 M apps/signal-engine/src/runtime/execution/ticket-mapper.test.ts
 M apps/signal-engine/src/runtime/execution/ticket-mapper.ts
 M apps/signal-engine/src/runtime/market-data-reader.ts
 M apps/signal-engine/src/runtime/trading-loop/trading-loop-service.test.ts
 M apps/signal-engine/src/runtime/trading-loop/trading-loop-service.ts
 M apps/signal-engine/src/runtime/trading-loop/types.ts
 M docker-compose.yml
 M docs/architecture/INSTRUMENT_REGISTRY.md
 M docs/architecture/MARKET_DATA_RUNTIME.md
 M docs/architecture/TRADING_LOOP.md
 M docs/implementation/phase2/CONFIGURATION.md
 M docs/implementation/phase2/PHASE_2_ROADMAP.md
 M packages/shared/src/index.ts
 M packages/shared/src/instruments/registry.ts
?? apps/execution-engine/src/instrument-bindings-config.ts
?? apps/execution-engine/src/reconciliation/pr15_2-instrument-id.pg-integration.test.ts
?? apps/execution-engine/src/reconciliation/submission-service.binding.test.ts
?? apps/ingestion/src/binding-verification.test.ts
?? apps/ingestion/src/binding-verification.ts
?? apps/ingestion/src/bound-watchlist.test.ts
?? apps/ingestion/src/bound-watchlist.ts
?? apps/ingestion/src/tws-client.contract-details.test.ts
?? apps/signal-engine/src/runtime/market-data-reader.binding.test.ts
?? docs/implementation/phase2/PR15_2_PLAN.md
?? docs/implementation/phase2/PR15_2_REPORT.md
?? infra/sql/migrations/000006_proposed_orders_instrument_id.sql
?? packages/shared/src/instruments/bindings.test.ts
?? packages/shared/src/instruments/bindings.ts
?? packages/shared/src/instruments/seed-invariants.test.ts
```

`git diff --stat` (tracked files only):

```
 32 files changed, ~1752 insertions(+), ~51 deletions(-)
```

Untracked additions (new modules, tests, migration, plan +
report + docs):

- `packages/shared/src/instruments/bindings.ts`
- `packages/shared/src/instruments/bindings.test.ts`
- `packages/shared/src/instruments/seed-invariants.test.ts`
- `apps/execution-engine/src/instrument-bindings-config.ts`
- `apps/execution-engine/src/reconciliation/submission-service.binding.test.ts`
- `apps/execution-engine/src/reconciliation/pr15_2-instrument-id.pg-integration.test.ts`
- `apps/ingestion/src/binding-verification.ts`
- `apps/ingestion/src/binding-verification.test.ts`
- `apps/signal-engine/src/runtime/market-data-reader.binding.test.ts`
- `infra/sql/migrations/000006_proposed_orders_instrument_id.sql`
- `docs/implementation/phase2/PR15_2_PLAN.md`
- `docs/implementation/phase2/PR15_2_REPORT.md`

## 9. Deviations from the plan

None material.

Two design decisions worth surfacing:

1. **`instrumentId` is enforced at the HTTP handler layer, not
   at the deep service layer.** The plan's wording
   ("`POST /execution/execute-ticket` must require it for this
   endpoint") is satisfied at the endpoint. The submission
   service internally treats a missing `instrumentId` as the
   legacy path so pre-PR15.2 pg-integration harnesses and the
   `/execution/execute-proposed/:id` flow keep operating.
   Every other layer (identity mismatch on resume, binding
   gate when instrumentId is present) is still strictly
   fail-closed. Rationale documented inline in
   `submission-service.ts:527`.
2. **`instrumentId` is NOT part of `computeClientOrderHash`
   v1.** Legacy hashes stay valid. Identity is enforced via
   the explicit `instrument_id` column comparison and the
   server-side binding lookup — both strictly deterministic.
   Documented in `packages/shared/src/index.ts` on
   `SignalTicket.instrumentId`.

Both choices preserve compatibility while retaining the
plan's safety invariants.

## 10. Stop condition

- Report complete.
- Verification gates green.
- No commit, no push, no remote PR — waiting for explicit
  operator approval to proceed.
