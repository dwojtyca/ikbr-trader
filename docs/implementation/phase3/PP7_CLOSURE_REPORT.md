# PP7 closure status, 2026-10-07

**PP7 is not operationally complete. Trading remains disabled.** The normal
scheduler, proposal, AI, risk, bracket and exit paths exist. This delivery adds
three missing source capabilities; it does not record a real Paper entry or exit.
Scope and accepted contracts are in the [closure plan](PP7_CLOSURE_PLAN.md).

## Delivered source capabilities

| Package | Implemented behavior | Evidence |
| --- | --- | --- |
| E1a | Pinned PKO financial PDF extraction, exact statement mapping and bounded worker cleanup | [Report](PP7_E1A_IMPLEMENTATION_REPORT.md); published repair `bc5d6d62b825ee69d8862142401f91badb5b07ff`, exact-commit CI passed |
| E1b | Actual paginated Marketaux news, issuer qualification, two complete acquisition passes, durable budgets and expiry at publication/admission | [Report](PP7_E1B_IMPLEMENTATION_REPORT.md); independent hostile review accepted |
| F1 | Qualified read-only TWS account-day executions/costs, durable source evidence and invalidation before entry dispatch | [Report](PP7_F1_IMPLEMENTATION_REPORT.md); independent hostile review accepted |

The clean combined F1/E1b candidate passed all required local validation.
Source is published as `ddffe1009dae4b5a7d67bb4a0ad86c6d7705c56d`, but its
[exact-commit CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/37598003618)
failed PostgreSQL integration. The reproduced F1 test setup defect and reviewed
fixture-only repair are documented in the F1 report. The repaired candidate
passed all local checks, including 2459/2459 integration tests against the exact CI
base name and controlled cleanup failures. Repair publication and CI remain pending. Full host unit tests
passed 3019 cases with 143 database-dependent skips; lint, typecheck and build
passed. The full isolated PostgreSQL command covers the database-dependent paths.
The first integration attempt found a stale migration list in a legacy-upgrade
test. Adding migration 27 preserved every ownership, AI and daily-budget assertion;
the one-line repair passed independent review. Its complete integration rerun
passed **2459 tests, zero skips and failures**. The clean no-cache Docker rebuild
passed for `ikbr-trader:pp7-closure-verify`. Both package implementations and all
eight release documents passed independent review; all local links resolve. No
strategy/simulator change or new strategy backtest is claimed.

The final Docker image inspection returned
`sha256:1fa16e9ea7f98b9d511800433a528cb3e3206cddb140d84e9c5cfd61fa0117ce`.
The image uses a clean archive of `bc5d6d62b825ee69d8862142401f91badb5b07ff`
plus the reviewed source overlay. All 45 changed runtime/test/configuration file
hashes match the validated copy. Final prose updates are checked separately.

## Readiness and remaining work

| Gate | Actual status |
| --- | --- |
| A: disabled deployment and current sources | Blocked. No operational deployment, migration or source qualification performed. Configured Paper TCP endpoint returned `ECONNREFUSED` at 07:37:57 UTC on 2026-10-07. |
| B: supervised normal-flow round trip | PKO 0; AAPL 0. No real order submitted in this delivery. |
| C: consecutive scheduled sessions | PKO 0/5; AAPL 0/5. No activation or session budget adopted. |
| D: recovery | Source and existing recovery fixtures are covered by isolated checks; no new operational restart/recovery proof is claimed. |

Remaining work is concrete:

1. **Calendar source and implementation.** Select a usable source with issuer
   identity, complete event occurrence coverage and honest publication timestamps,
   then implement and independently review its adapter. The audited PKO calendar
   omitted a separately announced extraordinary meeting; Apple IR access did not
   establish complete coverage. A news feed does not satisfy this mandatory group.
2. **Actual broker host.** Confirm TWS versus IB Gateway and its version/build,
   make the configured Paper endpoint reachable, then qualify the source and
   current quotes/reconciliation. F1's positive route requires TWS seven-day
   retrieval with Master/client 0; it does not certify Gateway current-day history.
   Follow the [accounting runbook](../../runbooks/PAPER_ACCOUNTING_SOURCE.md).
3. **Provider qualification and budgets.** Confirm the actual Marketaux plan,
   PKO/AAPL entity mappings and allocated call/cost budgets. The unchanged full-day
   cadence needs at least 192 calls per issuer/day before pagination. Follow the
   [news runbook](../../runbooks/PAPER_RESEARCH_NEWS.md).
4. **Model and disabled release.** The configured `gpt-5.4` metadata lookup returned
   HTTP 200 at 07:29:28 UTC; no generation was called. Verify a production-shaped
   request within the applicable budget, then complete the private configuration
   manifest, disabled deployment and Gate A, including supervision and alerts.
5. **Supervised Paper proof.** After Gate A, use a concrete authorized entry window,
   one-share PKO budget and exit deadline for the normal strategy flow. A missing
   signal or AI rejection remains inconclusive. Collect broker entry, protection,
   exit and fees before progressing to scheduled sessions.

The later two-position extension remains H in the closure plan. It has not been
implemented or enabled. Strategy configuration was deferred by the owner.

## Delivery controls

All 25 pre-existing dirty files are preserved by private SHA-256 baseline checks.
Only reviewed package paths may be committed on main. Tests use isolated
PostgreSQL and a clean repository archive; no operational database fixture was run.
No broker order, broker UI automation, paid model generation, Marketaux acquisition
or subscription change was performed. The first source commit contains exactly
53 reviewed paths; its post-push audit confirmed only the 25 original dirty files
remain. The failed CI is retained rather than replaced by local passing evidence.

## Fixture repair validation

Production code is unchanged by the CI follow-up. The F1 fixture now creates and
cleans up its own database instead of relying on the name of the supplied base.
All 13 normal fixture cases pass; injected migration and transaction-body failures
both preserve the base and remove the owned child. Full lint, typecheck, unit,
isolated integration and build checks passed on the clean repaired candidate.
The final repaired image is
`sha256:50983bcd506ab3511ad6150fd64a3a787b2e7f9c5f69eea098689938386af65d`.
The independent final review and private hashes cover the single test-file repair
and release-document updates; exact-commit CI is still required after publication.
