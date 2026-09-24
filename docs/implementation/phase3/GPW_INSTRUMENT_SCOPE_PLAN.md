# GPW — instrument-scoped round-trip acceptance

## Problem and boundary

Owner authorizes testing PKO without closing unrelated SMR. Current entry checks
already distinguish contracts and retain account-wide risk. The read-only final
round-trip evaluator instead requires all account positions flat and all orders
absent. Change that acceptance scope, not trade submission or close behavior.

## Implementation

1. Keep the exact lifecycle proposal, verified account + conId + instrument binding
   as the scope. Completion requires that contract flat in both broker evidence
   and the fresh position snapshot, with no working orders on that contract.
   Do not infer identity from symbols or silently drop missing/malformed identities.
2. Permit correctly identified other-contract positions and working orders on the
   same account, including SMR and its manual sell. Preserve validation of full
   snapshot identity, generation, freshness, completeness and all row identities.
   Keep existing collision checks for reused owned brokerOrderId/orderRef/permId.
3. Label the response explicitly as instrument-scoped and include observed outside-
   scope positions and working-order counts. COMPLETED must not imply the entire
   account is flat. Exclude unrelated fills/fees from PKO P&L using the existing
   exact ownership collector; no market-value/account-P&L substitution.
4. Preserve CLEAN reconciliation, active-hold checks, full source coverage,
   current session, original AI/risk, one-share proof, durable window/day budget,
   account-wide cash/exposure caps and all broker write paths. Unrelated ambiguity
   or holds may still block; this is not a blanket exemption from reconciliation.
5. Update the GPW runbook and AGENTS current-scope note. Record existing preflight
   flat-account restriction as superseded without rewriting historical evidence.
   No SMR close/cancel, no deployment, no .env modification or trading activation.

## Acceptance and validation

- Unit: completed PKO cycle with SMR long/short, outstanding SMR sell and unrelated
  fills leaves PKO amounts unchanged; output identifies outside-scope activity.
- Negative: residual PKO quantity, PKO working orders, missing/invalid contract or
  account identity, owned-ID collision on another contract, stale/incomplete/wrong-
  session snapshots, holds and non-CLEAN reconciliation remain NOT_PROVEN.
- PostgreSQL collector: persist target round trip plus SMR position/order/fill/fees,
  read through the actual collector, prove PKO-only accounting and no DB mutation.
  Test the SMR-to-flat state after its independent sell without changing PKO totals.
- Route response exposes scope; regression checks prove account-wide risk still
  rejects excess exposure including SMR. No new strategy or backtest behavior.
- Independent plan ACCEPT before implementation; a different implementation
  reviewer ACCEPT afterward. Full lint/typecheck/unit/integration/build checks,
  report, explicit staging, commit/push on main and exact-commit GitHub CI.
- Preserve the 29 unrelated dirty research files and local operational settings.
