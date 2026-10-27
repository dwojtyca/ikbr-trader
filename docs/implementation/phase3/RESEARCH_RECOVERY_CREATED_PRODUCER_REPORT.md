# Research recovery: never-started producer

Date: 2026-10-27. Status: implementation and local validation passed; independent final review ACCEPT; publication pending.
This report does not attest to deployment, recovered research or enabled trading.

## Problem and change

A normal disabled-write deployment recreated llm-agent with `--no-start`.
Research recovery required exited/dead and rejected Docker's created state before
saving an operation ID. Starting the provider worker to manufacture stop evidence
would introduce activity before recovery. The [bounded plan](RESEARCH_RECOVERY_CREATED_PRODUCER_PLAN.md)
adds a genuine never-started evidence variant with creation time and null
start/finish timestamps. It preserves the historical exited/dead evidence shape,
quiescence checks, challenge binding and WSH process-replacement requirement.
Additive migration 40 extends the existing audit trigger for the same variant;
it preserves legacy checks and data, and rejects malformed created evidence
independently of the application parser.

Read-only operational diagnosis found no research recovery challenge or audit
rows for the previous placeholder IDs. It found interrupted legacy Marketaux
attempts for both configured instruments and unresolved WSH attempts on the same
endpoint. Those source states are not changed by this code repair.

## Review and model routing

- Independent plan reviewer `research_created_plan_review`, requested
  `gpt-6-astra/high`: ACCEPT, no blocking findings, zero repair/escalation rounds,
  approximately three minutes. Actual runtime telemetry and token usage unavailable.
- Critical implementation worker `research_created_implementation`, requested
  `gpt-6-astra/high`: implementation complete; 43 focused tests and both affected
  package builds passed. One test-type repair; approximately
  fifteen minutes before amendment. One critical scope escalation added the database
  guard migration and direct SQL tests. Actual runtime telemetry/token usage unavailable.
- Independent hostile final reviewer `research_created_final_review`, requested
  `gpt-6-astra/high`: ACCEPT for the revised implementation, migration, tests and
  documentation; did not author implementation or plan. Independently passed 43
  focused tests and diff checks, with zero reviewer-requested code repairs. Exact
  elapsed time and actual runtime/token telemetry unavailable.
- Mechanical worker `research_created_checks`, requested `gpt-6-luna/low`:
  complete; all final checks passed. The routing guide's `gpt-5.6-luna` is unavailable in this session;
  the available stronger route was explicitly selected.

## Validation and publication

A clean archive of baseline `554946f0f0d621d9221305b1fd874f99dbf05aa9`
plus only the package changes is used; unrelated working-tree research changes
are excluded. Dependencies use the frozen lockfile. Integration uses disposable
PostgreSQL, never the operational database. Strategy/simulator behavior is unchanged;
backtests are not applicable.

Focused checks passed. Final-code lint, typecheck, unit tests (3898 passed,
355 expected skips, zero failures), workspace build and clean candidate Docker
build passed. Full isolated integration passed: 3133 tests, zero failures/skips, including
95 shared integration tests after migration 40. Scoped publication and exact-commit
CI remain pending. Candidate image: `sha256:67c91aea2a1fb31105dfc51f635d0b4889c9265378feb8f27d823b7e789c0a09`.

The first full unit invocation was denied local loopback listener binding by the
sandbox (`listen EPERM` in existing WSH wire tests). Lint and typecheck passed.
The same unit suite was rerun successfully with local test-socket permission;
tests were unchanged.

The first isolated integration run failed three new positive created-evidence
cases with `RESEARCH_RECOVERY_AUDIT_INVALID`. Migration 37 contains an independent
producer-state audit guard that the original scope and initial reviews missed.
No operational mutation or test weakening occurred. The plan is amended for an
additive migration 40, direct SQL forgery tests and migration expectations.
All required final-code checks then passed; revised final review is ACCEPT. The first candidate image
is not approved for deployment.

The independent plan reviewer accepted the migration amendment (approximately two
minutes). The final reviewer checked the full original and replacement SQL guard,
raw-SQL test bindings and migration preservation cases; the final isolated integration passed all 3133 tests. Both reviews acknowledge the initially missed SQL dependency.

Backups: the operational database archive was read-only and verified with
`pg_restore --list`; the private deployment profile was also copied before any
deployment. Migration 40 must use the existing runner and reviewed image.
