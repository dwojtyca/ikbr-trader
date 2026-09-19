# PR15.5E — Deterministic mechanical backtest E2E — PLAN

Status: owner approved; implementation and verification complete

Date: 2026-09-18

## 1. Goal

Prove that the compiled backtest path works end to end when a strategy emits
known futures signals. This phase tests mechanism, not alpha:

`scripted research strategy -> SignalEngine -> deterministic risk sizing ->`
`proposed order -> next-bar fill -> bracket/lifecycle exit -> PostgreSQL ->`
`scenario metrics -> deterministic reproduction`.

PR15.5D.3 already proved the real IBKR dataset, active-contract projection,
timeframe aggregation, regime/strategy rejection path, parallel workers, and
terminal artifact handling. It produced no signals, so it could not prove the
hot transactional path. PR15.5E closes only that evidence gap.

Passing PR15.5E will validate the backtest mechanism. It will not validate
IBKR Paper order submission, reconciliation, or broker behavior; those remain
part of the later controlled Paper E2E phase.

## 2. Safety and scope boundaries

- use a small synthetic dataset in a disposable PostgreSQL database;
- use a research/test-only scripted strategy that is absent from the
  production strategy registry and all bot profiles;
- do not read or mutate the immutable PR15.5C.1 research database;
- do not connect to IBKR, execution-engine, ingestion, LLM, Paper, or Live;
- do not change production strategy parameters, Risk Engine rules, simulator
  economics, calendar rules, or PR15.5D.3 evidence;
- inject signals only through the existing `strategyFactory` seam; do not
  insert orders or fills directly;
- exercise the real repository schema and public simulator `run()` method;
- no new operational HTTP route and no long-running Stage B experiment.

## 3. Frozen fixture contract

Add a versioned fixture manifest
`PR15_5E_MECHANICAL_FIXTURE.json` with schema
`pr15.5e-mechanical-fixture-v1` and a golden SHA-256. The manifest freezes:

- ordered 1-minute candles and their expected higher-timeframe visibility;
- three synthetic ES contract identities and explicit transition timestamps;
- ES multiplier `50` and tick size `0.25`;
- primary economics: USD 2.50 commission per contract per side and one tick
  adverse slippage;
- stress economics: USD 3.50 commission per contract per side and two ticks
  adverse slippage;
- account equity, risk percentage, exposure/notional caps, and stop distances
  selected so every accepted entry sizes to exactly one whole contract;
- exact scripted signal timestamps, conIds, side, MKT entry, stop, target, and
  expected exit reason;
- exact expected orders, fills, reference/fill prices, commissions, slippage
  cost, gross/net P&L, lifecycle counts, and terminal aggregate metrics for
  primary and stress;
- expected primary reproduction hash.

The fixture generator must calculate and validate the expected arithmetic
from independently small pure helpers. The simulator output must be compared
with committed literal expectations; it must not use simulator output to
generate or update its own oracle.

## 4. Required episodes

The single chronological fixture contains isolated episodes with sufficient
flat candles between them to avoid cooldown or position overlap:

1. **Take-profit** — one long MKT entry fills on the next candle and exits at
   an explicitly touched target on a later candle.
2. **Stop-loss** — one long MKT entry exits through an explicitly touched
   stop with adverse exit slippage.
3. **Same-bar collision** — both stop and target are touched after the entry;
   the stop must win and exactly one closing fill may exist.
4. **Contract roll** — an open outgoing-contract position closes using the
   outgoing contract's last price, never the incoming contract's price;
   pending outgoing intent is cancelled and the exit reason is
   `contract_roll`.
5. **Expiry** — an open position that reaches `lastTradeAt` closes with exit
   reason `expiry` and adverse market slippage.
6. **Dataset end** — the final open position closes at the last available
   candle with exit reason `dataset_end`.

At least one deliberately rejected signal must also prove that deterministic
risk sizing refuses a quantity below one whole contract without creating an
order or fill. A separate fail-closed fixture must prove that a retired conId
reappearing, post-expiry data, or overlapping conIds aborts before transactional
writes.

## 5. Implementation design

### 5.1 Scripted strategy

Add `research-mechanical-strategy.ts` under backtest-engine. It implements the
existing `Strategy` interface and emits only manifest-declared signals when
the exact symbol, conId, and candle timestamp match. It contains no broker
code, no parameter search, and no fallback signal behavior.

Its ID is test/research-only and must be rejected by assertions if it appears
in `strategy-registry.ts` or `strategy-profiles.ts`.

### 5.2 Fixture loader

Add a strict loader that validates the manifest and creates the disposable
dataset through repository/import boundaries. Unknown fields, duplicate
timestamps, invalid OHLC, bad tick alignment, undeclared conIds, ambiguous
transitions, or an expectation inconsistent with the frozen economics fail
before a run is created.

### 5.3 Runner

Add a test-only mechanical runner that accepts an injected repository and
dataset. It runs sequentially:

- `primary`;
- `stress`;
- `primary_reproduction`.

It creates fresh run state for every scenario. Primary reproduction must match
primary byte-for-byte after excluding database IDs, timestamps, and the stored
scenario label. No scenario may reuse mutable simulator, strategy, portfolio,
or repository state from another scenario.

### 5.4 Durable verification

The PostgreSQL integration test must query the stored rows independently of
the simulator return value and verify:

- exact run/order/fill counts and terminal statuses;
- one whole contract for every accepted entry;
- exact entry/exit reference and fill prices;
- exact two-sided commission, multiplier, tick size, slippage attribution,
  gross P&L, and net P&L;
- exact exit-reason counts for target, stop, collision-as-stop, roll, expiry,
  and dataset end;
- no duplicate close, no cross-conId fill, and no pyramiding;
- zero open positions, pending orders, and unclosed fills;
- unchanged fixture dataset fingerprint;
- exact aggregate metrics and deterministic reproduction hash.

## 6. Test matrix

### Pure/unit tests

- fixture schema and golden hash;
- scripted strategy emits only at exact registered timestamps;
- independent arithmetic oracle for primary and stress;
- primary/stress differences are limited to commission and slippage inputs;
- test strategy cannot enter the production registry/profile;
- malformed worker/runner result or missing episode fails closed.

### PostgreSQL integration

- migrate a newly created disposable database;
- import the frozen fixture;
- execute all three scenarios through `BacktestSimulator.run()`;
- independently query and compare every durable expectation;
- rerun from a fresh database and prove the result hash is identical;
- inject one repository failure and prove the affected run becomes failed,
  with no falsely successful artifact.

### Repository-wide verification

- `pnpm typecheck`;
- `pnpm test`;
- `pnpm test:integration` with PostgreSQL enabled;
- `pnpm build`;
- production Docker image runs the compiled mechanical test once against a
  disposable database;
- independent hostile review focused on oracle independence, forbidden direct
  writes, scenario isolation, and false-positive success paths.

## 7. Acceptance criteria

PR15.5E passes only if:

1. every expected episode traverses the real strategy, signal, risk, order,
   fill, lifecycle, persistence, and metric path;
2. every durable row and aggregate equals the committed literal oracle;
3. stress differs from primary exactly as predicted by its higher commission
   and slippage;
4. primary reproduction is deterministic;
5. all fail-closed fixtures produce zero unauthorized transactional writes;
6. no production registry/profile or real dataset is changed;
7. typecheck, unit tests, PostgreSQL integration, build, compiled-image check,
   and hostile review pass.

Passing these criteria means the backtest transactional mechanism is proven
for the modeled cases. It does not mean any real strategy is profitable or
that Paper/Live broker integration is proven.

## 8. Deliverables

- frozen fixture manifest and hash;
- research-only scripted strategy and strict loader;
- mechanical runner;
- unit and PostgreSQL integration tests;
- compiled-image verification command;
- `PR15_5E_REPORT.md` containing the literal expected/actual table, hashes,
  test results, and hostile-review findings.

## 9. Stop condition

Approval of this plan authorizes implementation and local verification only.
After implementation, stop with the report and review results. Commit, push,
CI, and any subsequent strategy-diagnostic PR15.5F require the owner's next
instruction. No Paper or Live execution is authorized by this plan.
