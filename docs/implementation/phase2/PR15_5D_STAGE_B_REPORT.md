# PR15.5D Stage B — ES compatibility experiment — REPORT

Date: 2026-09-17

Status: the one authorized attempt is closed with terminal `INCONCLUSIVE`;
the PR15.5D experiment is incomplete

## Outcome

The single authorized operational attempt was accepted once by the dedicated
endpoint and failed closed before processing a candle. No strategy performance
metrics were produced. The result does not accept or reject the strategy for
ES, and it does not authorize Paper, Live, or production activation.

## Authorized identities

- experiment ID: `pr15.5d-es-momentum-breakout-long-v1`;
- implementation commit:
  `d833146b4a16228d364b082193b7d7ddd891f7ad`;
- experiment-spec SHA-256:
  `4afee9646d4f8aea18f35effca741c2cc80c82195b5519f6a88161077a65dff6`;
- provenance: `ibkr-es-20250622-20260831-e39a59790324`;
- dataset fingerprint:
  `6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026`.

CI run `35217385649` was green before renewed owner authorization. The current
HEAD differed from the approved implementation only by documentation.

## Operational evidence

The preflight endpoint returned `artifact: null` and
`researchJobRunning: false`. Exactly one POST returned `202 Accepted`. Only
PostgreSQL and backtest-engine were running; no ingestion, signal, LLM,
execution, TWS, or IB Gateway service participated.

The terminal database state contains:

- one finished experiment claim;
- one failed `primary` scenario run;
- zero progress, orders, and fills;
- no `stress` or `primary_reproduction` run;
- canonical verdict `INCONCLUSIVE`;
- evidence error `experiment_execution_failed:Error`;
- result SHA-256
  `efedef18335d2e471023879ea4ffe968a833928f840883f658274c2c30808a45`.

The production read-only loader recomputed the registered fingerprint after
the failure over 483,608 one-minute candles and five contracts. It matched the
pre-run fingerprint exactly. The immutable dataset was not modified.

## Root cause

The raw research dataset intentionally contains overlapping contract history
around rolls. Of 483,608 one-minute rows, 423,300 fall within their contract's
registered active `valid_from`/`valid_to` window. There are 60,302 timestamps
with multiple raw contract rows.

`BacktestRepository.loadBacktestData()` loaded every ES row ordered by
timestamp. The research path did not first project a single continuous active
contract series using the registered validity windows. The simulator's
futures integrity validation therefore raised:

`Futures candles for ES overlap or are not strictly ordered`

This is a Stage A implementation and test-coverage defect. The synthetic
PostgreSQL fixture generated only one contract per timestamp, while runner
unit tests stubbed the production data loader, so the real overlap shape was
not exercised before Stage B.

## Independent hostile review

The second agent independently verified the durable experiment/run rows,
recomputed the canonical failure hash, confirmed the unchanged dataset
fingerprint, and reviewed the relevant loader, simulator, runner, fixtures, and
pre-registration constraints. Verdict: `APPROVE` closing this Stage B attempt
as `INCONCLUSIVE`, with no rerun or resume.

## Next permitted step

Prepare a separate remediation plan, tentatively PR15.5D.1. It must project the
continuous active-contract series from immutable raw rows, fail closed when
zero or multiple rows are active, and add PostgreSQL integration coverage with
real pre-roll overlap, exact roll boundaries, expected selected counts,
simulator execution, and unchanged raw fingerprint.

The correction must not mutate the dataset, tune strategy parameters, reuse or
replace the terminal experiment claim, or activate FUT in production. A new
experiment ID, implementation identity, and frozen specification hash require
a new hostile review, green CI, and explicit owner authorization of the exact
implementation commit and specification hash before any new real experiment.
