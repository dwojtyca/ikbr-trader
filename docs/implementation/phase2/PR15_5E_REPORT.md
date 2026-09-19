# PR15.5E — Deterministic mechanical backtest E2E — REPORT

Status: implementation and verification complete

Date: 2026-09-19

## Outcome

PR15.5E proves the modeled backtest hot path without IBKR, Paper, or Live:

`research-only strategy -> SignalEngine -> Risk Engine -> proposed order ->`
`next-bar fill -> bracket/lifecycle exit -> PostgreSQL -> durable audit`.

The frozen 720-candle, three-contract ES fixture produced exactly six accepted
whole-contract orders and six closed trades in each scenario. One additional
signal was rejected by deterministic futures sizing before any order write.

This proves the mechanical path for the covered cases. It does not prove that
any production strategy has alpha and it does not validate broker submission,
reconciliation, or IBKR Paper/Live behavior.

## Frozen identities

- fixture schema: `pr15.5e-mechanical-fixture-v1`
- fixture SHA-256:
  `8101aefb61c7d4aea9584e1f1c59a43e118f9696e489f6479a8298a472021c6c`
- research-only strategy: `pr15_5e_mechanical_v1`
- primary reproduction SHA-256:
  `1058af9983f2a25380dece42e90129b9d4c0403362deb7aa4a98289a7f2e09f5`
- execution model: `pr15.5b-v1`
- calendar: `cme-equity-index-2024-2026-v1`

The strategy ID is absent from the production strategy registry and every
production strategy profile.

## Literal expected and actual results

| Scenario | Orders | Fills | Wins | Gross P&L | Commission | Slippage cost | Net P&L |
|---|---:|---:|---:|---:|---:|---:|---:|
| primary expected | 6 | 6 | 4 | -162.50 | 30.00 | 137.50 | -192.50 |
| primary actual | 6 | 6 | 4 | -162.50 | 30.00 | 137.50 | -192.50 |
| stress expected | 6 | 6 | 4 | -300.00 | 42.00 | 275.00 | -342.00 |
| stress actual | 6 | 6 | 4 | -300.00 | 42.00 | 275.00 | -342.00 |
| primary reproduction actual | 6 | 6 | 4 | -162.50 | 30.00 | 137.50 | -192.50 |

Primary and primary reproduction are byte-equivalent after excluding run
identity. Stress differs only through the frozen two-tick slippage and USD
3.50 per-contract-per-side commission inputs.

| Episode | conId | Primary entry/exit fill | Stress entry/exit fill | Exit reason |
|---|---|---|---|---|
| take profit | 501 | 6000.25 / 6010.00 | 6000.50 / 6010.00 | `take_profit` |
| stop loss | 501 | 6000.25 / 5990.00 | 6000.50 / 5989.75 | `stop` |
| same-bar collision | 501 | 6000.25 / 5990.00 | 6000.50 / 5989.75 | `stop` |
| contract roll | 501 | 6000.25 / 6001.75 | 6000.50 / 6001.50 | `contract_roll` |
| expiry | 502 | 6000.25 / 6002.75 | 6000.50 / 6002.50 | `expiry` |
| dataset end | 503 | 6000.25 / 6003.75 | 6000.50 / 6003.50 | `dataset_end` |

The PostgreSQL assertions independently read stored order and fill rows and
also call the production `getResearchScenarioMetrics` implementation with the
research strategy identity and contract validity windows. They prove
one-contract quantities, same-conId entry/exit, exact references, fills,
multiplier, tick size, commission, slippage attribution, execution and
calendar versions, exact aggregate metrics, lifecycle counts, zero pending
orders, zero unclosed fills, terminal completed runs, and an unchanged candle
fingerprint.

## Fail-closed evidence

- retired conId reappearance, post-expiry data, and duplicate timestamps abort
  during simulator preflight with zero order and fill writes;
- quantity below one whole ES contract creates one sizing rejection and no
  order or fill;
- an injected PostgreSQL fill-write failure marks the scenario run `failed`
  and cannot produce a completed run or fill;
- the research strategy cannot be created through the production registry;
- the fixture loader enforces a golden hash, strict schema, contiguous contract
  coverage, pre-expiry ranges, tick alignment, and independent oracle
  arithmetic.

## Verification

- `pnpm typecheck` — pass
- `pnpm test` — pass outside the filesystem/network sandbox; the first
  sandboxed attempt correctly failed because existing paper-stack tests could
  not bind loopback ports (`listen EPERM`)
- `pnpm --filter @ikbr/backtest-engine test` — 105/105 pass
- `pnpm --filter @ikbr/backtest-engine test:integration` against a disposable,
  isolated PostgreSQL container — 18/18 pass
- focused PostgreSQL PR15.5E test after repository-failure injection — pass
- `pnpm build` — pass
- compiled local artifact test — 4/4 pass
- fresh Docker image `ikbr-pr155e-validation` build — pass
- compiled test inside that image — 4/4 pass

The disposable PostgreSQL validation container was stopped and automatically
removed after the full integration suite. The existing research database was
not read or modified.

## Independent hostile review

The second-agent hostile review found and prompted fixes for the candle
fingerprint binding, production metrics path, exact invalid-data branches,
strategy interface, and pre-completion durable row validation. The integration
test also reruns the primary scenario in a fresh disposable database and
re-reads its candle fingerprint during the run; normalized durable fill rows
match the original database exactly. The final independent hostile review
approved the test path with no remaining P0/P1/P2 findings.

## Scope confirmation

No production strategy parameters, registry entries, profiles, simulator
economics, IBKR integration, execution routes, or real research dataset rows
were changed. No Paper or Live request was made.
