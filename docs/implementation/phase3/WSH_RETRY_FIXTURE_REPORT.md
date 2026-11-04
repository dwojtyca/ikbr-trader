# WSH BUSY retry SQL fixture repair evidence

2026-11-04. Baseline `29d4e1f`. Status: implemented; deterministic isolated
reproduction and full focused suite passed; independent final review accepted.
Scope follows the accepted [plan](WSH_RETRY_FIXTURE_PLAN.md).

## Cause and change

The lead inspected authenticated [CI run 41644447207](https://github.com/dwojtyca/ikbr-trader/actions/runs/41644447207).
The BUSY invalid-provider-code SQL assertion received
`research_wsh_refresh_attempts_check13` instead of the expected
`research_wsh_retry_known_failure`. Migration 33 requires local closure at or
before cleanup completion, but the fixture evaluated independent volatile clock
calls for those timestamps. PostgreSQL evaluated cleanup completion before local
closure in this UPDATE, despite the SET text listing local closure first.

Both direct SQL BUSY fixtures now use `statement_timestamp()` for settlement,
local closure, cleanup completion and retry's 30-second base. All invalid-code
inputs and exact denial assertions remain, including the linked UNKNOWN
acquisition denial and charged-reservation/history assertions. The valid numeric
10281 positive control additionally checks timestamp equality and exact 30-second
retry spacing in PostgreSQL, preserving microsecond precision. Production source,
SQL migrations, cleanup proof, retry policy and broker behavior are unchanged.

## Deterministic reproduction

Disposable copies of the test installed a database-local function that sleeps
10 ms and returns its timestamp argument. Only the two fixture UPDATEs wrapped
their clock calls in that function. No wrapper or sleep is committed.

- Old fixture with invalid-code cases: exit 1, exact CHECK13/known-failure mismatch
  matching the CI log.
- Old valid numeric 10281 control alone: exit 1, CHECK13. This isolates cleanup
  ordering from the intended provider-code denial.
- Repaired fixture with the same delays: exit 0, both direct SQL tests passed
  (2/2, no skips), including all invalid-code inputs and positive timestamp checks.

The test image was `ikbr-trader:rebuild-20261104`; each run mounted only its test
copy read-only and used the isolated `ikbr-startup-retry-test-20261102` PostgreSQL
network. The command ran from `/app/packages/shared` using
`node --import tsx --test`, with a name filter only for the disposable proof.
An initial invocation from `/app` could not resolve package-local `tsx`; correcting
the working directory resolved that setup error without changing source.
Evidence copies and logs are in the private temporary directory
`/private/tmp/wsh-fixture-clock-proof-20261104`.

The complete, unmodified-by-proof `wsh-recovery.pg.test.ts` passed 32/32 tests,
zero skips, exit 0, in 43.3 seconds on the same isolated database.

## Review and release boundary

Plan author/implementation worker: `/root/ci_fixture_repair`, requested
`gpt-6-astra` / high. Independent plan reviewer: `/root/cleanup_audit`, requested
`gpt-6-astra` / high, ACCEPT with zero findings. Independent implementation review
was accepted with zero findings by a different agent, `/root/startup_retry_final_review`. Requested
routes were accepted by orchestration; independent model attestation, exact
per-agent elapsed time and token usage are unavailable. No source repair round or
scope escalation occurred after plan acceptance.

Lead-owned full lint, typecheck, unit, isolated integration, build, clean Docker
build, scoped publication and exact-commit CI remain separate release gates.
Deployment remains under the existing authorized Paper rollout. These fixture
results do not prove current provider coverage, trading readiness or a trade.

## Lead validation

Clean-source Docker build passed. Lint passed with two existing warnings and
zero errors; typecheck passed. The first unit run inside the application image
failed only the two unchanged Compose configuration tests because that image
has no Docker CLI (`spawnSync docker ENOENT`). No test or application code was
changed for that environment limitation. A clean host export with the reviewed
test patch, frozen-lockfile dependencies and Docker CLI then passed `pnpm build`
and the entire `pnpm test`: 4020 passed, 377 expected environment-dependent skips,
zero failures. The offline dependency setup initially lacked a cached package;
normal frozen-lockfile installation completed successfully. Full isolated
integration and exact successor CI are recorded after they complete.

Full isolated `pnpm test:integration` passed with exit 0: 3222 passed, zero
failures and zero skips (shared 114, execution 2271, backtest 18, llm-agent 85,
ingestion 160, signal 574). It used only the disposable PostgreSQL container;
operational data was not used for test fixtures. Local release checks are complete.
Scoped publication and exact successor CI remain pending at this source freeze;
the lead records subsequent deployment evidence privately without claiming
that local tests establish current Paper trading readiness.
