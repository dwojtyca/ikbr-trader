# PR15.2 — Authoritative Instrument Binding — PLAN (r1)

> Status: **planned; awaiting implementation approval**.
>
> Gates on: PR15.1 at `89e1377`.
>
> Scope: bind a logical registry `instrumentId` to one exact,
> operator-selected and broker-verified IBKR contract, then carry and
> verify that identity across ingestion → signal-engine →
> execution-engine.
>
> **No `executionEnabled=true` change. No Paper order. No Live
> enablement. No automatic futures roll. No exit path.**

## 1. Why this PR exists

The Phase 2 pipeline has two different notions of instrument identity:

- the shared registry identifies the logical instrument (`es_front`,
  `gc_front`, and so on);
- runtime market data and execution use a symbol and, when available, a
  `conId`.

That boundary is not authoritative today:

- all six seed futures are logical front-month definitions without a
  dated `conId` or `localSymbol`;
- signal-engine resolves `brokerSymbol → conId` from
  `instrument_contracts`, whose primary key is only `symbol`;
- ingestion and execution-engine may select the first IBKR
  `contractDetails` result when no `conId` is supplied;
- the new `ExecutionTicket` has `instrumentId`, but
  `toLegacySignalTicket()` drops it before
  `POST /execution/execute-ticket`;
- execution-engine therefore cannot prove that the caller's symbol and
  `conid` belong to the registry instrument that was risk-checked;
- execution-engine still hardcodes
  `SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE=false` because it has no trusted
  server-side registry binding.

For futures, a root symbol such as `ES` or `SI` is not a tradable
contract identity. Selecting the first matching contract is unsafe.

## 2. Outcome

After PR15.2:

1. An operator can configure an exact binding from a registry
   `instrumentId` to a positive IBKR `conId`.
2. Ingestion verifies that exact contract with IBKR and publishes market
   data only under the verified identity.
3. Signal-engine reads market data for that exact binding and carries
   `instrumentId + conId` into the execution request.
4. Execution-engine resolves its own copy of the binding and rejects any
   unknown, missing, disabled, or mismatched identity before persistence
   or broker dispatch.
5. Order-critical server policy is resolved from the trusted registry;
   it is never accepted from the HTTP caller.
6. Legacy proposal execution remains compatible and keeps the safe
   `allowCrossContractExposure=false` default.
7. Every production seed remains `executionEnabled=false`, so the PR
   cannot submit a new runtime order.

PR15.3 may then choose one verified Paper binding, add/confirm its
execution policy, explicitly enable it, and run the entry-only E2E
window.

## 3. Design decisions

### 3.1 Keep logical instruments separate from dated contracts

Do not write expiring `conId` or `localSymbol` values into
`INSTRUMENT_DEFINITIONS`.

`InstrumentRegistry` remains immutable, process-local, and free of
network/database/environment access. A new binding layer composes a
logical `Instrument` with an exact broker contract at application
startup.

### 3.2 One shared binding input

Add one environment variable used by ingestion, signal-engine, and
execution-engine:

`INSTRUMENT_BINDINGS_JSON`

It is a JSON array. Default: `[]`.

Example shape (documentation only; do not commit a real expiring
contract):

```json
[
  {
    "instrumentId": "es_front",
    "conId": 123456789,
    "localSymbol": "ESU6",
    "tradingClass": "ES",
    "exchange": "CME",
    "currency": "USD"
  }
]
```

Rules:

- `instrumentId` must exist in `InstrumentRegistry`;
- `conId` must be a positive safe integer;
- `localSymbol`, `tradingClass`, `exchange`, and `currency` must be
  non-empty canonical strings;
- `brokerSymbol`, broker, exchange, currency, and trading class must
  agree with the logical registry definition;
- duplicate `instrumentId` or duplicate `conId` is a startup error;
- malformed JSON or a contradictory binding is a startup error;
- an empty array is valid and keeps the stack inactive;
- never log the raw environment string.

Docker Compose must forward the same value to all three services.

### 3.3 Shared pure authority

Add a pure module under `packages/shared/src/instruments/` with:

- `InstrumentBinding`;
- `BoundInstrument`;
- `InstrumentBindingAuthority`;
- a pure input parser/validator that does not read `process.env`.

The authority is constructed from an `InstrumentRegistry` plus parsed
bindings. It must:

- validate all invariants eagerly;
- expose exact lookup by `instrumentId`;
- return deeply immutable values;
- never fall back from `instrumentId` to a symbol lookup;
- never choose a futures contract itself;
- expose only safe diagnostics (configured IDs and validation errors),
  not the raw config payload.

`BoundInstrument` must contain the logical instrument plus exact broker
identity, including at least:

- `instrumentId`;
- `broker`;
- `brokerSymbol`;
- `conId`;
- `localSymbol`;
- `tradingClass`;
- `exchange`;
- `currency`.

Broker-verified `minTick` belongs to the verified runtime result, not to
an expiring seed definition.

### 3.4 No automatic roll in PR15.2

PR15.2 implements explicit operator binding only.

It must not:

- discover a front month from a root symbol;
- select the first `contractDetails` response;
- infer a roll from calendar, volume, open interest, or expiry;
- change bindings while a process is running.

A contract roll is an explicit config change plus service restart. The
future automated roll adapter is a separate PR.

## 4. Implementation scope

### 4.1 Shared package

Add the binding types, parser, authority, exports, and unit tests under:

- `packages/shared/src/instruments/`;
- `packages/shared/src/index.ts`.

Required tests:

- valid exact binding;
- empty binding set;
- unknown `instrumentId`;
- malformed/unsafe `conId`;
- duplicate ID;
- duplicate `conId`;
- exchange/currency/trading-class mismatch;
- case normalization rules;
- immutable returned binding;
- no symbol fallback;
- no mutation of the base registry.

Do not make `InstrumentRegistry` perform I/O.

### 4.2 Ingestion

Integrate the authority without replacing the existing legacy
watchlist:

- add configured, `monitoringEnabled` bound instruments to the
  ingestion watchlist;
- deduplicate them by exact `conId`;
- resolve IBKR details by the configured `conId`, never by root symbol;
- require exactly one matching contract;
- verify returned `conId`, symbol, exchange, currency, local symbol, and
  trading class against the configured binding;
- fail closed for that bound instrument on missing or mismatched
  details;
- persist the existing `instrument_contracts` contract snapshot and
  publish Redis market state under the verified `conId`;
- expose `instrumentId` and binding verification state in the read-only
  `/watchlist` response.

The legacy watchlist must continue working. PR15.2 must not silently
replace the stock universe with the six registry seeds.

No ambiguous `firstDetails` fallback is allowed for a configured
binding.

### 4.3 Signal-engine

Replace symbol-derived identity on the Phase 2 runtime path with the
binding authority:

- market-data lookup starts from `instrumentId` and the configured exact
  `conId`;
- if a matching `instrument_contracts` record is consulted, all
  available identity fields must agree; a symbol-only match is
  insufficient;
- Redis payload `conid` and symbol must still match;
- missing/stale/mismatched binding returns a fail-closed runtime outcome;
- trading-loop reconciliation receives the bound `conId`;
- exposure reads use the logical `instrumentId` plus exact broker
  identity;
- `ExecutionTicketBuilder` receives a bound instrument view so the
  resulting ticket contains the exact `conId`, local symbol, and trading
  class;
- the loop must never mutate the frozen registry instrument.

Add a stable blocker/reason for binding failure, for example
`INSTRUMENT_BINDING_UNAVAILABLE`, and surface it in dry-run/loop
diagnostics without leaking raw configuration.

Keep existing cache semantics only if the cache key includes the
authoritative identity. A cached symbol-only result must not survive a
binding change.

### 4.4 Wire contract

Carry logical identity across the existing adapter:

- add `instrumentId` to the legacy `SignalTicket` shape used by the
  Phase 2 endpoint;
- `toLegacySignalTicket()` must map it from `ExecutionTicket`;
- `POST /execution/execute-ticket` must require it for this endpoint;
- keep `allowCrossContractExposure`, `executionEnabled`, and all other
  server policy fields out of the public request schema.

Update client-order hashing if necessary so the authoritative
`instrumentId + conId` identity is covered. Preserve replay semantics:
same client order ID with a different binding must conflict and must not
dispatch.

### 4.5 Execution-engine

Construct its own `InstrumentBindingAuthority` from the shared registry
and local parsed config. Do not trust the signal-engine's claim.

Before any new Phase 2 ticket is persisted, marked, planned, or sent:

1. require `instrumentId`;
2. resolve it through the server authority;
3. require exact match of ticket symbol and `conid`;
4. reject if the registry instrument has
   `trading.executionEnabled=false`;
5. resolve `allowCrossContractExposure` from
   `Instrument.executionPolicy?.allowCrossContractExposure ?? false`;
6. resolve allowed order type from trusted registry policy; absence or
   mismatch is fail-closed;
7. pass only the resolved server policy into the atomic exposure guard.

Remove `SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE` as the production authority
for bound Phase 2 tickets. A legacy proposal without `instrumentId`
continues to use `false`.

Persist `instrument_id` on new `proposed_orders` rows:

- add a versioned migration under `infra/sql/migrations/`;
- column is nullable for legacy rows;
- new `/execution/execute-ticket` rows require it;
- include it in the Phase B atomic identity re-check;
- include it in resume/hash verification;
- do not backfill by symbol because that inference is ambiguous.

Broker contract preparation for a bound ticket must use the exact
server-resolved `conId`. It must not fall back to a root-symbol
`contractDetails` lookup. A broker lookup failure or identity mismatch
must leave zero durable submission marker/plan and cause zero
`ib.placeOrder` calls.

### 4.6 Configuration and documentation

Update:

- `.env.example`;
- `docker-compose.yml`;
- `docs/architecture/INSTRUMENT_REGISTRY.md`;
- `docs/architecture/MARKET_DATA_RUNTIME.md`;
- `docs/architecture/TRADING_LOOP.md`;
- `docs/implementation/phase2/CONFIGURATION.md`;
- `docs/implementation/phase2/PHASE_2_ROADMAP.md`.

Document:

- exact JSON contract;
- operator workflow for pinning and changing a binding;
- restart requirement;
- fail-closed behavior;
- safe inspection commands;
- explicit absence of automatic roll;
- PR15.2 remains inactive until PR15.3.

Do not put a real current `conId`, token, or account ID in committed
files.

## 5. Compatibility

- Keep the legacy signal proposal and
  `/execution/execute-proposed/:id` flow operational.
- Existing `proposed_orders.instrument` and `conid` columns remain.
- Existing rows with `instrument_id IS NULL` remain readable and
  reconcilable.
- Existing ingestion watchlist remains additive and unchanged unless an
  exact bound instrument overlaps it.
- Do not change IBKR account/environment guards, kill-switches,
  reconciliation semantics, or submission retry semantics.
- Do not change strategy implementations or add a strategy.

## 6. Acceptance criteria

### Shared authority

- A valid configured `instrumentId` resolves to one frozen exact binding.
- Every ambiguous, duplicate, unknown, malformed, or contradictory
  binding fails before runtime starts.
- No component derives a bound futures contract from root symbol alone.

### Ingestion and market data

- A configured binding requests IBKR contract details by exact `conId`.
- A mismatch produces no subscription for that binding.
- `/watchlist` reports logical and exact identities read-only.
- Signal runtime consumes the same exact `conId`.

### Execution boundary

- Missing `instrumentId` on `/execution/execute-ticket` is rejected.
- Unknown instrument, unbound instrument, symbol mismatch, `conId`
  mismatch, disabled instrument, missing policy, and disallowed order
  type are rejected before repository mutation and broker dispatch.
- Caller-supplied `allowCrossContractExposure` is still ignored/stripped.
- The server uses registry policy only.
- Identity mismatch on replay/resume produces a conflict and zero second
  broker calls.
- New durable Phase 2 proposals carry `instrument_id`.
- Legacy null-`instrument_id` proposals retain safe compatibility.

### Safety

- All six seed definitions still have
  `trading.executionEnabled=false`.
- `TRADING_LOOP_ENABLED=false` remains the default.
- `EXECUTION_RUNTIME_ENABLED=false` remains the default.
- No Paper or Live order is submitted during implementation or tests.
- No test calls a real IBKR endpoint.

## 7. Required tests

At minimum:

- shared authority/parser unit tests;
- ingestion exact-conId verification tests, including multi-result and
  mismatch refusal;
- signal resolver and market-reader tests for exact binding, missing
  binding, mismatch, and binding change;
- ticket mapper/schema tests proving `instrumentId` propagation and
  caller policy stripping;
- execution service tests proving every binding/policy rejection occurs
  before repository and broker calls;
- PostgreSQL integration tests for migration, `instrument_id`
  persistence, atomic identity mismatch, replay, and legacy-null
  compatibility;
- composition/wiring test proving production submission uses the
  authority rather than a test-only adapter;
- regression test that all seed instruments remain disabled.

Use fakes only at the IBKR port. Do not weaken production checks to make
fixtures convenient.

## 8. Verification gates

Run and report:

```bash
pnpm lint
pnpm typecheck
pnpm test
TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/ikbr_trader \
  pnpm test:integration
pnpm build
git diff --check
```

If the local PostgreSQL port is occupied, use the repository's dynamic
integration-test fixture; do not stop the user's running stack merely to
free a hardcoded port.

Also run targeted package tests while iterating:

```bash
pnpm --filter @ikbr/shared test
pnpm --filter @ikbr/ingestion test
pnpm --filter @ikbr/signal-engine test
pnpm --filter @ikbr/execution-engine test
```

## 9. Hostile review checklist

Before declaring completion, search for and inspect:

- every `ib.placeOrder` call;
- every `POST /execution/execute-ticket` caller;
- every conversion between `ExecutionTicket` and `SignalTicket`;
- every use of `ticket.instrument`, `ticket.conid`, and
  `instrumentId`;
- every symbol-only contract lookup;
- every `firstDetails` selection;
- every production use of `allowCrossContractExposure`;
- every insert/resume path for `proposed_orders`;
- every seed `executionEnabled` value;
- accidental logs of `INSTRUMENT_BINDINGS_JSON`.

Explicitly prove:

- a caller cannot select server policy;
- a caller cannot pair one registry ID with another contract;
- an unbound or disabled instrument cannot create durable submission
  state;
- a configured futures binding never falls back to root-symbol
  resolution;
- no alternate submission path bypasses the authority.

## 10. Deliverables

- implementation and tests;
- versioned SQL migration;
- updated configuration/docs;
- `docs/implementation/phase2/PR15_2_REPORT.md` with:
  - delivered behavior;
  - migration/compatibility notes;
  - exact verification counts;
  - hostile-review evidence;
  - explicit no-order/no-activation confirmation;
  - rollback instructions;
- one focused PR/commit, excluding unrelated workspace changes.

## 11. Explicit exclusions

- changing any seed to `executionEnabled=true`;
- real Paper E2E (PR15.3);
- Live trading or live-readiness;
- automated futures roll selection;
- hot reload of bindings;
- multi-contract spreads or concurrent cross-contract exposure;
- position exits (PR16);
- strategy changes;
- broad replacement of the legacy ingestion watchlist;
- unrelated cleanup.
