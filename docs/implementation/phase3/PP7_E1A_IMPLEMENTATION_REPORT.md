# PP7 E1a: authoritative PKO periodic report extraction

2026-10-07. E1a was published, but its exact-commit CI failed. A reproduced Linux
decoder cleanup defect is repaired and independently accepted; the required local
checks pass again. Repair publication/CI are pending. **PP7 is not complete.**
This package implements the PDF financial-report portion of
[the closure plan](PP7_CLOSURE_PLAN.md). Accounting implementation, actual news and
calendar coverage, source/model qualification and operational Gates A–D remain.

## Delivered behavior

The research refresh scheduler can fetch a configured `issuer-pdf-table` report,
verify its immutable SHA-256, decode bounded local bytes in an isolated worker and
publish mapped facts through the existing immutable research snapshot flow.
The worker permits no rendering, OCR, document scripts, XFA or remote resources.
It rejects encrypted documents, unsupported geometry, oversized input/output and
timeouts with stable errors; cleanup terminates the worker on every outcome.
The limits are 10 MB input, 100 document pages, 12 selected pages, 100,000 text
items, 1 MB extracted text, 12 seconds and a 256 MB V8 old-generation heap. The
heap setting is not an operating-system-wide external-memory limit.

The pure mapper validates issuer/source identity, report period, monetary scale,
capital metric and exact page/table/row/column geometry. It selects H1/June values
instead of adjacent quarter, prior-year or restated columns. Financial values come
from decoded table cells; they are not parser configuration constants.

The disabled example pins the official PKO H1 2026 consolidated report with SHA-256
`814f2e8d1c5b2239db62b08a3636a7add61e09b511981f2fae797d4544b82908`.
Independent production-decoder reads of the actual public PDF reproduced:

| Metric | Raw reported value | Source |
| --- | ---: | --- |
| Net interest income | 12027 PLN million | Page 5, H1 2026 |
| Parent-attributable net profit | 5290 PLN million | Page 5, H1 2026 |
| Loans and advances | 315047 PLN million | Page 7, 30 June 2026 |
| Amounts due to customers | 475762 PLN million | Page 7, 30 June 2026 |
| Tier 1 capital ratio | 15.55 percent | Page 33, 30 June 2026 |

The canonical consolidated report and Pillar 3 disclosure take precedence over
the inconsistent derivative workbook/English summary. Manifest-hashed authority
metadata retains the selected and conflicting document hashes, pointers, values,
units and rationale. Corroboration is dated review provenance, not a fresh fetch.
The parsed capital fact must match that recorded decision. A changed document
digest or layout needs renewed review and configuration.

HTTP retrieval requires PDF media type and exact magic bytes. Refresh failures
publish ERROR/ineligible current-source coverage without reusing old current facts;
historical immutable snapshots and unrelated source evidence remain intact.
Existing SEC, XHTML and declared-evidence behavior is preserved. The shipped
refresh switch, permissions, budgets and entry controls remain disabled/unverified.
llm-agent declares the Node runtime required by pinned `pdfjs-dist` 6.4.299;
local and Docker validation use Node 24.

The configuration and strategy-instance runbooks now describe PP7's guarded
scheduler-to-proposal capability accurately. Diagnostic evaluation remains
read-only, and implemented submission capability does not establish broker proof.

## Review and validation

Independent Astra/high plan review accepted E1a and the narrow runbook correction.
A different Astra/high reviewer accepted the implementation after one hostile
finding was fixed: a PDF with nondefault `/UserUnit` must be rejected rather than
mixing scaled page dimensions with unscaled text coordinates. A generated valid
binary regression fixture exercises that rejection.

Validation uses a clean archive of baseline
`197b13738620a648ce6a2c373d6bd4bff75ecfae` overlaid with only this package's paths.
The 25 pre-existing dirty files were verified unchanged by SHA-256. No strategy or
simulator behavior changes require backtests.

| Check | Result |
| --- | --- |
| Targeted PDF/provider/refresh tests | 82 passed; reviewer reproduced the actual five PDF facts |
| `pnpm lint` | Passed; two pre-existing unused-disable warnings |
| `pnpm typecheck` | Passed |
| `pnpm test` | Passed: 2985 passed, 133 database-dependent skips, 0 failures |
| `pnpm build` | Passed |
| Clean `docker build --no-cache` | Passed, image `ikbr-trader:pp7-e1a-verify` |
| `pnpm test:integration` | Passed in isolated Docker/PostgreSQL: 2427 passed, 0 failures, 0 skips |
| Scoped links and final report review | Passed independent review; initial staged diff check reported PDF xref whitespace, addressed by the separately reviewed binary-attribute follow-up |
| Exact-commit GitHub CI | Failed at `pnpm test` for `b1a4a907d3d8617f922a31cfe45b691a040c7e72`; investigation remains open |

Initial test-environment failures are retained in private logs. The sandbox denied
local HTTP listeners, so the same unit suite ran successfully with that permission.
The first host-to-VM integration run hit four existing ownership-test timestamp
checks; measured PostgreSQL clock offset was about +25 ms. Running Node and
PostgreSQL on the same VM removes that clock mismatch. A subsequent VM run crossed
Warsaw midnight and hit the existing fixtures' `PAPER_RUN_CROSS_DAY_WINDOW` guard.
The final integration run passed outside that fixture boundary; no production
time guard or assertion was weakened.

The reviewed 20-path package was committed and pushed normally to `main` as
`b1a4a907d3d8617f922a31cfe45b691a040c7e72`. Its
[CI run](https://github.com/dwojtyca/ikbr-trader/actions/runs/37538572261)
failed during `pnpm test`; public annotations only identify exit code 1, and the
log API returned HTTP 403 without credentials. A Linux reproduction of the unit
suite exposed a cleanup defect: PDF.js 6.4.299's document proxy has no `destroy()`
method; the loading task owns destruction. Posting the result before cleanup let
an uncaught cleanup error race the result. The initial CI failure is not waived.
The six staged whitespace findings were inside the unchanged generated encrypted
PDF's valid fixed-width cross-reference table. A follow-up marks only that path
as binary in `.gitattributes`; it does not alter the PDF or application behavior.

The independently reviewed repair awaits exactly one loading-task cleanup before
publishing its result. Password handling shares the same cleanup promise with an
immediate rejection handler. Cleanup failure produces a stable denial; parent
timeout and unconditional worker termination remain. Four actual-worker scenarios
assert that cleanup completes exactly once for success, cleanup failure, a known
page-limit failure and an encrypted-document path. The test-only module is
injected through the existing worker factory; the production module URL is fixed.

| Repair validation | Result |
| --- | --- |
| Independent hostile review | Accepted; reviewer reran all six extractor tests |
| PDF extractor and refresh targeted tests | 12 passed, 0 failed |
| Linux llm-agent unit suite | 155 passed, 7 expected database skips, 0 failed |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | Passed; same two existing lint warnings |
| Full host `pnpm test` | 2986 passed, 133 expected database skips, 0 failed |
| Clean Docker build | Passed, `ikbr-trader:pp7-e1a-repair-verify` |
| Isolated PostgreSQL `pnpm test:integration` | 2427 passed, 0 failed, 0 skipped |
| Binary metadata | Exact fixture SHA-256 unchanged; Git binary attribute confirmed; scoped whitespace check passes |
| Repair exact-commit CI | Pending publication |

Additional failed validation attempts remain recorded rather than hidden. One
host run observed about 925 seconds inside existing asynchronous tests and exceeded
an AI test deadline; the unchanged rerun passed. Running the entire unit suite in
the application image lacks the Docker CLI needed by two existing Compose tests;
the full host suite covers those checks. An initial integration rerun hit one
existing `xyz_nyse` daily-loss freshness denial; its isolated 17-test file and the
subsequent full integration run both passed without source or assertion changes.
The fresh Linux llm-agent suite specifically exercises the repaired decoder.

## Operational status

No broker orders, activation, operational database migration, paid-provider call
or notification delivery was performed. The configured broker endpoint was
unavailable during the earlier read-only TCP check. The owner-host choice and
source entitlements remain unverified; example configuration is not a release
manifest. [The accepted accounting contract](PP7_ACCOUNTING_SOURCE_CONTRACT.md)
defines the next source mechanism and its honest operator-settings trust boundary.
News/calendar feeds and model access still need their own positive evidence.

Gate A is not established; PKO/AAPL Gate B round trips are unproven; Gate C counts
remain zero. Do not enable entries merely because this financial parser passes.

## Model routing and repair record

The critical lead, mapper author, plan reviewer and distinct final reviewer used
the requested Astra/high route. The mechanical publication/CI packet uses
`gpt-6-luna`/low because the routing table's `gpt-5.6-luna` is unavailable in the
exposed subagent model list. Tools did not report a further fallback; independent
runtime model/effort telemetry and token usage are unavailable. No model downgrade
or quality/savings claim is made. The mapper author repaired one TypeScript
union-set issue. Lead authoring repaired inherited worker launch flags and the
decoder's required stream-cancellation reason. The implementation review found
one nonunit geometry defect, repaired and accepted on re-review. No critical
semantics were relaxed to obtain a pass.

The first package source file was created at 2026-10-06 19:39:12 UTC; required local
validation was confirmed at 22:04:25 UTC (about 2 hours 25 minutes).
Publication time is recorded with CI evidence. This span includes source
inspection, parallel accounting/feed work, reviews and environment validation,
not measured exclusive coding time.
