# Paper accounting: automatic recovery evidence — implementation report

Date: 2026-10-27. Status: implementation and local validation ACCEPTED; publication/deployment pending. This document does not attest to a deployed
release, successful recovery, bot activation or a Paper transaction.

## Problem and selected change

The stranded accounting owner prevents execution HTTP startup. Existing V1
recovery obtains account flatness from manual operator evidence; its broker
handshake checks account identity but does not request positions or open orders.
Repeated manual evidence exchanges contributed to expired observation windows.
An expired operation retains maintenance and cannot be resumed or interpreted as
successful owner retirement.

The [accepted plan](PAPER_ACCOUNTING_AUTOMATED_EVIDENCE_PLAN.md) adds V2 recovery
with backend-owned account snapshots before and after the witnessed TWS reset.
V1 retains its historical meaning and manual fallback. This package does not
clear accounting/research holds, renew source qualification, change strategy
parameters or enable trading.

Automatic evidence is distinct from coordination declarations and fresh Paper
environment evidence. API account snapshots do not establish the absence of
untransmitted drafts or future manual intervention. Those facts must not be
fabricated or recorded as new personal observations by the owner.

The pre-reset API probe is an explicit, audited exception inside recovery
maintenance with the existing endpoint advisory lock. It does not acquire an
ordinary accounting owner. The transport exposes no order submission,
modification, cancellation or binding methods. Missing completion markers,
nonflat state, unknown coverage or unknown native closure cannot authorize reset
or retirement. Supersession does not erase unresolved dispatch history.

## Operational findings during preparation

Only PostgreSQL and Redis were running in the operational Compose project.
Read-only inspection found TWS listening on its configured endpoint and its UI
showing Simulated Trading. No complete API flat-account proof was obtained at
this stage, and no broker orders or recovery probes were sent.

Opening the desktop UI tool introduced control-tool processes whose arguments
included the repository path. The existing native classifier rejected them as
possible competing producers. Resetting that tool session made the native
preflight pass without changing the classifier. Keep the UI tool closed during
the recovery witness. This finding does not justify a blanket Codex/Node process
exception; a full reset may still require an operator action.

## Implementation and review evidence

Plan author: requested `gpt-6-astra`, reasoning `high`.
Independent plan reviewer: `automatic_evidence_plan_review`, requested
`gpt-6-astra/high`; ACCEPT after one correction requiring predecessor traversal
to cover unresolved pre-reset probes and post-reset handshakes across V1/V2.
The same independent reviewer accepted the subsequent monitoring/coordination
delta: re-read the original private coordination artifacts; inspect all native
sockets before and after a probe, while checking Docker events and exact TWS
process/listener identity during it. This relies on the declared client
coordination; it does not prove absence of transient clients between samples.
Timing-invalid positively closed results may preserve failure/closure evidence
within the same unexpired observer, but cannot authorize reset or retirement.

Critical implementation is split between the schema/store/backend/migration
worker, the transport worker and the host CLI worker, all requested
`gpt-6-astra/high`, with disjoint file ownership. No worker may replace the
independent final review. Actual runtime model/effort telemetry, token usage and
complete elapsed-time measurements are unavailable unless recorded separately.

Final hostile review: `automatic_evidence_final_review`, requested
`gpt-6-astra/high`, ACCEPT with no unresolved blocking findings. This reviewer
is different from the plan reviewer and did not author the implementation.
Review repairs: diagnostic name/code/message bounds and empty-value handling
required two rounds (including trim-after-slice); the final full probe budget
check immediately before socket dispatch required one round. A host fixture
was corrected to advance virtual time instead of rewriting preparation time.
Additional PostgreSQL cases cover unresolved post-reset dispatch ancestry,
successful V1 fallback and raw migration forgery. No guard was weakened. Full integration additionally identified two historical
migration-list expectations ending at 38, in notification-checkpoint and
strategy-conversion tests. Both exact lists now include 39; preservation and
idempotency assertions remain intact, with independent delta review ACCEPT for both one-line changes. Both changed fixtures also passed focused ESLint.

Focused evidence: shared schema 13/13; backend 27/27; final reviewer transport
and probe 66/66; host 48 passed with two existing opt-in skips; isolated owner
store PostgreSQL 18/18. Available model routing matched requests; actual model
telemetry, token counts and precise total elapsed time remain unavailable.

## Validation

Verification uses a clean archive of baseline
`63bf8860ede76c6d81628f33366acd5590cf2619` plus only this package's files, with
dependencies installed from the frozen lockfile. Unrelated local research and
signal changes are excluded. Integration tests use a separate PostgreSQL
container/database, not operational data. The first full integration invocation
used port 55438, which the shared test safety allowlist rejects. Its failures
were environment configuration failures. Local test suites have differing allowlists (55432, 55434 and 55438).
The local rerun also exposed very slow Docker disk synchronization and was
stopped. Final integration validation uses the clean application image sharing
only the disposable test PostgreSQL container network namespace, CI=true and
127.0.0.1:5432/ikbr_trader_ci, the common CI contract. That address is inside
the isolated test container, not the host operational database. Test PostgreSQL
data uses tmpfs; durability settings and test guards are unchanged.

| Check | Result |
| --- | --- |
| Focused transport/schema/host/store tests | Passed; counts above |
| `pnpm lint` | Exit 0; two existing unrelated unused-disable warnings |
| `pnpm typecheck` | Exit 0 |
| `pnpm test` | Final rerun exit 0; 3889 passed, 350 expected opt-in/PG skips, zero failures |
| `pnpm test:integration` on isolated PostgreSQL | Exit 0; shared 90, execution 2202, backtest 18, llm-agent 84, ingestion 160, signal-engine 574: 3128 passed, zero failures/skips |
| `pnpm build` | Exit 0 |
| Clean Docker build | Candidate exit 0; exact published-source image pending |
| Independent hostile implementation review | ACCEPT; report narrative and isolated-container test topology also reviewed |
| Exact-commit GitHub CI | Pending |

The first final unit run had one timing failure in the unchanged completed-order
phase diagnostics test (20 ms deadline elapsed in its queue under concurrent
compilation). The isolated file passed unchanged; full rerun passed as recorded above.
The first isolated-container integration passed shared 90/90 and execution
2200/2202, with only the two expected-migration-list failures described above.

Backtests are not applicable: no strategy or simulator behavior is changed.

## Publication and deployment

Publication, exact-source image identity, migration application and deployment
evidence are pending. The clean candidate image is
`sha256:3c34fbb887f4756c1ff7ecac3d354a7a6a1db2e7b22983f6286fb23508ff75e1`.
Final container integration used that unchanged runtime with the two reviewed
migration-list fixtures mounted read-only. Deployment requires a fresh image
from the published commit including those test corrections. A private operational
database dump and profile backup were created; `pg_restore --list` accepted
the archive. No operational migration, owner retirement or broker probe has yet
been performed. Until confirmed, the previous pinned maintenance deployment remains
the operational baseline. Do not use this report as permission to run a dirty
image, retire an owner by SQL or skip another startup gate.

Operational acceptance still requires one uninterrupted supported recovery,
exact receipt readback, disabled-write execution startup, current accounting and
reconciliation evidence, research recovery/refresh and the remaining normal
Paper startup gates. Bot activation and actual trades require separate observed
results; passing software checks alone proves neither.
