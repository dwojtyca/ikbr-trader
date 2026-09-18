# PR15.5D.3 — Parallel ES Stage B — REPORT

Date: 2026-09-18

Status: terminal `REJECTED_FOR_ES`; the v3 identity is closed and must not be
reused

## Authorized identity

- experiment: `pr15.5d3-es-momentum-breakout-long-v1`;
- implementation commit:
  `68b67e58b3ef845c49ca0bc6c0a3aa89a27a1647`;
- production image:
  `sha256:458cebf7df177b60e51d26434075eb8e7c7422a1762dfcb17c5d8c00e398e13d`;
- specification SHA-256:
  `adcb1c2e3821e56a8b8245992f6ea0b47e736bb0bb05e9fe5514ae861037dfb0`;
- dataset fingerprint:
  `6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026`;
- CI: GitHub Actions run 14, conclusion `success`.

Exactly one POST was accepted. No IBKR connection, broker order, execution
engine, Paper order, or Live operation participated.

## Runtime outcome

The parent launched exactly three worker threads. Docker observed approximately
300% backtest-engine CPU during parallel phases, confirming simultaneous use
of three logical cores. Peak spot observations remained near 2.1 GiB against
15.84 GiB visible capacity; no OOM or worker failure occurred.

All scenarios processed 423,300 events and completed:

- `primary`: 293 seconds;
- `stress`: 292 seconds;
- `primary_reproduction`: 292 seconds.

The complete experiment, including pre-claim validation and post-run identity
revalidation, took 531 seconds (8 minutes 51 seconds). The result was
reproducible, contained no evidence errors, and produced terminal artifact
SHA-256
`9fc53b1618a489524db1717e0b5eb812fb1d7ebdc03e9ac675f1a7198fb129d5`.

## Strategy verdict

Both primary and stress produced:

- zero closed trades, wins, losses, orders, and fills;
- zero net P&L and drawdown;
- zero open positions, pending orders, and unclosed fills;
- no invariant violations;
- strategy not permanently disabled.

The frozen gates therefore failed minimum closed trades, positive primary and
stress P&L, profit factor, and positive primary expectancy. The canonical
verdict is `REJECTED_FOR_ES`. This is a valid strategy rejection, not an
experiment execution failure. It does not authorize enabling this strategy
for ES in Paper or Live trading.

The dominant signal rejection classes were unsupported range/bear-trend and
low-volatility regimes, weak daily/hourly momentum, outside-session candles,
and higher-timeframe rejection. Parameter tuning was not performed.

## Integrity audit

- all three run rows are terminal `completed`;
- zero v3 run rows remain `running`;
- zero orders and fills were persisted;
- 45 aggregated diagnostic rows were persisted;
- primary and primary reproduction were byte-equivalent after removing their
  stored scenario label;
- dataset fingerprint before and after remained
  `6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026`;
- active-series SHA-256 remained
  `741220af6e99c90a85d73f28c5c9ab40784b91f44a2079f4bad7a50e71251411`.

## Operational deviations and disclosure

The separate production-image parallel forecast benchmark preregistered in the
PR15.5D.3 plan was not run before Stage B. The owner explicitly directed
commit, push, then Stage B; execution proceeded after green CI, prior
single-scenario timing evidence, a 20–35 minute forecast, static 8 CPU / 15.84
GiB capacity verification, and live resource monitoring. Actual runtime was
well inside the forecast.

Power checks reported `AC Power` before the POST and throughout observed
simulation checkpoints. The first check after the terminal artifact reported
`Battery Power`; the exact transition instant is unavailable. This does not
change the canonical strategy metrics or deterministic reproduction result,
but continuous AC power for the entire attempt cannot be proven and is
recorded here explicitly.

## Decision

Close the v3 identity as `REJECTED_FOR_ES`. Do not rerun it and do not activate
`momentum_breakout_long_v1` for ES. Any investigation of why no signals
survived must be a new research phase with a new preregistered hypothesis;
strategy parameters and gates must not be retroactively changed against this
terminal result.
