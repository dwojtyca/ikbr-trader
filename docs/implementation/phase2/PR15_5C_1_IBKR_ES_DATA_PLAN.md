# PR15.5C.1 — IBKR ES source parity and immutable dataset acquisition — IMPLEMENTATION PLAN (r1)

Status: complete; Stage B acquired, validated, and imported; READY for PR15.5D

Date: 2026-09-16

## 1. Goal

Acquire a real, immutable, reproducible ES research dataset from the same
provider that supplies future live trading data: the IBKR TWS API. The result
must be a finalized PR15.5C bundle and isolated PostgreSQL dataset with a
verified `provenanceId + fingerprint`.

This PR also closes the known candle-source semantic gap for future ES use:
locally aggregated `reqMktData` ticks may remain useful for current price,
bid/ask, spread, and provisional observability, but a completed ES minute used
by signal logic must be confirmed from IBKR's native `1 min / TRADES` history.

PR15.5C.1 does not run the PR15.5D strategy experiment, add `FUT` to a
strategy, enable ES, submit an order, or perform Paper E2E.

## 2. Confirmed baseline and decision

- PR15.5C shipped as `5de9de6`; CI run `35064103236` is green.
- PR15.5C accepts an immutable local `manifest.json` plus
  `candles-1m.ndjson`, validates it, fingerprints it, and imports it into the
  exact isolated research database.
- The current backtest historical client already requests IBKR native
  `1 min / TRADES` bars, but it does not implement a strict expired-ES
  acquisition contract or emit a PR15.5C bundle.
- Current ingestion backfill uses native IBKR historical bars, while live 1m
  candles are built locally from `reqMktData` events and local receive time.
- IBKR documents that expired futures history is normally available only for
  approximately two years after expiration. A four-year 2022–2025 source is
  therefore not a valid target in September 2026.

The selected source is exclusively IBKR. No Databento or other market-data
provider is introduced.

### 2.1 Stage A operational result — 2026-09-16

The Paper Gateway accepted the read-only API connection on `127.0.0.1:4002`.
Exact `reqContractDetails` inventory returned IBKR error 200 for `ESH5` and
`ESM5`, including requests narrowed by their exact expiry and a follow-up
attempt by an archived `ESM5` conId. The same connection and request shape
resolved the remaining universe:

| localSymbol | conId | expiry | result |
| --- | ---: | --- | --- |
| ESH5 | — | — | IBKR 200 / unavailable |
| ESM5 | — | — | IBKR 200 / unavailable |
| ESU5 | 637533641 | 20250919 | resolved |
| ESZ5 | 495512563 | 20251219 | resolved |
| ESH6 | 649180695 | 20260320 | resolved |
| ESM6 | 649180678 | 20260618 | resolved |
| ESU6 | 649180671 | 20260918 | resolved |

The inventory therefore failed closed and did not create
`PR15_5C_1_IBKR_ACQUISITION_SPEC.json`. At that point Stage B was blocked and
continuing required a separately approved plan correction: either shorten the
research window to the IBKR-retained universe or provide an IBKR-verifiable
archival path for both missing contracts.

### 2.2 Approved retained-universe correction — 2026-09-16

The operator approved shortening the source contract to the five contracts
that the same IBKR Gateway still resolves exactly:

```text
ESU5, ESZ5, ESH6, ESM6, ESU6
```

The corrected target begins at `2025-06-22T22:00:00.000Z`, approximately
three months before ESU5 expiry, so the dataset has enough ESU5 history to
measure the first included volume crossover into ESZ5. The target end,
request tuple, roll policy, calendar, pacing and all safety gates remain
unchanged. ESH5 and ESM5 are excluded rather than substituted or fabricated.

## 3. Frozen IBKR data contract

Every time-series request used to construct the bundle must use:

```text
provider         = IBKR TWS API
secType          = FUT
symbol           = ES
tradingClass     = ES
exchange         = CME
currency         = USD
multiplier       = 50
includeExpired   = true
barSize          = 1 min
whatToShow       = TRADES
useRTH           = 0
formatDate       = 2
keepUpToDate     = false
```

Each request must additionally contain one approved positive `conId`, its
matching `localSymbol`, and the IBKR expiry discriminator. Request end times
must be explicit UTC strings in IBKR's `yyyyMMdd-HH:mm:ss` format. Machine
local time must not affect a request or parsed candle timestamp.

Forbidden acquisition paths:

- `CONTFUT` or another continuous/synthetic IBKR contract;
- generic `ES` resolution followed by selecting the first response;
- a request without `conId`, `localSymbol`, `tradingClass`, or
  `includeExpired=true`;
- `MIDPOINT`, `BID`, `ASK`, delayed chart scraping, or locally manufactured
  historical OHLCV;
- mixing bars from another provider to fill IBKR gaps;
- silently accepting an IBKR contract-detail response that differs from the
  approved tuple.

The source artifact version must record the acquisition-tool version, IB API
server version, exact request parameters, request windows, contract inventory,
and per-response checksums. Account identifiers and credentials must not be
written into the bundle or report.

## 4. Target range and contract universe

The target closed interval is:

```text
dateFrom = 2025-06-22T22:00:00.000Z
dateTo   = 2026-08-31T20:59:00.000Z
```

The planned quarterly outright universe is:

```text
ESU5, ESZ5, ESH6, ESM6, ESU6
```

Exact `conId`, dated expiry discriminator, min tick, multiplier, exchange,
currency, and trading class must be resolved from IBKR and written into an
operator-reviewable acquisition specification before any multi-month bar
request starts. Zero or multiple matches for a local symbol fail closed.

The installed `ib@0.2.9` decoder exposes the broker's dated expiry as
`summary.expiry` but does not expose IBKR's newer `realExpirationDate` or an
exact last-trade timestamp. The specification therefore records the expiry
with source `ibkr-summary-expiry` and derives `lastTradeAt` under the separately
versioned, reviewable rule `cme-es-quarterly-termination-0830-ct-v1`. It must
not describe that derived timestamp as broker-resolved metadata.

The acquisition specification is a committed metadata artifact; price and
volume data are not committed. It must pin all five contracts and may not be
changed after the first accepted time-series response without creating a new
source version.

Dataset sufficiency requires all of the following:

- complete consecutive coverage of the approved target range from
  `2025-06-22T22:00:00.000Z` through `2026-08-31T20:59:00.000Z` after session
  validation;
- all five retained quarterly contracts pinned before any bar download;
- all four possible completed roll transitions in the five-contract universe;
- no entirely missing open CME session;
- at least 99.9% of selected-contract open-session minutes present, with every
  gap of more than five consecutive open minutes explicitly explained in the
  acquisition report rather than filled;
- complete coverage of every calendar closure and early close within the
  accepted range.

Failure to meet any threshold produces `INCONCLUSIVE`; it must not be repaired
with a different source under this plan.

Stage A completed successfully after the retained-universe correction. The
generated specification is
`docs/implementation/phase2/PR15_5C_1_IBKR_ACQUISITION_SPEC.json`. After the
approved v2 roll-policy correction its SHA-256 is
`e39a59790324186f3665d1d2a287bf7c6ae9d794337ac7b1801f942fe658e8af`, while
the deterministic estimate remains 102 historical-data requests. Independent
review approved the amended specification, and Stage B completed successfully.

## 5. Contract inventory gate

Acquisition has two explicit stages.

### Stage A — inventory only

For each predeclared local symbol, request contract details and require exactly
one response matching the frozen tuple. Produce an acquisition specification
containing public contract metadata and the proposed per-contract fetch
windows. This stage performs no multi-month historical-bar request.

The specification and estimated request count must be reviewed before Stage B.
This is the final opportunity to shorten the range because of IBKR's expired
contract availability.

### Stage B — bar acquisition

Only the approved specification may drive time-series requests. The CLI must
print the exact database target, bundle directory, range, contracts, expected
request count, and pacing configuration, then require an explicit
`--execute-approved-spec` flag. A dry run is the default.

Stage B is read-only with respect to IBKR. It never places, modifies, or
cancels an order and never automates the IBKR UI.

Stage B runs in an exclusive historical-acquisition window: `TRADING_ENABLED`
remains false, ingestion is stopped, and no other project process may issue
IBKR historical requests. This makes the account-wide pacing budget
enforceable without pretending that per-process counters coordinate across
client IDs. Live final-bar confirmation is tested in this PR but does not run
during acquisition.

## 6. Roll policy

The versioned policy is
`ibkr-es-volume-crossover-next-session-v2`.

- Fetch overlapping outgoing and incoming quarterly contracts around each
  transition.
- Sum only validated IBKR `TRADES` 1m volume within each completed CME trading
  session and contract.
- A crossover is eligible only inside the 15 calendar days preceding the
  outgoing contract's last-trade date.
- The roll decision occurs after the first completed session in which the
  incoming contract's volume strictly exceeds the outgoing contract's volume.
- The incoming contract becomes valid at the next CME session open. Using the
  completed session and switching on the next session prevents look-ahead.
- Search the full approved 15-calendar-day window through the final completed
  session whose close is not later than `lastTradeAt`. If no crossover occurs
  in that window, acquisition fails closed. There is no inferred or forced
  fallback roll in v2.
- The final explicit `validFrom`, `validTo`, and `rollAt` timestamps are stored
  in the manifest and therefore covered by the dataset fingerprint.

No back-adjustment, ratio adjustment, forward fill, or synthetic candle is
allowed. Raw overlapping contract bars remain attributed to their real
`conId`; the later loader selects the contract whose validity interval covers
the requested minute.

## 7. Calendar and session contract

The bundle uses the PR15.5B CME equity-index session model:

```text
template = cme_equity_index
timezone = America/Chicago
calendarVersion = cme-equity-index-2024-2026-v1
```

PR15.5C.1 must add a bounded, versioned calendar definition covering the exact
dataset range, including CME full closures and early closes. The definition is
reviewable configuration, not inferred from missing candles. Every accepted
bar must map to an open session, including DST transitions and the daily
maintenance break.

## 8. Source parity for future live ES

For ES, the canonical closed 1m candle is an IBKR native historical
`TRADES` bar under the frozen request semantics in section 3.

The current `reqMktData` subscription remains the source for current market
state and may continue building a provisional minute. It must not become the
authoritative finalized ES candle used to trigger a strategy.

PR15.5C.1 adds a fail-closed final-bar confirmation path for bound FUT
instruments:

1. when a locally observed minute closes, mark it provisional;
2. after a bounded settlement delay, request the exact completed minute from
   IBKR using the approved contract identity and native `1 min / TRADES`;
3. persist and aggregate only the native bar for strategy history;
4. trigger signals at most once, only after native confirmation;
5. if confirmation is absent, ambiguous, off-grid, outside session, or belongs
   to another contract, persist no canonical FUT candle and trigger no signal;
6. retries are bounded, use the same exact request semantics, and obey the
   account-wide historical pacing budget.

Existing STK/IND ingestion behavior is unchanged. The FUT confirmation path
remains dormant because no active strategy supports FUT and ES remains
disabled. Future activation must require this path rather than permitting a
fallback to provisional candles.

This does not claim byte-for-byte equality between a historical response and
a response obtained months later: IBKR may correct historical data. It does
ensure the same provider, contract identity, bar type, session scope, and
final-candle authority. The immutable bundle freezes the research evidence
against later source revisions.

## 9. Acquisition lifecycle and filesystem safety

The acquisition workspace is local and gitignored. It contains chunk files,
request receipts, and checksums required for resumability. It must never
contain an account ID or API credential.

Lifecycle:

```text
approved specification
  -> acquiring verified chunks
  -> complete source ledger
  -> canonical temporary bundle
  -> PR15.5C validation
  -> atomic rename to finalized bundle
  -> import into new empty research database
  -> PostgreSQL read-back fingerprint verification
```

- Resume may reuse a chunk only when its exact request identity and checksum
  match the approved ledger.
- Conflicting duplicate bars fail closed; identical boundary duplicates may
  be deduplicated deterministically.
- Prices must convert exactly to integer `0.25` ticks. Off-grid prices fail;
  they are never rounded silently.
- Volume must be a non-negative safe integer.
- A partial, timed-out, or rejected acquisition never creates a finalized
  bundle and never mutates the protected research database.
- An existing finalized bundle or database is never overwritten. A new source
  revision requires a new version, directory, and empty exact database.

The current database name `ikbr_trader_backtest_pr15_5a` may be used only if it
does not already exist and contains no prior finalized dataset. Otherwise the
plan must be revised to approve a new exact database name; the importer must
not reset it.

## 10. Error and pacing policy

- Default pacing remains no more than 50 historical requests per rolling ten
  minutes and no more than two concurrent acquisition requests.
- The CLI requires an explicit acknowledgement of the exclusive acquisition
  window and aborts before connecting when it is absent.
- Contract inventory is sequential.
- Known no-data or expired-contract responses, including IBKR codes 162 and
  166 when they indicate unavailable history, are terminal for that exact
  request and are recorded without raw account/session details.
- Only documented transient connectivity/farm interruptions may be retried.
  Retrying never changes the contract or time window.
- Timeout is not success and does not seal a chunk.
- Disconnect during Stage B stops scheduling new requests until the same
  approved session is restored; it never substitutes delayed or another
  market-data type.

## 11. Proposed implementation surface

- `packages/shared/src/ibkr-bar-source.ts`
  - frozen provider/bar semantics shared by ingestion and research code;
  - pure validation only, no socket client.
- `apps/backtest-engine/src/ibkr-es-acquisition-spec.ts`
  - strict acquisition specification and contract/interval validation.
- `apps/backtest-engine/src/ibkr-es-acquirer.ts`
  - explicit contract inventory, paced chunk acquisition, source ledger,
    tick conversion, roll derivation, and atomic bundle materialization.
- `apps/backtest-engine/src/ibkr-es-acquisition-cli.ts`
  - separate `inventory`, `dry-run`, and explicit execution modes.
- `apps/backtest-engine/src/historical-client.ts`
  - exact expired-contract fields, UTC request formatting, safe error
    classification, and injectable request/event seam for tests.
- `apps/ingestion/src/tws-client.ts` and a focused final-bar helper
  - FUT-only native closed-bar confirmation without altering current STK/IND
    semantics.
- `apps/ingestion/src/index.ts`
  - FUT provisional/native routing and trigger-after-confirmation wiring.
- bounded CME calendar configuration for 2024–2026;
- package scripts, `.env.example`, `.gitignore`, and Docker configuration only
  where required;
- `docs/implementation/phase2/PR15_5C_1_IBKR_ACQUISITION_SPEC.json`
  after Stage A inventory;
- `docs/implementation/phase2/PR15_5C_1_REPORT.md` after implementation and
  the operational result.

No broker dependency enters strategy code.

## 12. Tests and acceptance criteria

Unit tests must prove:

- the exact request tuple and UTC end-time formatting;
- `includeExpired=true` and explicit identity are mandatory;
- zero, one, and multiple contract-detail responses behave fail-closed;
- a response with substituted conId/local symbol/trading class/multiplier/tick
  is rejected;
- parent/continuous/generic ES contracts are rejected;
- chunk boundaries, identical duplicates, conflicting duplicates, ordering,
  checksum resume, and atomic finalization;
- exact integer-tick conversion and off-grid rejection;
- volume crossover uses completed sessions only and rolls at the next session;
- no-crossover, calendar gap, missing contract, unavailable expired history,
  and insufficient coverage return `INCONCLUSIVE` rather than inventing data;
- secrets and account IDs never enter manifests, receipts, logs, or errors;
- FUT local candles remain provisional, native bars become authoritative, and
  signals fire once only after confirmation;
- absent/mismatched native confirmation produces no FUT signal;
- STK/IND candle and trigger behavior remains unchanged.

Integration tests must use fake IB event ports and disposable PostgreSQL. They
must prove:

- inventory performs no bar request;
- dry-run performs no socket request and no filesystem/database mutation;
- a synthetic multi-contract IB response produces a bundle accepted by the
  existing PR15.5C importer;
- interruption and resume yield the same bundle fingerprint as an uninterrupted
  acquisition;
- a partial/failing acquisition cannot create a finalized bundle or database
  rows;
- a finalized real bundle, when operational Stage B succeeds, imports into an
  empty isolated database and its PostgreSQL read-back fingerprint matches;
- existing protected-dataset immutability remains effective;
- no order-related IB method is called in any acquisition or parity test.

Operational evidence, which is deliberately not a CI test, must record:

- TWS/IB Gateway server version without credentials or account ID;
- approved contract inventory and exact range;
- request count, completed/missing chunks, and pacing events;
- candle count per conId, session gaps, roll transitions, source checksum,
  provenance ID, and final fingerprint;
- an explicit `READY` or `INCONCLUSIVE` dataset verdict.

## 13. Required gates

```text
pnpm --filter @ikbr/shared test
pnpm --filter @ikbr/ingestion test
pnpm --filter @ikbr/backtest-engine test
pnpm --filter @ikbr/backtest-engine test:integration
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm test:integration
git diff --check
```

No strategy backtest is run in this PR.

## 14. Independent hostile review

The independent reviewer must specifically attack:

- generic/first-result/continuous-contract substitution;
- missing `includeExpired`, wrong contract month, conId reuse, and ambiguous
  contract details;
- local-time/DST request drift and inclusive/exclusive chunk boundaries;
- pacing bypass through retries or live confirmation requests;
- partial bundles, unsafe resume, source changes between chunks, and accidental
  overwrite of finalized artifacts;
- float-to-tick rounding, conflicting duplicates, gaps, roll look-ahead, and
  post-expiry bars;
- provisional live candles reaching strategy history or triggering a signal;
- STK/IND regression caused by FUT-only routing;
- credential/account leakage and any order-capable broker call;
- claims of readiness unsupported by a real finalized fingerprint.

All blockers must be fixed and review repeated before the report can be
completed.

## 15. Explicit exclusions and safety state

PR15.5C.1 must not:

- add `FUT` to `momentum_breakout_long_v1` or another active strategy;
- enable ES in any production or Paper profile;
- run the PR15.5D compatibility experiment or publish performance metrics;
- submit, modify, cancel, or simulate a broker order;
- automate TWS or IB Gateway UI/login;
- use `CONTFUT`, silently force a roll, back-adjust prices, or fill a gap from
  another provider;
- commit real IBKR price/volume files or credentials;
- reset or mutate the shared `ikbr_trader_backtest` database;
- mark PR15.5, Paper E2E, or Live Trading ready.

`TRADING_ENABLED=false` and ES `executionEnabled=false` remain mandatory.

## 16. Definition of done and next step

PR15.5C.1 implementation is complete only when:

- the exact IBKR request, inventory, range, calendar, and roll contracts above
  are implemented without relaxation;
- all automated gates pass;
- independent hostile review returns `APPROVED`;
- Stage A produces an approved exact contract specification;
- Stage B either produces and imports a real immutable bundle with matching
  read-back fingerprint or records a terminal `INCONCLUSIVE` with exact IBKR
  availability evidence;
- the report records source parity limitations without claiming byte-for-byte
  equality across acquisition dates;
- no strategy, Paper, or Live activation occurs.

Only a `READY` real IBKR dataset with a verified `provenanceId + fingerprint`
permits preparation of PR15.5D. An `INCONCLUSIVE` result keeps PR15.5D blocked
and requires an explicit owner decision before considering a different data
source or a shorter experiment.

After this plan is approved, implement only PR15.5C.1 and stop after its
report. Do not begin PR15.5D under this approval.
