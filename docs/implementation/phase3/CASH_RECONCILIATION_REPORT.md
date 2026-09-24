# CASH reconciliation implementation

The [accepted plan](CASH_RECONCILIATION_PLAN.md) corrects the false securities
position mismatch after a currency conversion. Live execution callbacks preserve
security type; additive migration 000013 records nullable type and durable identity
or type conflicts. Missing type cannot erase known evidence. Unknown legacy fills
need exact matching current complete broker execution evidence for CASH exemption.
No symbol or exchange heuristic classifies currency trades.

The securities comparison excludes only proven CASH fills and explicitly CASH
broker positions; raw broker snapshots, fills, quantities, orders and financial
account evidence remain intact. Stocks, unknown types and actual securities
mismatches keep their existing comparison. Conflicting evidence fails closed.
An existing false CASH position-mismatch hold can resolve only through the audited
runner after complete source coverage, exact identity proof and ambiguity checks.
No manual hold clearing or database quantity repair was performed.

Independent review identified a late-fill race between initial classification and
publication. Publication now revalidates the exact sorted scoped raw-fill evidence under
unattributed-fill and account snapshot locks. Normal fill upserts and commission-
first inserts participate in those locks. A late unknown fill, type conflict or
commission-first row aborts publication, including a prospective CLEAN run without
an existing hold. Final coverage and submission ambiguity are rechecked under the
same publication locks.

Independent implementation review ACCEPT: 24 pure tests and 23 isolated PostgreSQL
tests passed independently, including six late-evidence races and a real concurrent
three-writer serialization test. Broader targeted integration tests passed 38/38.
Full clean-copy, Docker, exact-commit CI and disabled deployment results follow when
completed. Trading remains disabled throughout delivery and preflight.

## Final local validation

The reviewed clean copy passed lint, typecheck, build and Docker build. Unit run:
2,309 PASS with 48 database-dependent skips; isolated PostgreSQL integration run:
1,944 PASS, zero failures/skips. Root integration now includes ingestion and
signal-engine so both provenance SQL regressions run in GitHub CI.
Image digest: `sha256:8ecfef6061192f6f01e35c6eb855b08d3b8d91796561c83a41a507b53b44c3d8`.
All 29 unrelated research files remain byte-for-byte unchanged. Exact-commit CI
and disabled deployment/preflight remain pending at this commit; no AAPL order
or run window has been activated.
