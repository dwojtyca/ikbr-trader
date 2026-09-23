# GPW2A — PLN lifecycle foundation

Date: 2026-09-24. Implementation independently ACCEPTED; all local gates passed.
Plan: [GPW2A_PLN_LIFECYCLE_PLAN.md](GPW2A_PLN_LIFECYCLE_PLAN.md).

The existing owned one-share stock full-close path now supports exact WSE/PLN
registry and bound contracts, in addition to USD stocks. Ownership still requires
matching broker account/conId, immutable original proposal, historical AI approval,
complete recent broker evidence and exact fill/leg correlation. Close remains a
single SELL DAY LMT after confirmed protective-order cancellation; unknown outcomes
are fenced against retry. No new cash or FX requirement blocks risk reduction.

Prepared contract currency is compared with the trusted binding. The persisted
close-risk evidence now labels bid/ask and other price values with quoteCurrency.
Wrong prepared currency or exchange and unsupported bindings are rejected.
No schema migration, strategy behavior change, activation or broker write occurred.

## Verification

- Independent plan review: ACCEPT (gpw2a_plan_review).
- 198 targeted ownership and risk/prepared-wire unit tests pass.
- 50 full-close production-service PostgreSQL integration tests pass: identical
  25-case matrix for USD/SMART and PLN/WSE, including concurrent same-key requests,
  unknown dispatch, fill during cancellation, generation races and terminal flat
  reconciliation. Dispatch asserts prepared contract currency/exchange and durable
  risk evidence currency. Test broker remains fake; static ticks are fixture data.
- Execution-engine typecheck passes.
- Independent implementation review: ACCEPT (gpw2a_implementation_review).
  Reviewer independently reran 198 targeted unit tests and inspected the PG matrix.
- Complete local gates passed: pnpm lint (three pre-existing warnings),
  pnpm typecheck, pnpm build, pnpm test (1802 passed), pnpm test:integration
  (909 passed). Both validation amendments independently ACCEPTED.
- GitHub CI: pending commit/push.

## Remaining launch blockers

This is a lifecycle foundation, not GPW Paper readiness. The production catalogue
still contains no enabled stock. GPW2B must replace the approximate WSE tick ladder
with authoritative per-leg price-band rules, verify contract identity without
fallback and implement broker/Warsaw session checks. ib@0.2.9 lacks reqMarketRule,
so a reviewed metadata/adapter solution is required. Static minTick equality in
the current close assessor is deliberately unchanged and is not claimed sufficient
for activation.

GPW3 must finish strategy-price propagation, warmup and one-round-trip budget,
AI context coverage, currency-labelled P&L/fees and the supervised abort/close
runbook. Real-time PKO market data must be verified at launch. The owner manually
prepared positive PLN Paper cash; that operational fact does not replace code or
broker end-to-end acceptance. No profitability claim or strategy tuning is made.

## Validation follow-up

The first full PG run stalled in the pre-existing concurrent reconciliation
runner test. Its late-assigned resolver could lose a release that happened
before capture started. The accepted test-only amendment replaces sleeps with
explicit barriers, handles early runner failure and guarantees release/await
before database teardown. Seven targeted runner PG tests pass. Production
runner logic is unchanged. The first unprivileged full unit invocation also
stalled in localhost fixture startup; the rerun with local-network permissions
passed. Final gate results below use the corrected test and appropriate access.
