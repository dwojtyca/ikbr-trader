# PP4 implementation and source-coverage report

Date: 2026-10-04. Baseline: `5e965b36fa6f5fb0342781a6445c2cc11c840718`.
Status: implementation/document review and all required local checks accepted;
**real-source acceptance remains BLOCKED**. No deployment, trading activation,
PP5 work, paid calls or subscription changes occurred.

Contracts: [bounded plan](PP4_IMPLEMENTATION_PLAN.md),
[provider mapping contract](PP4_PROVIDER_CONTRACT.md),
[research context](../../architecture/INSTRUMENT_RESEARCH_CONTEXT.md),
[delivery PP4](PAPER_PRODUCTION_DELIVERY_PLAN.md#8-pp4--instrument-research-and-complete-ai-audit).
PP1–PP3 plans, contracts and publication reports were checked before implementation.
The delivery continues their configuration, attribution, deterministic risk,
account/session identity, attempt and close contracts. Twenty-five unrelated local
paths were recorded by SHA-256 before work and excluded from the publication scope.

## Delivered mechanisms

PP4-A adds strict research manifests bound to immutable PP1 configuration,
issuer/listing identifiers and parser mappings; immutable snapshots, source
coverage, report revisions and facts; and exact proposal/snapshot/config binding.
Migration 20 retains manifests, authoritative adoption history, process observations,
monotonic snapshot heads, binding and call-budget ledgers. Missing manifests,
drifted peers, wrong issuers, stale or missing required evidence and unsupported
ETF entry fail closed. Replacing the manifest requires writes disabled and no
active/unknown work. An unresolved model reservation conservatively prevents
manifest adoption even after expiry; no budget refund, retry or manual ledger
mutation is provided by this package.

PP4-B implements configurable SEC submissions/companyfacts, exact XHTML table
mapping and a declared-evidence input format. Runtime branches select adapter
formats, never PKO/AAPL tickers. An independently configured third issuer is covered
by fixtures. Facts retain raw numeric magnitude and scale separately: `24223 ×
1000000 PLN`, not a pre-scaled value with a second scale. Banking requirements use
net interest income, net profit, loans, deposits and an explicitly selected Tier 1
or CET1 ratio. They do not require industrial cash-flow/debt substitutes. Reporting
and quote currencies remain distinct. Multiple SEC amendments form a chronological
revision chain; coincident conflicting publications remain ineligible.

PP4-C refreshes sources independently of pending AI reviews, with a separate timer,
serial per-instrument PostgreSQL advisory locking and atomic published-slot records.
Restart skips a published slot, including a failure; an uncompleted charged slot
cannot be resent. Source HTTP calls are reserved before send, use canonical provider
origins and exact manifest URLs, pinned public DNS, no redirects, a complete ten
second DNS/connect/body deadline and a response-size cap. Only explicit transient
HTTP failures allow one retry. Each SEC endpoint consumes a separate reservation
and retains its own digest/reference. Failure snapshots supersede old success.
The source-provided query window is preserved; its end is the coverage as-of time,
while acquisition time records response completion. Refresh defaults off and all
example request budgets are zero.

The bound AI worker reads cached research and an authenticated broker-derived
`GET /execution/proposals/:id/ai-context`. Context includes the original proposal,
strategy/configuration, positions/open orders and reconciliation generation, account,
quote, per-currency valuation/FX, fee-reserve provenance and risk evidence. Context
is checked again after database waits. The execution layer independently checks
research before attempt reservation and final dispatch, holding authority/head locks
through its synchronous expiry fence and retaining fresh deterministic risk checks.
Existing close/management paths do not require new research or an entry AI decision.

Migration 21 persists the exact OpenAI HTTP body before send, its enclosing context
and hash, snapshot, model/prompt/schema versions, result, flags, evidence references,
timings and late outcomes. One charged model request is allowed per proposal,
including REJECT, malformed output, timeout and unknown outcomes. Fixed claim and
absolute proposal deadlines remain 30/120 seconds; context/model preparation is
bounded to 8/10 seconds. Restart/lease expiry cannot issue another request; late
results are audit only. Rows and TRUNCATE are protected. Stored request/context is
available for replay without provider calls or reliance on the current source head.
Model output cannot mutate orders, invoke tools or waive deterministic eligibility.

Authenticated `GET /execution/orders/:id/research` and a narrow UI proxy allowlist
expose historical source links, coverage, immutable identities, financial units,
flags, references, request/outcome and timing. Links allow HTTPS without credentials;
React renders source text as text. No new trading control was added. ETF descriptor
fields describe fund/share-class/prospectus/benchmark/holdings/fees/leverage and
other required characteristics; entry remains explicitly `NOT_SUPPORTED`.

## Actual source observations: separate from tests

Unauthenticated discovery stayed within the bounded 30-read allowance (29 reads,
including unsuccessful discovery attempts). No provider key, paid research call or
model call was used. Raw downloaded documents remain temporary and are not committed.
The configured example retains only identifiers, mappings and references; it is
neither a license decision nor an activation configuration.

| Instrument / source | Observed evidence | Result and remaining limitation |
| --- | --- | --- |
| AAPL / [SEC submissions](https://data.sec.gov/submissions/CIK0000320193.json) and [companyfacts](https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json) | HTTP 200 on 2026-10-04 around 09:29 UTC. Apple Inc., CIK 0000320193, AAPL/Nasdaq pair. Annual accession 0000320193-25-000079 and periodic 0000320193-26-000020. | Actual saved payloads parsed using the committed mapping: two reports and eight facts, including annual and nine-month YTD revenue, net income, operating cash flow and explicit debt-component sums. This proves extraction, not full entry research. |
| PKO / [2025 annual page](https://www.pkobp.pl/en/investor-relations/financial-reports/2025-annual-report) and [consolidated XHTML](https://www.pkobp.pl/api/public/7ac80885-6c08-42c2-8c15-42540e4e3987.xhtml) | HTTP 200 around 09:29–09:30 UTC. Ordinary XHTML tables, not usable inline-XBRL. Issuer page publication metadata is 2026-03-12T00:02:00+01:00, also displayed as 12.03.2026 00:02. | Actual document parsed using the committed mapping: one annual report, five bank metrics. Nested layout tables are isolated; exact financial table/row/column must uniquely match. |
| PKO / [issuer page](https://www.pkobp.pl/en/investor-relations) | LEI P4GTT6GF1W40CVIMFR43, ISIN PLPKO0000016 and WSE listing references observed. | Issuer mapping corroboration; this does not refresh broker conId, quotes or session metadata. |
| PKO / [H1 2026 periodic page](https://www.pkobp.pl/en/investor-relations/financial-reports/periodic-report-for-the-first-half-of-2026) | HTTP 200 at 09:44 UTC; consolidated interim financial statements exposed as PDF links. | Latest periodic machine extraction is **NOT IMPLEMENTED/UNVERIFIED**. Annual extraction does not satisfy this mandatory group. |
| PKO material news/calendar and [Apple IR](https://investor.apple.com/investor-relations/default.aspx) | Public pages available; Apple IR HTTP 200 around 09:30 UTC. | Complete automated issuer-matched news windows and upcoming-event coverage were not established. HTML availability is not an EMPTY query or a complete calendar. |
| Permissions / retention | SEC public API documentation and [PKO site terms](https://www.pkobp.pl/regulacje-prawne/regulamin-strony-internetowej) inspected. | No complete operational entitlement/retention policy was established for all required groups. Example sources remain UNVERIFIED. No paid provider has been selected or represented as ready. |

PKO actual annual extraction (period 2025-01-01..2025-12-31; balance-sheet and
capital values at 2025-12-31):

| Metric | Source value | Unit / scale |
| --- | ---: | --- |
| Net interest income | 24,223 | PLN × 1,000,000 |
| Net profit attributable to parent | 10,682 | PLN × 1,000,000 |
| Loans and advances to customers | 293,411 | PLN × 1,000,000 |
| Amounts due to customers | 460,722 | PLN × 1,000,000 |
| Tier 1 capital ratio | 15.57 | percent; prudential capital table, **not CET1** |

Actual AAPL periods are 2024-09-29..2025-09-27 and 2025-09-28..2026-06-27.
Quarter-only durations are excluded rather than mixed into YTD. Initial probe
extracted seven facts because its annual cash-flow start mapping was wrong; the
committed fiscal-period mapping corrects that and extracts eight. Total debt is
LongTermDebtCurrent + LongTermDebtNoncurrent + CommercialPaper from the same
accession and instant. Missing components never become zero.

Selected raw SHA-256 digests (local acquisition evidence, not committed payloads):

| Source | SHA-256 |
| --- | --- |
| SEC submissions | `3cf0928a15c79b842e4ecef56a0ce30c5edfeda0c98643a046233fafba40dae7` |
| SEC companyfacts | `73a86c6aedc31f77cac2ea4df5f80f0b3bd7e6eb58bb4e01444fbedf3afb9c43` |
| PKO annual XHTML | `aa2920557691a3c3bf1364911536b9986925d8d7dc5a9d59ba17bbf4df0a248c` |
| PKO H1 page | `794ec05b171380d6c635b1c982004d29d1d57425036fe4802e87fd1541a4275b` |
| Apple IR page | `48a727c06496341793279f1c24ae8ea070f81b220b2af6071ec1218af1ddca6d` |

## Disabled configuration and outstanding acceptance

[paper.example.json](../../../config/research/paper.example.json) is bound to
`config/trading/paper.v1.json` effective hash
`60cd6b0368d6d176a3d85f750b11bace5b2f7880576e85441099ba80fd229f10`.
Research manifest hash:
`883a22f7035d8ecfde050aaf5c190332ba197897077c2275d92b78707b7c3605`.
The model is deliberately `UNVERIFIED_MODEL`, refresh is false, budgets are zero,
source permission/retention is UNVERIFIED and unsupported feed/PDF parsers are named
explicitly. The example's expired report deadlines are conservative blocking
placeholders, not predictions of the issuer's next publication. Valid future
reporting deadlines, permissions, feed mappings, available model and separately
authorized budgets are required before an operator can construct a usable manifest.

Both services require the same `RESEARCH_CONFIG_PATH` and
`RESEARCH_CONFIG_EXPECTED_HASH`; explicit disabled-write adoption uses
`RESEARCH_ADOPT_MANIFEST=true`. Source budgeting additionally requires an explicit
`RESEARCH_BUDGET_ACCOUNT_ID` in the selected environment's account whitelist; no
first-account guess or broker connection is used for that read-only budget identity.
This report does not instruct applying those settings to the operating stack.

Unresolved acceptance: latest PKO periodic extraction, complete news/event coverage
for both issuers, operational permissions/retention, verified reporting deadlines,
model availability and separate call budget. Until resolved, **PP4 full real-source
acceptance is not complete and new entries remain blocked**. PP3 quote/reconciliation
and account/day certification blockers also remain separate; this work did not
recheck IBKR or imply those gates passed. No PP5 or trade activation is authorized.

## Review, checks and publication

Independent Astra/high plan review accepted after one repair round (authority/drift,
trusted broker-context seam and snapshot supersession). A different Astra/high
implementation reviewer found outcome/expiry collision, scale/null parsing,
calendar occurrence, lock-wait freshness, listing pairing, exact wire audit,
transport deadlines, audit TRUNCATE, report-period and amendment-chain issues,
refresh restart/concurrency and UI units. Repairs and regression tests were re-reviewed and accepted. The independent reviewer
ran 33 targeted tests successfully and rechecked the final seven provider tests.
All required local checks and exact-source-commit CI subsequently passed. Full real-source
acceptance remains blocked as described above.

Focused evidence already passed: shared 7 unit tests; store 6 isolated PostgreSQL
tests; execution 31 unit, 3 new PostgreSQL and 86 historical compatibility tests;
AI 7 isolated PostgreSQL regressions; provider 7 and scheduler 10 tests. Historical
execution fixtures explicitly inject fixture-only research permits so old PP1–PP3
assertions remain meaningful; production constructor defaults deny missing research.
No fixture/HTTP mock is evidence of real source availability or model permission.

Required clean-candidate checks: **PASS** (all commands exit 0).

| Check | Evidence |
| --- | --- |
| `pnpm lint` | PASS; two unchanged unused-disable warnings in existing config/simulator files |
| `pnpm typecheck` | PASS, all workspace projects |
| `pnpm test` | 2,876 tests: 2,774 pass, 102 PostgreSQL-dependent skips; no failures |
| `pnpm test:integration` | 2,264 tests pass, no skips/failures, final accepted Docker image with isolated PostgreSQL |
| `pnpm build` | PASS, all workspace projects |
| Clean Docker `--no-cache` build | PASS; image ID `sha256:85acde6dbb952ed3ac13aa6bb9a2b33b6cc219fcdb2df0a59cf1533fd0e4eab9` |
| Local document links, scoped diff and preserved-work hashes | PASS |

The first full integration run exposed three historical fixture expectations: the
removed global PP4 marker, a dispatch fixture without a persisted proposal and a
migration-number list ending at 19. Fixtures were corrected without relaxing runtime
guards; targeted 15 tests and the subsequent full suite passed. Provider offset
normalization was rechecked against both real payloads and the shared snapshot
schema; invalid calendar dates and 24:00 remain rejected.

Source commit: [`dc419ff394714c09265f0d75c7a6f2f3fe1540c2`](https://github.com/dwojtyca/ikbr-trader/commit/dc419ff394714c09265f0d75c7a6f2f3fe1540c2), pushed to `main`.
Exact-source-commit [GitHub CI run 37199720392](https://github.com/dwojtyca/ikbr-trader/actions/runs/37199720392)
completed **success** at 2026-10-04T11:48:46Z. The observed `head_sha` exactly
matches that source commit. This documentation-only receipt records the result;
its own commit is also checked in CI before final delivery. The 25 unrelated dirty
paths remained byte-for-byte unchanged after publication. The disposable PP4
PostgreSQL container was stopped after successful local checks; existing stacks
were not changed.
The candidate excludes all 25 pre-existing dirty paths. Integration uses disposable
PostgreSQL databases on the separate `colima-pp1-verification` Docker daemon,
container `pp4-postgres`, host port 55444. No operational database fixtures are used.
No strategy/simulator behavior changed; additional strategy backtests are not
applicable, while existing repository backtest suites remain required.

| Package | Requested route | Observed dispatch / repairs |
| --- | --- | --- |
| Plan and critical A work | gpt-6-astra / high | Plan reviewer and critical implementers selected this route; lead integrated safety repairs. One plan repair round. |
| B normalizers | gpt-6-luna / medium | Selected route; one parser repair and explicit SEC-period contract escalation. Integration findings escalated to the capable lead; no silent downgrade. |
| C refresh/UI integration | gpt-6-sol / medium | Selected route; critical account, transport, slot and lock semantics returned to lead. Hostile-review repairs retained the accepted safety policy. |
| Independent implementation review | gpt-6-astra / high | Different agent from plan reviewer and all implementers. No reviewer-authored implementation. |
| Mechanical checks/publication | gpt-5.6-luna / low requested for initial setup; capable lead thereafter | Initial read-only setup exposed sandbox/Docker access limits; lead used isolated tools with approved access. |

Provider worker reported approximately 15 minutes; shared worker approximately 24
minutes. Approximately 138 minutes elapsed from the frozen baseline inventory through final
local verification. Independent source review used an initial hostile review and
two re-review turns, with findings repaired at their assigned tier or by the capable
lead; a separate final documentation recheck accepted the status updates. One plan
repair round preceded implementation. No broker or paid-call retries occurred.
Requested model routing is known; backend actual-model telemetry and token usage are
**unavailable**, not zero. No token-saving or model-quality percentage is claimed.
