# PR15.5D.1 — Stage A report

Date: 2026-09-17

Status: Stage A implemented and locally verified; Stage B remains blocked pending
separate owner approval naming the final implementation commit and specification
hash.

## Outcome

The PR15.5D failure was remediated with a research-only active-contract
projection. The generic backtest loader and production strategy registry remain
unchanged. The new v2 path selects one registered active contract per minute,
derives every higher timeframe from that selected 1m series, verifies the full
identity before claiming, and uses a new experiment ID and result schema.

No strategy was instantiated against the real research dataset during Stage A.
No real P&L, trade count, v2 claim, run, or artifact was created.

## Frozen identities

- Stage A implementation commit:
  `ab072e752eb6d9e53ed79ce49b182e3c8e4133e5`
- experiment ID: `pr15.5d1-es-momentum-breakout-long-v1`
- v2 specification SHA-256:
  `22ae7af844f549d06d3eaa64715556ca028d1dee69cbd35254f55e48d82ff85e`
- active 1m rows: 423,300
- active-series SHA-256:
  `741220af6e99c90a85d73f28c5c9ab40784b91f44a2079f4bad7a50e71251411`
- expected active minutes: 423,360; missing: 60; maximum consecutive gap: 1;
  entirely missing sessions: 0

| Timeframe | Rows | SHA-256 |
| --- | ---: | --- |
| 5m | 84,672 | `95de2564dfd3b7a78c52bff4e74c697f35ebdaf08db8c3bd59c246c8153f3881` |
| 1h | 7,059 | `62585b6b905024e05e404193aa1d541d972797fc9f0fc37df3ca8a3b0f7db766` |
| 4h | 1,841 | `1304537302c509244605b8e87c9ad7a9243aafd6536ac99bfa12d400b643619d` |
| 12h | 618 | `70e1c9370e78841a1f4ac26c54d2158541e0e7ffb79161ba6433462a35636dc8` |
| 1d | 309 | `c14c10db80fadf4f9b961b639498d9ac929a8b622decd502b67a68168c978ab9` |
| 1w | 66 | `5b9ca2e97fb115e4332b3733451a86e32cf9e95e3fede63cde301543db359cde` |

Two independent read-only real-data preflights reproduced the complete frozen
1m and HTF evidence exactly. The second pass compared against the registered
values and exited successfully.

## Verification

- backtest unit tests: 93/93 passed;
- disposable PostgreSQL tests: 17/17 passed, including overlap before and after
  roll, fail-closed evidence mismatch, one durable concurrent v2 claim, three
  versioned scenarios, and v1 isolation;
- lint: passed with three pre-existing warnings and no errors;
- monorepo typecheck: passed;
- monorepo build: passed;
- monorepo tests: passed (the loopback fixture suite was run outside the
  filesystem/network sandbox because it opens dynamic local ports);
- full monorepo integration gate: passed; execution-engine 371/371 and
  backtest-engine disposable PostgreSQL 17/17;
- real research DB audit: v1 result remains
  `efedef18335d2e471023879ea4ffe968a833928f840883f658274c2c30808a45`;
  v2 run count remains zero;
- `git diff --check`: passed.

The first independent hostile review found test-evidence gaps. They were
remediated by adding post-roll overlap, durable v2 route/claim coverage,
fail-closed expected-evidence coverage, and the exact terminal v1 hash
regression. The renewed independent hostile review approved the implementation
with no remaining P0-P2 findings.

## Hold point

Stage B is not authorized. It may begin only after the owner separately approves
the final Stage A implementation commit and v2 specification SHA-256 above.
