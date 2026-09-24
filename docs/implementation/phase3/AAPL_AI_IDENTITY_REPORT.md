# AAPL AI identity/context correction — implementation evidence

## Scope

Correct the bound AI review context for exact AAPL stock proposals. The resolver
cross-checks proposal identity, configured binding and raw ingestion-owned IBKR
contract metadata. Successful evidence distinguishes SMART routing from NASDAQ
primary listing and provides USD, STK, local symbol, trading class, provenance
and metadata observation time. It does not establish quote freshness, account
valuation currency or issuer verification of symbol-only news.

AAPL-like partial identities, missing/contradictory evidence and invalid provenance
or timestamps must reject before provider calls or delivery. Existing non-AAPL
behavior, immutable review storage, claim expiry, one-shot delivery and execution
risk/window guards remain unchanged. Persisted technical indicators must survive
repository/worker/model propagation unchanged.

Financial statements, earnings, macro and broader-market coverage remain outside
this correction. A model may legitimately REJECT an otherwise correctly formed
proposal. A diagnostic approval is not a real strategy signal or broker permission.

## Workflow and verification

Independent bounded plan review: ACCEPT, with explicit raw source validation and
nonfuture metadata timestamp requirements. Independent implementation review: ACCEPT. The reviewer ran 58 targeted tests,
including 13 isolated PostgreSQL tests, with no failures or skips. Full final
checks and delivery are recorded below.

The explicitly authorized provider diagnostic ran at 2026-09-24 18:40 UTC with
real read-only AAPL metadata and technical indicators, a wholly fictitious account
and a synthetic memory-only proposal. No real account ID, balance or positions
were read or sent by the diagnostic. Production resolver, worker, Marketaux and
OpenAI clients were exercised. Its store cannot authorize delivery; no operational
proposal/review was inserted.

Results: one `gpt-5.4` request, three news items, 4.124 seconds total (within the
30-second claim lease), zero dispatches and no second claim. Model and worker
returned REJECT, confidence 0.72, citing high volatility, mixed intraday momentum
and limited news identity evidence. This is a valid adjudication, not an integration
failure. Model input contained AAPL/265598/STK, SMART routing, NASDAQ primary
exchange, USD, raw IBKR provenance and verified binding. Technical indicators
were unchanged and AVAILABLE; news remained SYMBOL_MATCH_ONLY. Unavailable
fundamental/macro coverage was not upgraded or invented.

Full clean-copy install, lint, typecheck and unit tests passed. The first full
integration run reported temporal window/snapshot failures in unchanged execution
tests while Docker built concurrently. A subsequent clock check found host and
test PostgreSQL aligned within approximately 1 ms after connection setup.
The unchanged clean-copy integration rerun without concurrent build passed,
followed by a successful `pnpm build`; the precise initial cause has not been
established. A clean Docker build passed. All required local checks now pass.
Code commit `dd165beb1bee6f57766d5a07d81052e12e8f96ab` passed
[GitHub CI run 36043197455](https://github.com/dwojtyca/ikbr-trader/actions/runs/36043197455),
including PostgreSQL integration tests. The successful local integration rerun
contained 1,997 passing tests, with zero failures or skips.

## Disabled deployment verification

The reviewed image `ikbr-trader-gpw:dd165be`, digest
`sha256:bb7f87caf8a20b02fc3e1d4d384dfdcc5ef9d602898de557dc918b6f8f070466`,
was deployed to ingestion, signal-engine and execution-engine. All three are
running on that exact image; llm-agent was recreated on the same image and remains
stopped (Docker state `created`). No entry window was opened.

After restart, ingestion bootstrap returned HTTP 200 and subscribed AAPL/265598.
At 2026-09-24 18:49:36 UTC, reconciliation completed CLEAN, `/ready` returned
HTTP 200 with `ready=true`, no failure reasons and `tradingEnabled=false`.
The read-only stack verifier subsequently returned HEALTHY, exit 0, with
12 healthy and two intentionally disabled checks. It observed fresh AAPL ticks
and a healthy registered runtime. Writes and the trading loop remain disabled.
This verifies the disabled deployment, not an executed Paper entry/exit or
complete fundamental research coverage.

Paper writes and loop remain disabled; AI worker remains stopped outside the
isolated diagnostic.
