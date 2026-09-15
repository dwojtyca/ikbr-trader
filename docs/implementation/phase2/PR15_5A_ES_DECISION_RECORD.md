# PR15.5A — ES compatibility decision record

Date: 2026-09-15

Decision: `INCONCLUSIVE`

## Basis

The current repository cannot produce reproducible evidence that
`momentum_breakout_long_v1` is suitable for ES. Its implementation supports
only `STK` and `IND`, while the backtest engine lacks a complete futures model
for tick rounding, per-contract costs, CME sessions, expiry, and roll behavior.
Historical candles are stored globally in a mutable dataset without a durable
dataset identity or immutable fingerprint.

## Consequences

- Shared momentum profiles are narrowed to their actual implementation
  support: `STK` and `IND`.
- Production futures support and ES activation remain forbidden.
- No ES data acquisition, backtest, Paper E2E, or broker operation is approved.
- The next permitted stage is a separately planned PR15.5B futures backtest
  model.
