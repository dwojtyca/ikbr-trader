# GPW3 — bounded PKO Paper window preparation

Date: 2026-09-24. Status: ACCEPTED by independent gpw3_plan_review after window/finality amendments.
Base: main ba9d2bd; GPW2B CI 35929293402 succeeded. No branch/PR creation.

## Outcome and scope

Prepare the existing one-share PKO WSE/PLN flow for a separately authorized,
supervised Paper round trip. This engineering stage must not enable trading,
change .env, deploy services, make paid AI/news calls, or submit broker orders.
Use the existing momentum_breakout_long_v1 strategy, mandatory AI gate,
deterministic risk, bracket and full-close services. Profit is reported, never
an acceptance requirement. No new strategy, tuning, forced signal or AI approval.
Preserve all 29 unrelated dirty ES research files byte-for-byte.

## 1. Strategy prices and configuration

The loop currently discards the winning strategy's suggested entry/SL/TP and
builds prices from the latest quote plus fixed policy distances. Carry explicit
winning strategy levels through the runtime/pipeline/ticket builder and legacy
mapper. Missing, nonfinite or incorrectly ordered levels must fail closed in
the WSE path, with no fallback to fixed distances. Keep legacy behavior when
explicit strategy levels are absent on non-WSE paths.

Fetch current account/contract-bound GPW2B metadata through a read-only execution
endpoint and a timeout-bounded internal HTTP reader. Normalize strategy levels
BEFORE ticket hashing/persistence and AI review: BUY limit rounds down, protective
SELL stop rounds down, SELL profit limit rounds up, using each final price's own
band (including crossings). Validate positive stop < entry < target after rounding.
Record raw/final levels and source metadata in proposal indicators/context. Reject
stale/foreign/malformed metadata. Execution continues to validate freshly fetched
rules and never changes approved prices. Tests cover band boundaries, changed
metadata, missing levels, exact mapper/hash persistence and zero submit on failure.

Add a trusted disabled PKO profile: one share, long, LMT DAY bracket, no outsideRTH,
no partials/trailing. Defaults remain disabled. Provide explicit configuration-only
activation of this sole profile through a shared registry factory used consistently
by ingestion, signal and execution; default registry remains immutable/disabled.
Reject malformed opt-in, and keep trading master switch, account allowlist and
binding gates separate. No production environment flag is set in this stage.

## 2. History and strategy readiness

Audit exact strategy/regime dependencies. WSE must not use an IB 8-hour candle
mislabeled as 12h. Scope WSE stock context to supported native timeframes and
explicitly document/test the omitted 12h regime contribution; existing other
instrument behavior is unchanged. Native WSE higher-timeframe bars must be closed,
correctly identified and sufficient in count; incomplete UTC-derived/flush bars
must not overwrite them. Bootstrap skip requires enough valid bars, not only a
recent timestamp. Keep existing pacing and sequential request budget. No giant
historical fetch during engineering. The loader must refuse incomplete warmup,
future/unfinished/stale data, wrong contract and missing required indicators.
Expose actionable warmup counts/reasons using existing progress/status surfaces.
Behavior tests/backtest fixtures exercise existing strategy and WSE context.
Required WSE TF/minima: 1m220, 5m50, 1h50, 4h50, 1d50, 1w50. Omit 12h
from both loader requests and regime indicator snapshot. Persist native provenance
so old indistinguishable/UTC-derived PKO rows cannot count as trusted warmup
until requalified by native refresh; suppress ALL WSE higher-TF derived/flush
writes. Serialize periodic native refresh with bootstrap and existing pacing,
requesting only due TFs. Conservative finality: intraday start+duration, daily
next Warsaw calendar day, weekly next Warsaw Monday. This may delay readiness;
it must never admit a partial bar. Expose required/available/native-closed counts.
Accepted amendment by gpw3_plan_review: native WSE freshness is measured from
that same conservative bar END, retaining existing maximum ages; non-WSE stays
start-based. Check exact age boundary, beyond, future/unfinished end, overnight
stale and non-WSE regression. Refresh due time follows next native finality,
not elapsed bootstrap phase, with bounded retries and existing pacing.

## 3. Durable one-entry budget and window

Server configuration defines an explicit run id, account id, ISO start and end;
maximum window 60 minutes, exact PKO identity, one entry attempt. No defaults
that open a window. Configuration may be prepared while trading is disabled.
Add a versioned migration with durable window identity and consumed proposal id.
Windows use [start,end), a single Warsaw date, inside 09:05–16:45 Warsaw
weekday policy. Pending proposals are durably bound to their creation run id;
a different configured run never adopts an old pending proposal.
No reset/rearm endpoint. A changed configuration for an existing run id fails
closed. The same account has at most one consumed PKO entry per Warsaw date,
so changing run id or restarting cannot silently replenish the same-day budget.

Check window before new proposal creation and before broker prepare. Under the
existing account advisory lock, validate database time, account/contract/window,
and consume the budget in the SAME transaction as the execution-attempt marker,
AI/risk evidence and exact broker plan. Any pre-commit failure rolls back all;
any post-commit uncertainty permanently consumes it. AI rejection/no broker
attempt does not consume the entry budget. A later terminal/flat position does
not permit another entry. Expiry stops new entries, never cancels protection.
Lifecycle cancellation/close/reconciliation remain independently authorized.
All known PKO aliases/unbound paths fail closed; callers cannot choose run id.
Recheck persisted claim/run identity and window time immediately before dispatch;
the TWS adapter also checks the server-bound deadline after reconnect, immediately
before its first placeOrder. Expiry after claim sends nothing and leaves the
budget consumed/claim unresolved for operator reconciliation, never replenished.
Read-only window status explains missing/expired/consumed/config mismatch.
PG tests cover concurrency, restart, altered id/config, expiry at claim, rollback,
unknown dispatch, claim-to-dispatch expiry, old pending proposals after run change,
second entry after flat and unchanged USD behavior.

## 4. Honest AI and round-trip evidence

Record explicit availability for technical indicators, instrument-matched news,
company financial statements, macro/trends; never claim missing sources were
researched. PKO news identity must not silently trust an unrelated same-symbol
listing. Unsupported/empty context is clearly recorded; retain existing fail-
closed provider/output behavior and mandatory decision. No paid calls in tests.

Add a scoped read-only proposal/account/conId round-trip report from consistent
repository evidence rather than rewriting legacy /trades. Correlate every fill
through persisted broker refs/ids to entry/protective/full-close legs. Show raw
fill prices/quantities/currencies, fee currency and missing commissions. Compute
gross PLN P&L only for exact complete one-share entry+exit. Net PLN is null when
fees are missing or in another currency; never silently add mixed currencies
or turn unknown fees into zero. Broker zero realized P&L remains a valid value.
Fix reconciliation expected-position identity to use fill currency, not fee
currency. Acceptance requires current complete broker flat/no orphan orders,
final reconciliation and AI/risk/ownership evidence; absence is NOT_PROVEN,
not success. Test missing/mixed fees, partial/unrelated/ambiguous fills, multiple
accounts/contracts, broker zero P&L, stale snapshot, protective and manual exits.

## 5. Supervised runbook and stop boundary

Create a dedicated GPW runbook with exact configuration/commands and preflight:
Paper account+allowlist, correct contract, real-time PKO BBO, PLN cash, no foreign
exposure/orders/holds, complete warmup, market metadata/session, worker/provider
configuration, fresh reconciliation, and fresh one-entry window. Recommended
limits retain GPW1 values: quantity1, PLN notional500, stop-risk5, fee reserve30;
normal existing USD account caps also apply. The existing momentum strategy keeps
its UTC08–20 filter: earliest10:00 Warsaw in summer and09:00 in winter. Recommend
starting after10:05 Warsaw; no threshold/time filter tuning in this scope.
Configure a short supervised window
well before 16:45 Warsaw, with an operator exit deadline before the session ends.

Describe no-signal/AI-reject as inconclusive mechanics; do not force an entry.
Normal exit stops producer first while write authorization remains on, then
existing lifecycle close/reconcile and verify flat/no orphan orders; only then
turn master writes off. Emergency master-off does not promise automatic flatten.
Unknown outcomes require reconciliation/operator review, never blind retry.
Document that current code evidence does not prove a real Paper round trip or
profitability. Launch is a separate owner decision after all runtime preflight.

## Review and delivery

Independent plan reviewer must ACCEPT; correct until accepted. Implement only
above scope. A different independent reviewer verifies all acceptance criteria
and production wiring; correct until ACCEPT. Run pnpm lint, typecheck, test,
TEST_POSTGRES_URL=<isolated local DB> pnpm test:integration, build, relevant
strategy behavior fixtures. Produce GPW3 report with limitations and exact tests.
Commit only reviewed scope, push main, verify exact GitHub CI; preserve unrelated
work. Any code changes after failed checks return to review. Stop after delivery.
