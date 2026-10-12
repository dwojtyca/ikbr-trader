# Continuous Paper operation — implementation evidence

Date: 2026-10-12. Status: source implementation accepted; final release checks,
publication and guarded deployment remain in progress. No broker acceptance is
claimed by source or test acceptance.

Owner scope and acceptance are in the
[accepted plan](CONTINUOUS_PAPER_OPERATION_PLAN.md). Operator behavior is documented
in the [continuous Paper runbook](../../runbooks/CONTINUOUS_PAPER.md).
The owner approved continuous PKO and AAPL, one whole share and one open position
per instrument, no daily attempt quota, and USD5/day for AI. The owner also chose
news acquisition on demand without new fees. Monetary risk and unknown-outcome
protections remain. Earlier short-window authorization does not limit this new
mode; earlier operational acceptance is not invented.

## Delivered behavior

- V3 recurring Paper authority uses verified broker sessions and immutable proposal
  session bindings, with explicit null attempt quotas and same-day guarded adoption.
  V1/V2 identities and restrictions remain unchanged. SQL validates the canonical
  policy, hash, adoption and complete session envelope before admission.
- Two instruments may coexist only as independently owned, one-share protected
  positions. Repeated completed cycles retain exact historical order/execution
  membership. Late old fills, changed commissions and ambiguous evidence hold
  entries. No unknown submission is retried.
- Natural signals request missing/stale research before creating an entry intent.
  A durable queue uses existing provider slots, pacing and budget reservations.
  A later cycle recomputes the signal. Prebinding proposal waits retain original
  expiry and cannot revive a model, decision or delivery attempt.
- Optional strict `RESEARCH_MARKETAUX_ON_DEMAND=true` skips only periodic news;
  reports and WSH remain periodic. READY repairs do not rearm just because time
  passes. Default false preserves prior cadence. Acquisition still requires full
  pagination, permissions, capacity and current data; demand mode cannot guarantee
  that a free provider quota serves every signal.
- Optional ingestion auto-bootstrap fills history gaps after start/reconnect.
  Single-flight recovery is fenced against stale work. Manual stop persists across
  restart, explicit bootstrap resumes, and control persistence failure drains and
  inhibits ingestion. Native data, history and pacing guards are preserved.

## Review and routing evidence

| Work | Requested model/effort | Agent | Result |
| --- | --- | --- | --- |
| Independent critical plan review | gpt-6-astra/high | continuous_plan_review | ACCEPT after repeated-cycle ownership amendment |
| Ingestion persistence and news capacity amendments | gpt-6-astra/high | continuous_plan_review | ACCEPT; separate semantic reviews |
| Recurring authority/lifecycle | gpt-6-astra/high | continuous_policy_audit | Implemented, focused tests passed |
| Research preparation/wait and demand flag | gpt-6-astra/high | research_repair_audit | Implemented, focused tests passed |
| Ingestion recovery, integration and release checks | Capable lead | root | Implemented; final release checks below |
| Independent hostile implementation review | gpt-6-astra/high | continuous_impl_review | Source and report ACCEPT including amendments |

The final reviewer authored no changes and is different from the plan reviewer.
Actual provider model/effort telemetry, token usage and complete worker elapsed
time are unavailable. No critical model downgrade occurred. The routing guide's
mechanical gpt-5.6-luna/low route is unavailable in the agent selector; the capable
lead runs release checks instead, preserving independent review.

Five source review findings were repaired: failed ingestion-resume persistence
must drain running work; SQL must reject nullable session envelope holes; SQL must
verify canonical policy/hash consistency; research claim/wait must exclude durable
decision/delivery markers; and a concurrently completed repair must remain a typed
recoverable wait. One critical coverage finding added real repository/observer
proof for three same-contract cycles, two protected positions and old late fills.
A lead check also required recurring instrument count to fit the account position
cap. No review blocker remains. Fixture repairs corrected database-vs-host clock
alignment, retained execution Date representation and a genuinely aged coverage
snapshot; no production guard was weakened. The full integration run exposed one
exact migration-list assertion, updated from17–29 to17–31 and independently accepted.
The research worker also corrected two lint errors. No model escalation was needed.

## Validation and delivery

Isolated PostgreSQL16 uses disposable `ikbr-continuous-test-20261012` on loopback
port55432, separate from operational5432 and its volume. Tests create isolated
databases. Implementation tests make no broker/provider calls.

Independent reviewer evidence: ingestion9 tests, lifecycle31, policy/route17,
shared20, research repair PostgreSQL10, strict recurring SQL5, production repeated
cycle/coexistence/late-fill PostgreSQL3 and final demand-mode33 all passed. Some
suites overlap; these counts are not added as a unique total. The research worker's
final PostgreSQL repair suite passed11/11; the migration assertion repair passed4/4.

Final settled-tree checks passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` against the isolated PostgreSQL, and `pnpm build`, all exit0.
Unit totals:3307 tests,3129 passed,178 skipped,0 failed. Integration totals:2531
passed,0 failed,0 skipped. Lint retains two pre-existing unused-disable warnings.
The initial sandbox unit run could not bind a local test server; the authorized
rerun passed. Initial full integration failed only the exact migration-list
assertion described above; the final complete rerun passed.

Clean `docker build --no-cache` passed from HEAD plus the61 explicitly reviewed
files, excluding ignored backups, secrets and unrelated dirty work. Its initial
image is `sha256:a93181a87aa7aceaedd4bf23766e22db60f848ad66e807dd86135d0f98597586`.
The release will be rebuilt from the published commit so its final image contains
the settled report. Scoped publication and exact-commit GitHub CI are pending at
this report's source freeze; final receipts belong to the private deployment
record and operator delivery message.
No strategy or simulator behavior is changed, so no new backtest claim is made.

The unrelated local ES/backtest edits and existing `signal-engine.ts` edit are
outside publication scope. Clean release context must contain only reviewed Git
files, excluding ignored private backups and secrets. Runtime remains on the
previous pinned image with trading disabled while release work proceeds.
No actual new Paper entry, fill, round trip, soak or profitable strategy result
is established by this report.

## Exact-commit CI fixture repair

The first published source commit `c8b9aea723f035dcfcb1bcf0ea29a26794c8b935`
failed [GitHub integration checks](https://github.com/dwojtyca/ikbr-trader/actions/runs/38244005064)
in the accounting qualification fixture. Both the host and exact clean Docker
image passed all2531 integration tests, so no failure was guessed from those runs.
The owner supplied the unavailable authenticated CI log: an89ms filled-day test
raised `ACCOUNTING_INSPECTION_INVALID` at the qualification transaction fence.

The fixture scheduled a delayed duplicate commission during each of two
inspections. The second inspection already had the fee cached, so the duplicate
could arrive after its barrier was captured and before qualification committed.
Production correctly rejected that changed barrier. The repair explicitly proves
that the initial inspection persists replay end before the first delayed fee,
then uses synchronous replay for positive filled-account qualification. Existing
debit and both-socket late-duplicate assertions remain. New deterministic cases
inject the duplicate at both qualification transaction fences and require rejection
with no committed qualification or control pointer. No production code, timeout,
accounting requirement or trading guard changes.

The independent Astra/high implementation reviewer accepted this narrow fixture
repair and report. Targeted PostgreSQL checks passed23/23 on the host,23/23 in
each of five clean-image repetitions, and23/23 in the independent review. The
worker requested Astra/high; actual model telemetry and token usage are unavailable.
This was one fixture repair, with no model escalation. Final full repair checks
passed: lint, typecheck, unit tests (3307 total,3129 passed,178 skipped), isolated
PostgreSQL integration tests (2533 passed,0 skipped) and build, all exit0.
Publication, exact-commit CI and an updated clean image are the remaining release
gates at this report freeze; private deployment receipts record their outcome.
