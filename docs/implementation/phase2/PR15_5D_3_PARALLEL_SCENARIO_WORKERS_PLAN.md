# PR15.5D.3 — Parallel ES scenario workers — PLAN

Status: owner directed implementation 2026-09-18; Stage B is not authorized

Date: 2026-09-18

## 1. Goal

Run the three independent ES compatibility scenarios (`primary`, `stress`,
and `primary_reproduction`) concurrently on exactly three Node.js worker
threads so each scenario can consume a separate CPU core. Preserve the
chronological, single-threaded event semantics inside each scenario and keep
the terminal v1 and v2 experiment identities, routes, requests, results, and
stored artifacts immutable.

Docker Desktop currently exposes 8 CPUs and approximately 15.47 GiB of memory.
That host capacity permits three scenario workers, but does not remove the need
for explicit per-worker and aggregate memory gates.

## 2. Version boundary

- introduce experiment ID `pr15.5d3-es-momentum-breakout-long-v1`;
- introduce new v3 request, specification, result, route, recovery, and
  canonical hash versions;
- freeze `scenarioExecutionPolicy=three-worker-parallel-v1` and
  `scenarioWorkerCount=3` in the v3 specification hash;
- do not modify v1/v2 canonicalization, IDs, routes, database rows, or terminal
  artifacts;
- reuse the registered IBKR dataset, active-contract projection, strategy,
  economics, scenarios, and acceptance gates without modification.

## 3. Runtime design

The parent process owns the experiment claim and final canonical artifact.
It launches exactly one worker for each stored scenario. Each worker:

1. opens its own `BacktestRepository` connection pool;
2. reloads and validates the registered dataset identity;
3. reloads and validates the exact active-contract projection;
4. creates only its own scenario run;
5. constructs its own `BacktestSimulator` and processes all 423,300 events
   sequentially;
6. persists progress, orders, fills, diagnostics, and terminal run state;
7. reloads identity and projection after execution;
8. returns canonical scenario metrics to the parent and closes its pool.

The parent waits for all three workers with fail-closed all-settled semantics.
Any worker error, non-zero exit, malformed/duplicate result, identity or
projection mismatch, or missing scenario produces a terminal v3
`INCONCLUSIVE` artifact. Other workers are allowed to reach a terminal state
so no run is abandoned merely because a peer failed. The parent then marks any
remaining v3 run as failed before writing the failure artifact.

## 4. CPU and memory policy

- exactly 3 scenario workers; no dynamic expansion to all 8 host CPUs;
- require at least 3 available CPUs before accepting the v3 POST;
- cap each worker V8 old generation at 3072 MiB;
- require Docker-visible memory capacity of at least 12 GiB before accepting
  the v3 POST;
- Stage A aggregate peak RSS gate: at most 10 GiB for the backtest-engine
  container, leaving at least 5 GiB of the observed Docker VM capacity for
  PostgreSQL, Docker, and host-side overhead;
- no swap, OOM, cgroup memory event, or memory pressure is permitted;
- no parallelism inside a scenario: order, position, fill, diagnostic, and P&L
  causality remains chronological.

The 3072 MiB value is a ceiling, not a reservation. Existing isolated
measurements peaked below approximately 1.3 GiB for a scenario workload.

## 5. Implementation scope

- add v3 immutable request/result boundary and golden specification tests;
- add a dedicated scenario-worker entry module;
- add a parent v3 experiment coordinator with injectable worker port for unit
  testing;
- add a v3 HTTP route and abandoned-attempt recovery;
- add a repository method that fails only running v3 scenario rows for the
  exact experiment identity;
- expose worker count/status in v3 progress/status responses without changing
  older routes;
- add Docker/runtime preflight for CPU and memory capacity;
- update PR15.5D.2 benchmark tooling with a parallel composed workload that
  measures three real no-order scenario workers concurrently and records
  aggregate container RSS/CPU.

## 6. Tests and acceptance

- prove all three worker invocations start before any is allowed to complete;
- prove `primary` and `primary_reproduction` remain byte-identical after
  removing the stored-scenario label;
- prove stress remains isolated from primary settings and rows;
- prove one worker failure yields one canonical `INCONCLUSIVE` result, no
  success artifact, and no running v3 rows;
- prove malformed, duplicate, missing, or wrong-scenario worker messages fail
  closed;
- prove insufficient CPU or Docker-visible memory rejects before claim/write;
- prove v1/v2 golden request and result hashes remain unchanged;
- run typecheck, full tests, build, disposable PostgreSQL integration, and an
  independent hostile review;
- benchmark warmup plus exactly three measured parallel full-scale runs from
  the production image on AC power;
- require aggregate peak RSS <=10 GiB and calculate a new runtime forecast
  before requesting Stage B authorization.

## 7. Stop condition

Stage A stops after implementation, tests, production-image benchmark,
forecast, report, commit, push, and green CI. The assistant must tell the owner
the forecast and explicitly wait for the owner to connect AC power and approve
the single v3 Stage B POST. No Stage B execution is included in this approval.
