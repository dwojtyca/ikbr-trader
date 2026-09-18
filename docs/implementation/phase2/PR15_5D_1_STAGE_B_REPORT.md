# PR15.5D.1 — Stage B report

Date: 2026-09-18

Status: terminal `INCONCLUSIVE`; no rerun is permitted under the v2 identity.

## Authorized identity

- experiment: `pr15.5d1-es-momentum-breakout-long-v1`
- implementation: `ab072e752eb6d9e53ed79ce49b182e3c8e4133e5`
- specification SHA-256:
  `22ae7af844f549d06d3eaa64715556ca028d1dee69cbd35254f55e48d82ff85e`

Exactly one POST was accepted after the registered raw, active 1m, and all six
higher-timeframe identities passed the pre-claim check.

## Outcome

The primary scenario started but did not reach the first 10,000-event progress
checkpoint after 3,085 seconds. It had 423,300 total events, sustained roughly
one CPU core, used less than 0.6 GiB memory, and showed no error or OOM. The
observed upper bound of fewer than 10,000 events per 3,085 seconds implied more
than 36 hours per scenario and more than 108 hours for three scenarios at the
then-observed rate.

The owner authorized a controlled abort because this runtime was operationally
unacceptable. The same image was restarted without another POST. Startup
recovery marked the run failed and persisted a terminal canonical artifact:

- verdict: `INCONCLUSIVE`
- evidence error: `experiment_interrupted_by_process_restart`
- result SHA-256:
  `4bd17e9fab5ea15150810b784da3afa4a04e959ab5511b72dae666ddd520b44c`

The durable post-recovery state was audited as follows:

- exactly one finished v2 experiment claim and exactly one v2 run;
- the sole run was the failed `primary` run, with runtime 3,085 seconds and
  progress `0 / 423300` because the first durable checkpoint is at 10,000;
- zero stress runs and zero primary-reproduction runs;
- zero orders, zero fills, zero diagnostics, and zero strategy-state residue;
- the interrupted partial computation was invalid evidence and was not used in
  any acceptance metric or result claim.

After recovery, a new read-only preflight reverified 483,608 raw rows, 423,300
active 1m rows, provenance `ibkr-es-20250622-20260831-e39a59790324`, immutable
raw fingerprint
`6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026`,
active-series SHA-256
`741220af6e99c90a85d73f28c5c9ab40784b91f44a2079f4bad7a50e71251411`,
and the registered 5m/1h/4h/12h/1d/1w counts and SHA-256 identities. The result
hash was independently recomputed from the frozen request plus recovery error,
and the stored v1 artifact was independently reread; both matched the values in
this report.

The original v1 artifact remains byte-for-byte unchanged at
`efedef18335d2e471023879ea4ffe968a833928f840883f658274c2c30808a45`.
No broker, execution-engine write, Paper order, or Live operation occurred.

## Decision

The v2 identity is closed and must not be reused. A new attempt requires a new
implementation, specification hash, experiment ID, owner approval, and a
pre-run full-scale runtime forecast. Strategy economics and acceptance gates
remain frozen.
