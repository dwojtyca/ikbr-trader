# Marketaux article reference fragment repair

2026-11-03. Status: independently accepted implementation; local checks completed; exact-commit CI and deployment pending. Baseline 31c945f1bf124464312396bb918aa7f57655e955. Scope follows the independently accepted [plan](MARKETAUX_REFERENCE_FRAGMENT_PLAN.md).

## Problem and intended behavior

A fresh AAPL acquisition at 2026-11-03T12:15:38Z was rejected at pass 1, page 1, zero-based record 2 solely because its publisher URL contained a fragment. This is a local policy defect for an unfetched article reference, not evidence of an unavailable Marketaux connection. WSH and PKO Marketaux acquisitions had succeeded separately. Do not infer current trading readiness from those historical observations.

Allow fragments only for Marketaux publisher article references. Generic URL validation and all transport, source, permission and evidence URL checks stay strict. Preserve the provider's original URL including fragment in the record-set hash; no stripping, canonicalization, dropping records or weakened two-pass comparison. Other rejection predicates, diagnostics privacy, qualification, coverage, budgets, pacing, risk and account guards remain unchanged. Historical failed attempts are retained. No strategy change or relevant backtest is required.

## Review and validation evidence

Independent plan reviewer /root/fragment_plan_review, requested/actual gpt-6-astra high: ACCEPT, no blockers. Implementation worker /root/fragment_implementation, requested/actual gpt-6-astra high. Independent implementation reviewer /root/fragment_final_review, requested/actual gpt-6-astra high: ACCEPT after test-only narrowing repair. Worker focused checks passed 55 tests and shared build. Independent reviewer passed 73 focused tests plus llm-agent typecheck. Two test repairs: a 2000-character fixture boundary and union narrowing in the publication assertion. No production-code repair or scope escalation. Token usage unavailable. Full check results will be recorded after completion.

Lead uses a clean committed baseline export with only scoped files and a disposable PostgreSQL instance. The operational database is excluded from all tests. Existing unrelated working-tree changes are preserved and excluded from staging/builds. Publication, exact-commit CI, clean deployment image, private backup, actual paper verification and fresh provider acquisition remain separate release gates; none is claimed by this in-progress report.

## Completed local checks

Lint passed with two existing warnings; typecheck, build and clean Docker build passed. Unit suite: 4020 passed, 377 environment-dependent skips. Isolated integration stages total 3222 tests passed after a targeted rerun: the first run passed shared (114), execution (2271), backtest (18), and llm-agent (85), then ingestion had one administrator-terminated test-database connection in unchanged auto-bootstrap.pg-integration.test.ts. No application or test was changed for that failure. The complete ingestion stage rerun passed all 160 and the remaining signal stage passed all 574. No skips in integration. Initial typecheck/Docker failure from the new test union access was fixed with an explicit runtime assertion before these final checks. Reviewed scoped source hashes match the tested export; unrelated edits excluded.

Publication and CI are verified after this committed report revision. Deployment evidence is recorded privately with exact image/commit and live paper account observation; this document does not claim that accepting fragments guarantees a complete provider response or a trade.
