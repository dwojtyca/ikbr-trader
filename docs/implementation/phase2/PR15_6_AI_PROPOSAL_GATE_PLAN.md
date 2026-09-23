# PR15.6 — Mandatory AI adjudication for bound entry proposals

Date: 2026-09-23
Status: accepted by independent plan reviewer on 2026-09-23; implementation authorized by the owner workflow
Base: `9361313`; branch `codex/paper-ai-gate` in an isolated worktree.

## Goal and scope

Make the existing bound runtime persist a proposal, wait for the existing AI
agent, and submit only after a durable approval and fresh deterministic risk
validation. This is the first integration PR toward a one-instrument Paper
round trip, not a broker window or a complete lifecycle implementation.
No strategy tuning, ES work, production seed activation or broker calls in tests.
Unfinished F changes remain in the original checkout and are excluded.

## Contract and ownership

Reuse `/execution/execute-ticket` as the authenticated idempotent proposal entry
endpoint for bound entries. New and repeated clean bound entries return HTTP
200 `AWAITING_AI` with the persisted order; this endpoint never dispatches a
bound entry, including after approval. The existing `/execute-proposed/:id`
and common three-phase service perform the only approved dispatch. Runtime
maps AWAITING_AI distinctly, without UNKNOWN classification or retry.

A bound entry is any row with `instrument_id`; missing positionEffect means
OPEN_OR_ADD. All bound entries require AI; no request flag disables it.
Bound CLOSE_OR_REDUCE through these generic endpoints is refused until the
separate ownership/close PR proves reduction. Existing broker-managed SL/TP,
cancel controls and unbound legacy behavior remain except the common persisted
PASS check and safe rejection CAS. No caller can invent a close label to bypass
approval. Unbound legacy proposals remain identity-blocked; this PR does not
repair/activate that path. Legacy producer suppresses symbols assigned to an
execution-enabled bound runtime, so both producers cannot create competing
entry proposals for that selected instrument.

## Persistence and state machine

Add migration 000007 and `proposal_ai_reviews` (additive; no changes to old
migration checksums). PK/FK proposed_order_id with ON DELETE RESTRICT; bind
client_order_hash, instrument_id, conid, proposal account and session; pending
expiry fixed to database creation time + 120 seconds, never extended by retries.
Store status PENDING/APPROVED/REJECTED/EXPIRED, UUID claim token, lease expiry,
immutable decision JSON (model/prompt version, EXECUTE/REJECT, reason,
confidence, snapshots/source observation times), decision timestamp, and a
one-shot delivery-start marker plus bounded delivery outcome/error code.

Create the review in the same transaction as a bound proposal INSERT, using
its server-side position-guard account/session, never request metadata.
Preexisting bound proposals without a review fail closed; no auto-approval or
backfill of execution eligibility. Existing submitted/terminal orders retain
their broker/reconciliation behavior.

Worker claims PENDING, unexpired, unattempted proposals using a fresh UUID and
bounded lease (30 seconds; reclaim only after lease expiry). Acquire proposed
row before review row throughout claim/finalize/expiry/dispatch, using SKIP
LOCKED for polling. Finalization requires matching current token, valid lease,
unchanged identities and unexpired review; stale workers cannot publish or
execute. Decision JSON is immutable after approval/rejection; an unattempted APPROVED
review may later become EXPIRED without changing that decision evidence. REJECTED/EXPIRED atomically
terminate only a still-PROPOSED order without execution marker/broker id.
Expired pending or approved unattempted reviews are terminalized on polling and
before proposal conflict checks so they do not indefinitely reserve an intent.

Approval finalization atomically records delivery-start before returning to the
worker; the worker makes at most one execution HTTP call. A crash/timeout after
that marker is recorded as uncertain, never reclaimed for another decision,
never automatically rejected or retried. A crash before HTTP may conservatively
leave an unsubmitted approval for inspection; no exactly-once HTTP claim is made.
Execution remains fenced independently by the existing atomic submission marker.

## Existing LLM worker integration

Add a bound-review processing path to the existing llm-agent before legacy
polling, using the same configured Marketaux and OpenAI clients. Keep the
legacy `decision_source='signal'` claim isolation; exclude bound rows explicitly.
New bound path always fails closed on missing/failed sources or malformed model
output, independent of the legacy fail-open setting. Retain input account/news
snapshots and retrieval timestamps, original immutable proposal/strategy data,
and explicitly label unavailable indicator detail rather than fabricating it.
No cooldown DELETE on this path. News body is untrusted input, never an
instruction granting authority. Empty available news is represented as such.

Only the repository-fenced finalization result can authorize the worker's
single execution request. Payload actor/aiDecision is audit metadata, never the
authority. Worker stores bounded structured delivery outcomes: submitted,
pending/unknown, refused; no raw response/secrets. Server returns an authoritative
persisted decision in metadata at dispatch; caller metadata cannot replace it.

## Common dispatch guards and fresh risk

The account advisory lock additionally permits only one nonterminal bound
AI proposal/order account-wide for this mechanical scope. Creation and dispatch
check other active proposal reservations under that lock (including other
instruments); legacy pending entries also block this mechanical account. No
portfolio reservation arithmetic or multi-instrument operation is claimed.

Before broker preparation, and again under the transaction claiming the
prepared plan, require persisted riskCheckStatus=PASS and the bound review's
APPROVED status, exact proposal/hash/instrument/conId/account/session binding,
valid expiry and one-shot delivery marker. Missing/mismatched/expired approval
means zero broker dispatch. The atomic check closes expiry/rejection races.

After approval, resolve the current trusted instrument binding and execution
policy again. This first operational risk path supports only long BUY LMT,
whole-share STK in the account's configured USD base currency, with protective
stop below entry and take-profit above entry. Other shapes fail closed for
bound AI execution; no futures/FX/margin economics are inferred. No seed is
added. Exact symbol and enabling remain a later approved Paper configuration.

Read a fresh broker account snapshot using a new `getAccountSnapshot` request
that completes only at matching `accountDownloadEnd`; do not use the display
cache. Add evidence for request start/completion and USD denomination from the
broker currency mapping for NetLiquidation, AvailableFunds and GrossPositionValue.
Require all three explicitly USD-denominated, finite metrics; do not guess USD
from a configured currency or an unqualified BASE value. Snapshot request start
and completion must both meet freshness bounds. Preserve existing metric/display
behavior while exposing this additive execution-risk evidence.

Read the ingestion `/watchlist` quote for the
exact instrument/conId, with a bounded request timeout. Reject disconnected,
missing, malformed, future-dated or older-than-10-second inputs, account identity
mismatch and incomplete/nonfinite account exposure. Add per-side bid/ask observation timestamps at the ingestion IB tick callback,
propagate through TickEvent/MarketState/cache/watchlist, and require both sides
observed within the freshness window. A new last-price tick must not refresh
those side timestamps; absent old-cache timestamps fail closed. Require finite bid/ask,
non-crossed quotes and spread <= registry maxSpread; limit-to-ask distance <=
registry maxSlippage. Use limit price as the conservative BUY fill notional.

Deterministic numerical caps use explicitly validated execution config:
EXECUTION_AI_MAX_NOTIONAL_PCT=10, EXECUTION_AI_MAX_STOP_RISK_PCT=0.5,
EXECUTION_AI_MAX_EXPOSURE_PCT=25 (positive, <=100). Check quantity against both
registry and execution-policy maxima, quantity<=1 for this mechanical scope,
notional<=availableFunds and netLiquidation*notional cap,
(entry-stop)*qty<=netLiquidation*stop-risk cap, and
(grossPositionValue+notional)<=netLiquidation*exposure cap. Missing values reject.
Require policy strategyId matches proposal strategy and expected direction LONG.
The original deterministic signal/Risk Engine still runs before proposal; these
fresh dispatch rules supplement it and do not substitute an AI risk opinion.

Persist the risk assessment JSON with observed account/quote timestamps and
account/session identity. Pass its <=10-second validity to the atomic claim;
reject if inputs aged out during broker preparation or account/session changed.
Fresh exposure/reconciliation and kill-switch guards remain authoritative.
Risk failure leaves an auditable refusal with no dispatch; expiry eventually
releases an unattempted proposal. The execution-engine contains no AI reasoning.

## Safe rejection

The public reject-proposed route uses a compare-and-set rejection operation
requiring PROPOSED, no execution_attempted_at and no broker_order_id under the
same row lock. A concurrent/unknown submission cannot be overwritten. Preserve
separate broker lifecycle rejection behavior; do not globally replace broker
callbacks with the proposal-only CAS.

## Implementation surfaces

- execution-engine: migration, review read/check and atomic INSERT/claim,
  submission service, HTTP result mapping, config and fresh-risk adapter/tests;
- llm-agent: bound-review repository/worker, real client wiring, outcome-aware
  execution client, lease/decision/unknown-result tests;
- signal-engine: AWAITING_AI submit/runtime/loop mapping and legacy suppression;
- ingestion: additive quote-side timestamps and cache/watchlist propagation;
- documentation: roadmap priority, migration/operating contract, report.

## Required verification and acceptance

1. Fresh and duplicate bound proposal persists once, returns AWAITING_AI and
   makes zero broker prepare/dispatch calls; all registry seeds stay disabled.
2. Approved exact proposal through actual common service dispatches once;
   concurrent execute, poll restart, stale lease and duplicate delivery cannot
   dispatch twice or change the frozen decision. Client metadata cannot bypass.
3. PENDING, REJECTED, EXPIRED, missing review, wrong hash/account/session/conId,
   missing delivery marker, non-PASS risk, and spoofed CLOSE each dispatch zero.
4. Fake account/ingestion tests cover current/stale/malformed evidence, every
   numeric cap, unsupported currencies/assets/shapes, and data aging before
   atomic claim; successful assessment is durable and bound to the proposal.
5. Real disposable PostgreSQL tests cover migration, creation atomicity,
   competing claims, stale finalization, expiry/reject versus claim, durable
   snapshots and exactly one plan/dispatch using the production service and
   fake broker. They run with ordinary TEST_POSTGRES_URL in CI (no frozen ES DB).
6. Worker tests: real decider contract via fake HTTP clients, unavailable AI/news,
   rejection, expiry while awaiting AI, one-shot delivery, timeout/5xx/malformed
   2xx not treated as success/rejection/retry. No external paid API requests.
7. Runtime/loop handles AWAITING_AI as pending approval and preserves identity.
   Legacy suppression and claim isolation are covered; protective broker child
   processing/cancel tests remain green. No claim of full-close readiness.
8. Independent plan acceptance precedes code; new independent implementation
   reviewer checks this checklist. Run lint/typecheck/test/build plus ordinary
   disposable PostgreSQL integration and compiled relevant tests. No strategy
   or simulator change, so a new real-data backtest is neither needed nor run.
9. Record report, commit only this PR, push the branch. Owner clarification (2026-09-23): do not create a PR;
   commit + push is sufficient. The current workflow runs only for main pushes
   and pull requests, so this branch push does not trigger GitHub CI.
   No merge, deployment or Paper launch.

## Review log

Round 1: account-wide concurrent exposure and currency/BBO timestamp provenance
were identified as blockers. Revised to a single active account reservation,
broker-denominated snapshot evidence and per-side quote timestamps. Pending
review of these changes.

Round 2: independent reviewer accepted the revised plan with no remaining
plan blockers. Implementation may proceed; broker launch remains excluded.
