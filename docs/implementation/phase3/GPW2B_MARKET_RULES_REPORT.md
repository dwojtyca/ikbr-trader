# GPW2B — broker market rules and Warsaw sessions

Date: 2026-09-24. Independent plan and implementation reviews accepted; all local gates passed.
Plan: [GPW2B_MARKET_RULES_PLAN.md](GPW2B_MARKET_RULES_PLAN.md).

An isolated pinned @stoqey/ib1.6.10 read-only connection fetches exact contract
identity, exchange-specific market-rule bands and broker liquidHours. The
existing ib@0.2.9 execution socket remains in use. Metadata is account-bound,
immutable, timeout-bounded and never sourced from caller HTTP fields. Missing
or ambiguous data fails closed. A dedicated unused IB_METADATA_CLIENT_ID is
required (default119); connections are lazy, serialized and closed after reads.

Each WSE price uses its own authoritative band, with no approved-price rounding
or minTick heuristic. Broker dated sessions are intersected with an application
window 09:05–16:45 Europe/Warsaw on weekdays. CLOSED/missing dates, malformed
schedules and DST-ambiguous timestamps refuse execution. This conservative
window is a policy restriction, not a complete exchange phase calendar.

Entry risk records rules/sessions and caps atomic claim expiry at metadata/session
expiry. WSE full-close preflights risk before protective cancellations, then keeps
all later risk/ownership/generation checks. Metadata/generation and the exact
prepared wire are rechecked before dispatch. Known WSE direct/unbound paths and
legacy WSE price-ladder fallback refuse submission. No cancellation permission
was removed. Session crossing after cancellation remains an operator/reconciliation
condition, not authorization for a blind close retry.

PKO pko_wse is added with pinned conId35146360/localSymbolPKO, all four activity
flags false, no executionPolicy. Binding configuration cannot override pinned
identity. No trading configuration, deployment, strategy or P&L changes.

## Verification

- Independent plan review ACCEPT after close-preflight and timestamp clarifications.
- Metadata/provider pure tests:60 pass. TWS prepare/dispatch:18 pass.
- Targeted production-service PG tests:77 pass, including blocked WSE preflight
  with zero protective cancellations and durable metadata on approved dispatch.
- PG fake risk adapters evaluate real validators in a fixed open Warsaw session
  and translate only expiry duration to DB wallclock. Pure/TWS tests exercise
  actual session/expiry boundaries directly. PG results are not real broker E2E.
- Independent implementation review: ACCEPT, no blockers; reviewer independently
  ran 245 risk/metadata/provider/TWS tests and reran 18 TWS tests after the final
  immutable-metadata/fingerprint hardening.
- Full local gates PASS: pnpm lint (0 errors, 3 existing warnings), pnpm
  typecheck, pnpm test, pnpm test:integration, pnpm build. Integration totals:
  execution 988/988, backtest 18/18, AI worker 7/7; no skipped tests.
- All 29 pre-existing unrelated research files retain their original hashes.
- Commit/push and exact GitHub CI: pending.

## Actual read-only Gateway evidence

The new provider successfully read PKO (conId35146360) from the same Paper
Gateway/account used by the existing adapter. IBKR returned marketRuleId1874,
19 price bands and timezone Europe/Warsaw. Examples: [50,100) increment0.01,
[100,200) increment0.02, [200,500) increment0.05. The returned dated liquidHours
covered 2026-09-24 through 2026-09-29, with 26/27 September CLOSED. These are
observed evidence, not pinned values: production requests current metadata.
No order/cancel/FX mutation or paid AI request was performed.

## Remaining launch gate

GPW3 must implement strategy-price propagation, required history warmup,
one-round-trip budget, honest AI context coverage and currency-labelled P&L/fees
with supervised exit/reconcile/abort. The first Paper trade remains separately
authorized after real-time PKO quotes, runtime account allowlist and operational
preflight pass. GPW2B does not make the bot launch-ready or prove profitability.
