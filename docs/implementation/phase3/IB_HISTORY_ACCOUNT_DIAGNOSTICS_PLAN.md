# Completed history cleanup and account subscription diagnostics

Date: 2026-10-13. Baseline: 6b45a8e416f24710704bd2c3ea9166a3dc4a3e6b.
Owner request: prevent redundant cancellation (366) after completed history and
prove the source of recurring five-second account unsubscription warnings (2100).

## Bounded implementation

1. In ingestion `tws-client.ts`, `session-schedule-adapter.ts` and
   `aapl-schedule-adapter.ts`, distinguish broker completion from local validation.
   A matching finished/historySchedule event ends broker work before parsing or
   validating its payload. Never cancel that completed request, including when
   its completed payload fails validation. Preserve cancellation of unfinished
   requests on existing failure/timeout paths. Cleanup is idempotent; late or
   unrelated events must not cause repeated cancellation or settlement. Catch
   synchronous historical send failures and release owned timers/listeners.
   Keep existing native-only cancellation policy in TwsClient and all data,
   pacing, contract, session and freshness validation unchanged.
2. In execution `tws-execution-client.ts`, add bounded, non-secret account-update
   trace records to the existing logger: local snapshot sequence, connection
   generation, monotonic elapsed milliseconds, subscribe invocation, matching
   accountDownloadEnd, cleanup reason and unsubscribe invocation. Observe the
   installed ib@0.2.9 `sent` event only for account-data command 6; log only a
   validated subscription boolean and local timing/context, never raw frame,
   account ID, account value, token or arbitrary broker payload. A wire event records local socket.write invocation, not broker receipt. Its
   observedDuringSequence context does not attribute it to a particular request.
   Retain latest local phase after cleanup; annotate 2100/2101 with this context
   while preserving the original broker message unchanged. Clear timing context
   at connection transitions so an old connection cannot explain a new warning.
   Diagnostic code must not throw into the broker event loop or change snapshot
   resolution, polling cadence, subscriptions, risk evidence or eligibility.
3. Verify the existing five-second call chain (LifecycleObserver -> close refresh
   -> broker refresh coordinator -> getAccountSnapshot) from source. Deploy the
   reviewed build using the existing authorized continuous Paper runbook and
   observe ordinary cycles. Report actual ordering and its limits: timing alone
   cannot rule out a simultaneous external client. Do not generate extra broker
   requests to diagnose it or suppress 2100 as harmless without evidence.

## Acceptance and checks

- History success sends no cancel; completed empty/invalid payload still rejects
  without cancel. Unfinished timeout/error cancels once, cleans listeners and
  ignores late/unrelated completion. Include synchronous send failure regression.
- Schedule adapters preserve contract/session validation and socket retirement.
- Account trace covers success, timeout/fatal-error cleanup, late wire/error
  notifications, next cycle, connection transition, malformed wire events and
  absence of raw account/frame values. Original error text remains available.
- Existing snapshot behavior and freshness checks remain unchanged; no trading
  activation bypass, strategy change, persistent subscription or polling change.
- Focused tests, pnpm lint/typecheck/test/test:integration on isolated PostgreSQL
  (55432), pnpm build, clean Docker build; no strategy backtest required.
- Independent Astra/high plan review before edits and a different Astra/high
  hostile implementation review. Scoped main commit/push and exact-commit CI.
- Recheck entry pause/reconciliation/exposure before deployment; use existing
  supported stop/start, retain image/config backup and inspect post-deploy logs.

## Delegation and publication

Astra/high lead owns account trace semantics, integration and operational checks.
Sol/medium worker owns only the three ingestion files and their corresponding
focused tests under this accepted contract; escalate semantic changes to lead.
Independent Astra/high reviewers do not author implementation. Mechanical route
requested by policy (gpt-5.6-luna/low) is unavailable in this selector; capable lead
runs checks/publication. Record review/repair counts, timing and available usage
in the report. Existing unrelated dirty backtest and signal-engine work is
excluded from publication and clean Docker context. No branch or PR.
