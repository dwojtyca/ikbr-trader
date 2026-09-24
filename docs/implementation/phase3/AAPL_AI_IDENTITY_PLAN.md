# AAPL AI identity/context correction

## Scope and outcome

Before activating the supervised one-share AAPL Paper test, replace the bound
worker's hardcoded UNVERIFIED AAPL currency/exchange with validated evidence.
Preserve the existing worker, immutable AI review, one-shot delivery, execution
risk and window gates. Main only; preserve the 29 unrelated dirty research files.
No trading activation, strategy tuning or new research provider in this delivery.

## Implementation

1. Add a narrow AAPL identity resolver used by the bound worker. Treat any AAPL
   instrumentId, symbol or conId marker as requiring the complete exact identity;
   reject partial/spoofed matches before news/model calls or delivery. Cross-check
   claim identity, order symbol/conId and, when present, persisted proposal identity.
2. Resolve the configured binding using the existing shared registry/binding
   authority, then cross-check the ingestion-owned instrument_contracts row by
   exact conId. Require stock AAPL/265598, SMART routing, NASDAQ primary exchange,
   USD, localSymbol AAPL and tradingClass NMS, consistent with the binding. Require raw
   `instrument_contracts.source === 'ibkr'` (reject null, unknown and
   override_fallback; never use a mapper that coerces unknown source to ibkr)
   and a finite, nonfuture resolved timestamp against an injectable clock; do not infer from symbol alone
   or use current quote currency as account valuation currency. Record the trusted
   fields, provenance and observation time in persisted decision context. Metadata
   resolution time is not a claim that quotes are current; execution remains the
   authority for quote/account/session freshness.
3. Missing binding, malformed configuration, absent/contradictory metadata or
   lookup failure deterministically reject AAPL review with a stable reason.
   An injected resolver is testable; omitting it for AAPL must fail closed.
   Existing non-AAPL behavior remains compatible. Do not label symbol-only news
   as issuer-verified merely because instrument identity is verified.
4. Keep the persisted proposal's technical indicators and order fields intact
   through repository mapping, worker and model request. Check complete proposal
   propagation with production repository plus worker tests. Missing indicators
   remain truthfully UNAVAILABLE rather than fabricated. Financial statements,
   earnings, macro and broader trends retain their existing unavailable coverage.
   Do not claim this patch implements full fundamental research.
5. Wire the resolver into the production bound worker. No operational proposal
   inserts, synthetic entry signals or ad hoc broker submissions for diagnosis.
   Account valuation currency remains UNVERIFIED unless independently evidenced.

## Acceptance and verification

- Independent plan acceptance before implementation; a different independent
  agent reviews final code and hostile identity/provider/delivery cases.
- Unit tests: successful AAPL evidence reaches model/audit; each identity field
  mismatch, missing resolver/binding/row, invalid provenance/time including future timestamps and lookup error
  produce zero news/model calls and zero delivery. PKO/legacy regression unchanged.
- Isolated PostgreSQL: actual contract row and proposal/indicator round trip through
  BoundReviewRepository and worker; persisted EXECUTE and REJECT decisions contain
  identical verified identity evidence; one-shot/unknown/stale-claim behavior holds.
- One bounded real-provider diagnostic uses actual read-only Gateway-derived
  metadata and technical context, a wholly fictitious account (explicit owner
  choice), a clearly synthetic proposal and a non-delivering
  in-memory store. Production resolver/worker/news/model, at most one model request
  and three news items. No operational review/proposal writes. EXECUTE and REJECT
  are both legitimate model outcomes; verify context correctness, not approval.
  This diagnostic does not establish a real strategy signal or full research.
- Clean-copy lint, typecheck, unit, isolated PostgreSQL integration, build and
  clean Docker build. No strategy behavior change; existing simulator regressions
  run in the normal suite. Update report/runbook, exact-scope commit/push and CI.
- Disabled deployment: writes/loop false, AI worker stopped, same reviewed image;
  run read-only preflight/reconciliation. Report remaining gates honestly.

## Rollback

Keep writes disabled and redeploy prior reviewed image. Preserve all durable
reviews, budgets, proposals and broker protection. Never relabel a rejected
review or replay an unknown delivery.

Independent plan review: ACCEPT after explicit raw-provenance and nonfuture-timestamp clarifications.
