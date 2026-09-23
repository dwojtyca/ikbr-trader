# PR15.6 — mandatory AI approval for bound entries

Date: 2026-09-23
Status: independently accepted; all local checks passed.

## Delivered behavior

A bound runtime ticket creates an idempotent proposal and returns `AWAITING_AI`.
It does not prepare or dispatch an IBKR order, even if the same ticket is posted
again after approval. The LLM worker claims the separate durable review, gathers
account and news context, calls the configured model, and freezes the decision
and source evidence. Missing providers, failed context retrieval or malformed
model output reject the proposal. The worker records a delivery marker before
its single execution HTTP call; uncertain responses never trigger another call.

The existing common submission service requires the exact persisted approval
and refreshes deterministic risk before preparing and atomically claiming the
order plan. This scope permits only one active account intent and one whole-share
USD stock BUY limit entry with a stop and take-profit. It validates current
registry policy, explicit USD broker metrics, completed account snapshot, confirmed
live bid/ask observations and numerical risk caps. Inputs must remain younger
than ten seconds through the atomic claim. Existing order-plan and reconciliation
fences continue to own uncertain broker submissions.

Legacy signal production skips execution-enabled registry symbols; legacy polling,
expiry and retention exclude bound proposals. Public proposal rejection is now a
compare-and-set operation that cannot overwrite a submission already attempted.
Bound generic close requests are refused until the separate lifecycle work.
Broker-managed protective orders and existing cancellation are unchanged.

## Migration and configuration

Migration `000007_proposal_ai_reviews.sql` adds the review table and immutable
identity/decision trigger. Run through the existing execution migration runner
before the worker uses the new table. Existing bound proposals receive no approval
backfill and cannot execute. No seed or strategy is enabled by this migration.

Reviews expire after 120 seconds; polling claims last 30 seconds. An expired
approval without an execution attempt becomes `EXPIRED`, preserving its decision
and delivery marker. A submission with `execution_attempted_at` or broker identity
is never terminalized by this expiry mechanism. The HTTP delivery marker is an
at-most-once worker fence; the separate execution marker is the broker uncertainty
fence. Inspect durable outcome and reconciliation rather than retrying manually.

Configuration additions:

- `EXECUTION_INGESTION_BASE_URL`: ingestion origin; Compose uses
  `http://ingestion:3101`, local example uses `http://localhost:3101`.
- `EXECUTION_AI_MAX_NOTIONAL_PCT=10`.
- `EXECUTION_AI_MAX_STOP_RISK_PCT=0.5`.
- `EXECUTION_AI_MAX_EXPOSURE_PCT=25`.

Percentages must be positive and at most 100. Existing LLM/provider configuration
is reused. No secret is added to tracked files. Old cached quotes without both
side timestamps or confirmed live data type fail closed until fresh data arrives.

## Verification and review

Independent plan review accepted the revised scope before implementation.
A new independent implementation reviewer accepted the final code after fixes
for normalized-ticket identity and approved-review expiry. PostgreSQL integration
also found and verified the correction of bigint proposal IDs to domain numbers.
Older bound-ticket tests were updated to expect a durable pending review and
zero dispatch; the independent reviewer accepted that test correction.

Final checks passed:

- `pnpm lint`: zero errors; three pre-existing unused-disable warnings.
- `pnpm typecheck` and `pnpm build`: all workspace packages pass.
- `pnpm test`: 1,405 tests pass (PostgreSQL suites are gated separately).
- `TEST_POSTGRES_URL=... pnpm test:integration`: 465 tests pass, including
  18 new actual execution-service cases and seven LLM review repository cases.
  This command also repeats existing execution unit coverage; counts are not
  disjoint from the ordinary test run.
- Compiled Node test selection: 196 pass, covering risk, broker/cache provenance,
  AI worker/repository, actual submission service and runtime mappings.
- `git diff --check`: clean.

The ordinary test run requires loopback ports for its local HTTP fixtures; the
restricted-sandbox run was stopped and repeated with that access. Integration
uses a dedicated temporary PostgreSQL server, never the running research DB.
Tests use disposable PostgreSQL and fake broker/provider transports; no external
AI/news requests or IBKR orders are part of verification. No new backtest is needed
because strategy calculations and simulation behavior are unchanged.

## Remaining milestone

This PR does not establish Paper readiness or profitability. Next: prove close
ownership, bracket-child cleanup, partial fills/restarts and final flat-state
reconciliation; then approve one contract and perform a controlled Paper window.
Broader financial/news research and strategy tuning follow mechanical validation.
Original PR15.5F work remains outside this isolated branch.

The owner requested commit + push without creating a PR. Current GitHub CI
triggers only on main pushes or pull requests; this branch will therefore have
local check evidence, with no remote CI run claimed.
