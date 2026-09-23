# GPW2A — PLN ownership and full-close foundation

Status: ACCEPTED by independent gpw2a_plan_review. Date: 2026-09-24.

## Boundary and rationale

Owner authorized implementation with independent plan acceptance, separate
implementation review, local checks, commit/push on main and GitHub CI.
This is the next bounded PR in the GPW track. Preserve unrelated ES research.
GPW1 added PLN entry valuation but lifecycle remains USD-only. Split GPW2:
GPW2A extends the existing lifecycle; GPW2B supplies authoritative market rules
and sessions. Installed ib@0.2.9 has no reqMarketRule/marketRuleIds support;
its approximate WSE price ladder cannot be called broker-authoritative.
No registry seed, activation, broker order, paid research request or deployment
belongs to this PR. Trading remains disabled. This PR does not deliver Paper
readiness; stop and report at this PR boundary per repository workflow.

## Implementation

1. Extend evaluateLifecycleFacts and assessCloseRisk to accept stocks with
   matching USD currency (existing behavior) OR exact WSE/PLN on BOTH bound
   contract and registry. Refuse mismatches and other currencies/exchanges.
   Keep account/conId/hash/AI approval, one-share LONG ownership, exposure,
   cancellation, generation, freshness and no-retry invariants unchanged.
2. validatePreparedClose must validate supported bound stock scope and match
   actual prepared currency to bound currency (rather than hardcoded USD),
   preserving exact exchange/conId/symbol, immutable ticket, wire and leg checks.
3. Add quoteCurrency to durable close-risk evidence. All price/spread/slippage
   values in that evidence are denominated in this currency. Close reduces
   verified owned exposure; do not require positive cash or FX/account valuation
   as a new close precondition. This is not portfolio P&L reporting.
4. Do not change static tick validation, TWS normalization/session handling,
   strategy behavior, registry/config flags or existing risk defaults. These
   are explicitly incomplete for production PLN activation until GPW2B.

## Verification and acceptance

- Unit ownership: valid WSE/PLN position accepted; bound/registry currency and
  exchange mismatches, unsupported currency and asset class blocked.
- Unit close risk/prepared: valid WSE/PLN SELL accepted with PLN evidence;
  wrong prepared currency/exchange rejected; disabled/unsupported bound rejected;
  the existing hostile risk/wire matrices exercised for both USD and PLN.
- Parameterize the existing production FullCloseService + disposable PostgreSQL
  suite over USD/SMART and PLN/WSE, with matching fixture fill/prepared currency.
  All existing happy path, cancel uncertainty, fill-during-cancel, concurrent
  duplicate, unknown submission, restart/replay, generation/position races,
  prepare mutation and final flat/no-orphan/released reservation checks must
  pass in both variants. Currency is asserted in persisted risk evidence and
  the prepared contract reaching dispatch. No claim of real broker validation.
- No production instrument activation: existing registry/seed tests remain green.
- Independent new implementation reviewer must ACCEPT final diff against plan.
- Run pnpm lint, pnpm typecheck, pnpm test, disposable PostgreSQL
  pnpm test:integration, pnpm build. Existing backtest tests cover unchanged
  strategy behavior; no strategy performance experiment is warranted here.
- Write report with results and remaining GPW2B/GPW3 blockers; commit and push
  only this scope on main, inspect CI for the exact commit, fix failures through
  review/check cycle. Preserve all pre-existing dirty files byte-for-byte.

## Remaining stages

GPW2B: authoritative per-price-band increments for every order leg, strict
broker contract resolution without fallback for metadata-dependent GPW orders,
Warsaw session/calendar checks and revalidation, disabled PKO definition.
GPW3: strategy entry/SL/TP propagation, warmup, one-round-trip budget, honest
AI coverage, currency-labelled P&L/fees and supervised close/reconcile/abort.
Launch still requires these gates and separate operator authorization.

## Accepted validation amendment

Independent gpw2a_plan_review ACCEPTED a test-only repair after the full PG gate
hung in the existing concurrent reconciliation-runner test. Replace 25/50ms
sleeps and a late-assigned no-op resolver with explicit capture-entry and release
barriers. Race entry against early first-run completion/rejection; release and
await first in finally before DB teardown. Prove second returns null while first
holds the advisory lock. Production runner is unchanged. This test fix returns
to independent implementation review before final complete gates.
