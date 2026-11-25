# Ingestion contract-resolution diagnostics report

Date: 2026-11-25. Status: implementation, independent implementation/document
review and all local release checks accepted. Pre-publication source snapshot;
exact-commit CI is a separate publication gate recorded with delivery.
Baseline: `9fbdb5729e9854de094640b7aca0543ea75c8143` on main.
Contract: [accepted plan](INGESTION_CONTRACT_DIAGNOSTICS_PLAN.md).
No runtime deployment or operational broker/provider call was performed.

## Result

Contract resolution now decodes the installed `ib` 0.2.9 error shape
`error(Error, { id, code })` as well as the positional form. A matching broker
rejection retains its sanitized original name, code and message and terminates
the request under the resolver's existing intended failure policy. Previously
that metadata shape was ignored by both contract resolvers and could appear as
a timeout. This code defect does not establish the cause of the observed
November 25 PKO incident: the historical logs supplied no matching broker error.

The strict and legacy collectors share event wiring while retaining their
different result-count policies and the existing legacy override fallback.
Eight-second production deadlines, retry/backoff, read fences, transport disposal,
pacing, binding checks and trading controls are unchanged.

Structured Polish start/terminal events and additive `/health.contractResolution`
data show request/generation correlation, allowlisted query identity, response
and end counts, timeout/elapsed time, local SDK call observations and captured
transport milestones. SDK return is explicitly not wire or broker-receipt
evidence. A timeout without a matching error states that the broker-side cause
is unknown. Synchronous terminal events freeze their evidence before any later
SDK return/throw; diagnostic observer failures cannot change read outcomes.

Global broker/farm messages stay separate from request causes. Connection-loss
context is captured before existing synchronous retirement aborts a pending read.
Retired transport events cannot certify replacement state. Snapshot accessors
copy retained data and do not evaluate continuity or invalidate generations.

Health retains at most twenty completed request snapshots and eight global
messages per transport with omissions. A separate first-twenty current-bootstrap
failure list prevents later AAPL successes from evicting an early PKO failure.
The controller snapshots that list before incomplete-bootstrap invalidation and
clears attribution for a new attempt, unrelated later failure or later success.
Original errors, identity fields, global context and fallback logs use shared
privacy sanitizers plus local URL/payload-fragment scrubbing. Raw payloads,
stacks, wire buffers, account lists and endpoints are not added to diagnostics.

## Changed scope

- `apps/ingestion/src/tws-client.ts`: collector error handling, lifecycle evidence,
  bounded snapshots, sanitized broker/contract-failure logging.
- `apps/ingestion/src/contract-resolution-diagnostics.ts`: local typed records,
  Polish summaries, allowlisting, sanitation and isolated event delivery.
- `apps/ingestion/src/auto-bootstrap.ts` and `index.ts`: additive incomplete-
  attempt attribution and production logger/privacy/health wiring.
- `apps/ingestion/src/contract-resolution-diagnostics.test.ts` and
  `auto-bootstrap.test.ts`: hostile fixtures and observer-failure regressions.
- Plan and this report. Existing contract-details/wake suites were reused without
  modification. Unrelated backtest/signal-engine/recovery-report work was excluded.

## Targeted validation

Commands ran against the working source with fake IB adapters and existing shared
build artifacts; database tests were skipped without a test connection.

| Command | Result |
| --- | --- |
| `pnpm --filter @ikbr/ingestion exec node --import tsx --test src/contract-resolution-diagnostics.test.ts src/auto-bootstrap.test.ts` | Exit 0; 29 passed, zero failed |
| `pnpm --filter @ikbr/ingestion test` | Exit 0; 223 tests, 218 passed, five database tests skipped, zero failed |
| `pnpm --filter @ikbr/ingestion typecheck` | Exit 0 |
| `pnpm exec eslint` with the six changed TypeScript files listed above | Exit 0 |
| `git diff --check` | Exit 0 |

Fixtures cover metadata/positional errors, unrelated IDs and farm context,
zero/partial timeout, end-with-zero/ambiguity, sync success/error followed by
return/throw, throwing observers/state accessors, abort/late deadline, generation
replacement, retained-copy isolation, independent failure/history bounds,
PKO failure plus AAPL success through controller invalidation, subsequent
unrelated failure/success, encoded secrets/accounts and payload redaction.
Existing sleep/wake and strict-contract regressions also passed.

An initial new reconnect fixture incorrectly supplied only the initial fake IB
object; replacement instantiated the adapter against dummy `unused:0`, ending
in a twelve-second connection timeout. The fixture was corrected to supply
`ibFactory`, keeping replacement transports fake. It never used operational
broker settings. One targeted fixture repair passed the rerun. The initial
`tsx` CLI invocation hit sandbox IPC `EPERM`; its required escalated rerun was
performed. Final focused verification used the repository's native
`node --import tsx --test` pattern and passed.

Local evidence logs: `/private/tmp/ikbr-contract-new-tests.log` and
`/private/tmp/ikbr-contract-targeted-final.log`. These are local validation
receipts, not versioned artifacts or operational readiness evidence.

## Review and routing

| Task | Requested model / effort | Actual telemetry | Evidence / repairs |
| --- | --- | --- | --- |
| Plan and implementation, `diagnostics_contract` | `gpt-6-astra` / high | Unavailable to worker | Accepted plan; targeted checks above |
| Independent plan review, `diagnostics_plan_review` | `gpt-6-astra` / high | Unavailable | Accepted after one plan repair round, no escalation |
| Lead implementation scrutiny | Inherited lead model; exact identifier/effort unavailable | Unavailable | Encoded identity redaction and exception isolation of diagnostic hooks/accessors incorporated |
| Independent final review, `diagnostics_final_review` | `gpt-6-astra` / high | Unavailable | Code and report accepted without findings; independent focused suite 53/53 passed |
| Mechanical validation, `validation_setup` | `gpt-5.6-luna` / low | Unavailable | Clean archive, isolated PostgreSQL and full release checks; lead reran sandbox-blocked unit tests |

The final reviewer was distinct from the plan reviewer and implementer, and made
no source changes or operational calls. Plan review resolved synchronous SDK/callback evidence isolation and independent
bounded current-bootstrap failures. Implementation test repair count: one fixture
repair. Critical-scope escalation count: zero. Exact task elapsed time and token
usage are unavailable; no telemetry estimates are presented.

## Full release validation

Validation uses a clean archive of the baseline with only the six changed
TypeScript files and reviewed plan overlaid. SHA-256 comparison confirmed that
the tested source matches the working package. Unrelated pre-existing files were
excluded and their baseline content hashes remained unchanged.

| Check | Result |
| --- | --- |
| `pnpm lint` | Exit 0; two pre-existing unused eslint-disable warnings |
| `pnpm typecheck` | Exit 0 |
| `npm_config_workspace_concurrency=1 pnpm test` | Exit 0; 4,549 tests: 4,110 passed, 439 database-dependent skips, zero failures |
| `pnpm build` | Exit 0 |
| Clean-context Docker build | Built `sha256:3eea7f3bd5b44db3f0eba598eb447d62fc4b62734c4e72acd1714746160dba18` for isolated validation only |
| `pnpm test:integration` | Exit 0; 3,349 passed, zero failed/skipped, isolated PostgreSQL |

The first full unit run was blocked by sandbox `EPERM` when a fixture attempted
to listen on localhost. The identical suite passed outside the sandbox; no
source, deadline or assertion was changed to obtain that result. The integration
runner uses the dedicated PostgreSQL container's network namespace and the
existing CI test-only URL guard, never the operational database. No strategy or
simulator behavior changed, so no additional backtest was required.
The source manifest is `/private/tmp/ikbr-contract-diag-manifest.sha256`; complete
release logs are `/private/tmp/ikbr-contract-{lint,typecheck,test-escalated,build,docker-build,integration}.log`.
Integration totals aggregate all six packages; the last package alone has 575 tests.

## Publication boundary

This report is the source snapshot prepared before publication. Publication is
gated on exact-commit GitHub CI; the final
delivery receipt records the published commit and CI URL/conclusion. Neither
fixtures nor a successful release prove PKO market-data recovery. The public
GitHub Actions API is available for CI evidence although local `gh` is absent.
