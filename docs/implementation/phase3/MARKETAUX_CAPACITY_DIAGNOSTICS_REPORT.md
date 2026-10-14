# Marketaux local capacity diagnostics report

Status: implementation validation in progress; not published or deployed. This is
separate from the completed-order diagnostics commit 2e49d3f. It does not resolve
the current Marketaux HOLD or establish that the free entitlement supports the
intended workload.

The owner confirmed Free entitlement, 100 calls/day and three articles/response.
The current bot profile uses a stricter pooled 90/day budget. Read-only checks found
on-demand enabled and 47 local reservations on 2026-10-14, all successful HTTP
calls. Provider-reported article count from the earlier capacity rejection was not
retained, and local ledger usage does not prove remaining external quota.

The [accepted plan](MARKETAUX_CAPACITY_DIAGNOSTICS_PLAN.md) adds a named local validation cause beneath the unchanged
RESEARCH_MARKETAUX_RESULT_LIMIT reason. It retains only validated scalar metadata:
provider-reported found, page size, required pages, configured bounds, pass/page,
and which local bounds were exceeded. No response body, news contents, arbitrary
configuration text or synthetic HTTP/provider error is recorded. Existing parser
validation order, two-pass coverage, slots, calls, budgets, ERROR/HOLD and eligibility
remain unchanged. A successful first-page HTTP request stays SUCCEEDED in its
ledger despite local capacity rejection.

The Astra/high plan author prepared a bounded patch; original and proposed SHA256
hashes were verified before the lead applied exactly three source/test files.
Independent Astra/high plan review accepted after one clarification round. Both
requested routes used inherited Astra/high; backend model telemetry and token usage
are unavailable. No implementation repair has been needed at this point. Exact elapsed task time
is unavailable; no duration or efficiency estimate is inferred.

Focused parser/refresh/fake-transport tests passed 39/39, including eight new cases.
The scheduler fixture proves one request/reservation, successful HTTP ledger,
negative diagnostic snapshot, no partial news and unchanged hard HOLD across
restart. No actual provider calls were made. At this focused-test checkpoint, independent
implementation review, full repository checks, clean image, publication and exact-
commit CI were still pending; subsequent receipts are recorded below.

The existing runtime offers no one-shot refresh for this hard HOLD. Normal start
reuses it; a day/slot boundary or restart does not rearm it. Scheduled mode violates
the validated profile. Changing article caps creates a new manifest and requires
an explicit disabled-write adoption and fresh whole-manifest research; it is not a
safe diagnostic retry shortcut. Neither configuration operation nor an ad hoc
provider call was performed. Deployment alone may not produce a current found
count; this limitation must remain explicit.

Independent ephemeral Astra/high implementation review ACCEPTED with no blocking
findings or repair round. It independently passed 36 parser/refresh tests with
injected transports and verified unchanged classification, ledger and validation
order. Requested model/effort is confirmed by the CLI launch header; backend
telemetry remains unavailable. CLI token counter: `54.325` (verbatim). Full final
checks are now running.

For operational context, the separate completed-order package 2e49d3fb2e63183ad577802550059661524449e7
passed [exact-commit CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/38567069298) and its clean scoped image was deployed
to ingestion/execution-engine at approximately 13:03 UTC. Entry pause revision38
was confirmed, reconciliation fresh CLEAN and flat with no orders, observer
healthy; producers remain stopped. New internal phase events are observed, but
no naturally occurring timeout was yet localized at this record point. This
Marketaux working-tree change is not part of that deployed image.

Full final validation passed: lint, typecheck, unit tests (3713 total; 3490 passed,
223 skipped, zero failures), isolated PostgreSQL integration (2820/2820, zero
skipped/failures), and build. No test repairs were needed for this package. The
independent documentation review accepted the exact five-file scope after two
reporting clarifications (elapsed-time availability and historical pending status).
Clean image validation/publication/CI remain outstanding at this checkpoint.

A subsequent normal start restored all four services on the accepted 2e49 image
but remained held by RESEARCH_SOURCE_STALE and RESEARCH_MARKETAUX_RESULT_LIMIT,
with no entry resume. Pause revision39, fresh CLEAN reconciliation, zero positions/
orders and healthy observer were confirmed at 13:09 UTC. Thus the earlier producer-
stopped state was a deployment interval, not the final observed service state.
The new capacity details are still not deployed and cannot reconstruct the older
missing provider count.

Clean scoped Docker build (`--no-cache`) passed. All 39 focused tests also passed
inside the image with networking disabled. Final packaging adds this measured
report only; the code and accepted scope remain unchanged. Publication and exact-
commit CI are the remaining release gates at source freeze. Runtime deployment
and any independently authorized future acquisition must be reported separately;
this change does not rearm the existing RESULT_LIMIT HOLD.
