# Two-source hourly research delivery

Status: implementation reviewed and locally validated.
Publication, exact-commit CI and operational adoption are separate release gates.
This report records the implementation; it does not claim an executed Paper trade.

## Delivered behavior

The owner selected exactly Marketaux news and IBKR WSH calendar on 2026-10-15.
The explicit `TWO_SOURCE_HOURLY_V1` policy refreshes both hourly and retains each
proved successful acquisition for 24 hours. Fresh current-policy cache permits
startup while a due background refresh runs. Missing or expired coverage triggers
ordinary bounded acquisition, subject to actual provider and pacing constraints.

The new policy neither fetches nor requires SEC or issuer financial reports.
It omits report/fact fields and report-publication deadlines. The policy-specific
AI prompt requires news/calendar evidence without inventing audited financial
metrics or rejecting solely because reports are absent. Market data, broker
sessions/account state, deterministic risk and proposal-bound AI remain required.
Legacy manifests, adapters, snapshots, hashes and prompts retain their contracts.

Marketaux uses an hourly query cutoff with a 24-hour lookback. Cache validity is
measured from the original database-recorded successful completion, not the query
cutoff, a later snapshot rewrite or a retained failure. Ordinary refresh,
acquisition state and cache validity are separate. Known proved transient/budget
failures can retain valid original cache; hard, incomplete or unknown outcomes
remain holds. The new ledger preserves qualified-conId pacing across restarts and
manifest/source-label changes. Pooled provider budgets are unchanged.

Migration 35 adds the durable Marketaux acquisition/receipt state. Source-only
publication merges into the latest head without replacing a concurrent WSH
update. AI preparation and final resume acquire source admission before snapshot
head locks. Final resume rechecks durable state even after earlier preparation
reported READY. Normal entry permits and final execution validation remain intact.

## Review and repair evidence

The [plan](TWO_SOURCE_RESEARCH_HOURLY_PLAN.md) received independent acceptance at
content SHA256 `0fad6f14a7f72c4995561177f8ccfd7e97f2f850d8c34db34c866a3f10634b13`.
The monotonic HTTP-budget amendment was independently accepted. The lost-COMMIT
clarification was independently accepted at content SHA256
`cd60bed616185079c98a46a73d7b9561569421e0df294ac07a89914d0ad2be06`.
A missing acknowledgement remains uncertain until an independent read verifies
the complete immutable terminal transaction and original source proof. Terminal
status alone cannot admit trading or extend validity.

Independent implementation review found and the authors repaired:

- Reader/writer lock ordering, including the actual AI preparation caller.
- Missing automation/retention checks and stable qualified-conId pacing.
- Original-day budget denial proof, exact pooled caps/counters and SQL guards.
- Orphan reservations and mutation/transplant of issued attempt tickets.
- SQL terminal success, classification and retained-failure receipt proof gaps.
- Final resume relying on snapshot age without current durable source admission.

The reviewer independently reran the hostile shared tests, strict policy cases,
state/resume tests and the deterministic actual AI preparation/publication race.
No blocking code or document finding remains. All required local checks passed;
formal final acceptance is recorded separately for this reviewed publication scope.

## Validation

| Check | Result |
| --- | --- |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS |
| `pnpm test:integration` on isolated PostgreSQL | PASS |
| `pnpm build` | PASS |
| Clean Docker build | PASS, `--no-cache` |
| Shared state and hostile PostgreSQL suites | 11/11 and 6/6 PASS |
| Actual execution policy binding PostgreSQL suite | 5/5 PASS |
| Final resume PostgreSQL regressions | 2/2 PASS |
| AI preparation/publication race | 1/1 PASS; combined review/repair/race 19/19 PASS |
| Runtime startup/proof tests | 46/46 PASS |
| Diff and scoped lint checks | PASS |

The root integration command now runs the two new shared PostgreSQL suites in
GitHub CI. Database guards allow the isolated local test instance or the explicitly
named CI database. No destructive fixture used the operational database.

Initial failures were corrected and retained as diagnostic evidence: the last
source-only test fixture first supplied inconsistent WSH rows; its fixture was
corrected to reach the intended projection rejection. Two preexisting upgrade
tests omitted migration 35 from their exact expected applied lists; both now
include it and retain all history-preservation/idempotence assertions. Earlier
hostile runs also exposed SQL success and unassigned-record guard defects, fixed
by the implementation author without weakening assertions. One test's pooled
budget denial count was corrected for its three-instrument fixture.

No strategy or simulator behavior changed; no strategy backtest was required.
Six unrelated tracked backtest/signal-engine edits were verified unchanged.
Those edits and unrelated untracked diagnostics/docs are excluded from scoped
publication and the clean Docker source context.

## Routing

| Task | Requested / actual route | Evidence |
| --- | --- | --- |
| Shared contract and implementation | GPT-6 Astra / high, same actual | Frozen; shared checks passed |
| Independent plan review | GPT-6 Astra / high, same actual | ACCEPT |
| Monotonic deadline amendment review | GPT-6 Astra / high, same actual | ACCEPT |
| App scheduler and hostile PG integration | GPT-6 Astra / high, same actual | Frozen; focused checks passed |
| Lost-COMMIT amendment review | GPT-6 Astra / high, same actual | ACCEPT; not the final reviewer |
| Lead runtime/AI/resume integration | Current lead; model/effort telemetry unavailable | Focused checks passed |
| Independent implementation review | GPT-6 Astra / high, same actual | Distinct reviewer; no blocking code findings |

Token usage is unavailable. Measured initial app integration time was 13m10s;
additional hostile test authoring/verification was 4m53s. Total end-to-end elapsed
and aggregate repair count were not instrumented, so no efficiency claim is made.
The concrete repair rounds are described above; no model downgrade or escalation
was used. The final reviewer authored none of the implementation.

## Deployment boundary

New entries were paused through the supported stop command before this package.
At 2026-10-15 11:41:53 UTC, durable pause revision 48, fresh CLEAN reconciliation,
zero broker positions, zero open orders and a healthy observer were confirmed.

The private candidate preserves verified listing/access records, WSH480 and
Marketaux2400 local daily allocations under the paid Marketaux2500 entitlement.
It changes the selected policy/prompt, removes report requirements/sources and
sets hourly/24-hour Marketaux configuration with on-demand mode disabled.
No old-manifest cached success is relabeled as a new-policy acquisition.

The disabled-write, quiescent adoption helper received independent read-only
acceptance at SHA256
`5910e4e22585a70e192e12452893c33f44e163e7eb755ea8737932d96471bf4a`.
It pins release/runtime/imported-helper bytes, preserves database/profile backups,
checks fresh flat paused broker state, fences unresolved acquisitions, adopts
migration/authority with writes disabled, and restores normal infrastructure only
following the exact limited adopted checkpoint. Supported startup retains the
final readiness/resume gate. Helper review is not evidence of deployment.

The previous runtime received WSH10281. This package does not bypass that broker
condition or change WSH retry/cleanup semantics. Actual source completion, expiry,
next-refresh times, report-provider call absence and any remaining provider hold
must be checked after successful exact-commit CI and guarded adoption. Tests,
healthy infrastructure or this report alone do not prove Paper activation or a
round trip.
