# PR15.5D.3 — Parallel ES scenario workers — REPORT

Status: implementation complete; Stage B terminal `REJECTED_FOR_ES`

Date: 2026-09-18

## Outcome

The v3 experiment runs `primary`, `stress`, and `primary_reproduction` in
exactly three independent Node.js worker threads. The operating system may
schedule those workers simultaneously on separate cores; the implementation
does not claim CPU affinity, which Node.js does not expose portably. Every
scenario remains chronologically sequential inside its own worker.

Each worker owns its repository pool, dataset/projection validation,
simulator, run row, and terminal cleanup. The parent owns only the immutable
experiment claim, worker state aggregation, reproducibility comparison, and
canonical terminal artifact. It uses all-settled failure handling and marks
any remaining v3 run failed before persisting `INCONCLUSIVE`.

The v1 and v2 routes and identities are unchanged. Golden v1 and v2
specification hashes remain frozen. The new v3 specification hash is
`adcb1c2e3821e56a8b8245992f6ea0b47e736bb0bb05e9fe5514ae861037dfb0`.

## Capacity policy

- exactly three scenario workers;
- at least three process-visible CPUs;
- at least 12 GiB process/cgroup-visible memory;
- 3072 MiB V8 old-generation ceiling per worker;
- the separately authorized Stage B execution is recorded in
  `PR15_5D_3_STAGE_B_REPORT.md`.

The Docker Desktop observation supplied by the owner (8 CPUs and 15.47 GiB)
satisfies the static capacity gate. This is capacity, not a promise that each
thread is pinned to a named core or that all memory is free at runtime.

## Verification

- backtest-engine typecheck: PASS;
- backtest-engine unit tests: PASS (101 passed, 0 failed, 1 PostgreSQL test
  intentionally skipped under unit-only mode);
- monorepo typecheck: PASS;
- monorepo build: PASS;
- coordinator barrier test proves three simultaneous active scenario calls;
- failure test proves one failed worker produces `INCONCLUSIVE` and invokes
  scoped running-run cleanup;
- route tests prove CPU/memory rejection happens before dataset access or
  claim;
- full monorepo tests: PASS (the first sandboxed attempt could not bind local
  fixture ports; the unrestricted verification run passed);
- CI run 14 for implementation commit `68b67e5` passed before Stage B.

## Hostile review

No release-blocking code defect was found. Residual operational risks are
database/I/O contention between three workers and OS scheduler variability.
They affect duration, not scenario ordering or experiment identity. A worker
thread is deliberately not replaced or retried after an unknown failure.

## Stage B disposition

The owner explicitly authorized the single Stage B POST after commit and push.
The production-image parallel forecast benchmark described by the plan was not
run as a separate workload before the POST; the owner chose to proceed after
the prior single-scenario measurements, green CI, static capacity checks, and
the 20–35 minute forecast. Live execution confirmed three-core utilization and
completed in 531 seconds. See the Stage B report for the terminal evidence and
the disclosed late power-source transition.
