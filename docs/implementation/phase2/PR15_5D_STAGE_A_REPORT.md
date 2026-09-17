# PR15.5D Stage A — ES compatibility runner — REPORT

Date: 2026-09-17

Status: Stage A complete; implementation committed, independently approved,
and verified by green CI run `35215511842`

## Outcome

Stage A implements the pre-registered, one-shot ES compatibility experiment
runner without executing the experiment against the real ES dataset. No
strategy result, trade count, P&L, or acceptance verdict has been observed.

The frozen experiment-spec SHA-256 is:

`4afee9646d4f8aea18f35effca741c2cc80c82195b5519f6a88161077a65dff6`

The immutable Stage-A implementation commit SHA is:

`304f2e90bf860d720ea41b5d11d439c072da7943`

Stage B remains unauthorized until separate owner approval.

## Delivered boundaries

- strict request validation binds experiment ID, spec hash, implementation
  commit, provenance, and dataset fingerprint;
- the loader accepts only `ikbr_trader_backtest_pr15_5a`, one finalized dataset,
  the exact manifest, five contracts, and roll policy;
- production read-back recomputes the fingerprint from PostgreSQL contract and
  candle content and checks the candle count;
- `momentum_breakout_long_v1` remains `STK`/`IND` in production; only an
  unregistered research adapter admits `FUT`;
- primary, stress, and primary-reproduction scenarios use frozen simulator
  assumptions and a single strategy/symbol/direction;
- an atomic experiment claim backed by a session-level PostgreSQL advisory
  lock, scenario uniqueness, and a process-local reservation prevent duplicate
  experiment creation across processes;
- startup recovery can acquire the lock only after the former owner session is
  gone, then marks partial runs failed and persists a canonical terminal
  `INCONCLUSIVE` artifact;
- canonical metrics, gate rows, verdict, and result SHA are persisted without
  database-local run IDs or wall-clock timestamps in the result fingerprint;
- ordinary mutable history and run routes remain locked on the research
  database;
- the implementation does not call IBKR, the execution engine, llm-agent, or
  any broker order API.

## Verification

- `pnpm lint`: pass, zero errors (three pre-existing unused-disable warnings);
- `pnpm typecheck`: pass;
- `pnpm test`: pass when local dynamic fixture ports are permitted;
- `pnpm build`: pass;
- `pnpm test:integration`: pass; the generic command skips PostgreSQL suites
  without `TEST_POSTGRES_URL`;
- targeted disposable-PostgreSQL repository integration: 4/4 pass, including
  non-creating absent-database detection, cross-process atomic claim,
  live-owner protection, restart recovery, futures audit metrics, diagnostics,
  and result persistence;
- backtest-engine tests: 81/81 pass;
- signal-engine tests: 419/419 pass;
- `git diff --check`: pass.

An isolated PostgreSQL 15 container was used to exercise the protected exact
database name without touching the real ES database. The protected-database
suite passed 11/11, including rejection of synthetic content by the production
Fastify/registered-identity boundary, three actual synthetic simulator
scenarios that do not claim the registered identity, auditable
orders/fills/commission/slippage, contract-roll exits, meaningful diagnostics,
immutable content checks, and a global external `fetch` trap. Together, both
PostgreSQL suites passed 15/15.
The temporary container was then stopped and removed.

The first hostile review correctly rejected the initial implementation for
classifying integrity failures as economic rejection, incomplete spec-hash
coverage, missing terminal failure artifacts, and insufficient integration
coverage. Remediation now makes invariant/fingerprint failures
`INCONCLUSIVE`, persists a canonical terminal `INCONCLUSIVE` artifact after a
started attempt fails, hashes exact contracts/roll dates/policies and execution
assumptions, uses recursively sorted canonical JSON, and adds the missing
route/concurrency/protected-database tests.

A subsequent hostile review found that the first durable scenario was created
too late to make the HTTP acceptance atomic across processes and that a process
crash could leave no terminal artifact. It also found that the synthetic
protected-database fixture produced zero trades. Remediation added the durable
claim/session-lock lifecycle and restart recovery described above, plus a
250-candle, two-contract simulator fixture that produces and audits one
contract-roll trade in each of primary, stress, and primary-reproduction.

The final remediation persists `INCONCLUSIVE` for failures before the first
scenario, makes abandoned-attempt recovery atomic across the experiment and
partial-run rows, proves rollback-and-retry after an injected database failure,
and separates production identity rejection from synthetic execution coverage
so no synthetic dataset can produce an artifact claiming the registered real
fingerprint.

Recovery reads and validates the original durable `request_json` while holding
the experiment lock, so an interrupted attempt is always attributed to the
implementation commit that actually claimed it, even if recovery runs under a
newer build.

When the protected research database has not been imported yet, startup now
detects its absence through the administrative database and skips recovery
without creating it or preventing the ordinary backtest service from starting.

The first sandboxed full-test attempt was not a product failure: the sandbox
denied fixture `listen()` calls on dynamic loopback ports. Re-running the same
command with local-port permission passed.

## Stage B hold point

Before any real execution:

1. obtain explicit owner approval for Stage B using the commit SHA and spec
   hash above.

Until then `BACKTEST_RESEARCH_IMPLEMENTATION_SHA` remains empty and the
dedicated POST endpoint returns `503` without creating a run.
