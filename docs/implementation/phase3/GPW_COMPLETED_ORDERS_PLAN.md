# GPW — completed-order evidence for reconciliation

## Observed problem and source evidence

Disabled-write deployment of c5e8576 succeeds. PKO real-time bid/ask now arrive
after Gateway restart. Production reconciliation remains INCOMPLETE because
IbBrokerReconciliationAdapter hardcodes completedOrders unsupported.

Installed @stoqey/ib1.6.10 exposes reqCompletedOrders(false), completedOrder and
completedOrdersEnd. Its decoder does NOT receive API orderId/clientId in completed
records; permId/orderRef/account/contract/status are available. Never substitute
permId for orderId or invent a completed-record broker ID. Official API reference:
https://interactivebrokers.github.io/tws-api/classIBApi_1_1EClient.html
The API supplies a retained completed-order list, not an arbitrary historical
range. An end event alone cannot prove absence for an ambiguous past submission.

## Bounded design

1. Add a dedicated read-only completed-order client using installed @stoqey/ib.
   Unique configurable nonzero client ID (default120), validated against execution,
   ingestion, metadata and known research client IDs. No order/write API in its port.
   For each serialized capture, create a new socket, wait for nextValidId and verify
   managed account, request all completed orders with apiOnly=false, collect until
   completedOrdersEnd. Do not bind manual orders or use clientId0.
2. Validate account/contract/permId, action, total/filled quantities and status.
   Preserve terminal status; unknown/malformed target-account records make source
   unavailable. Known other managed-account records may be excluded only after
   identity validation. Reject conflicting duplicates. Do not derive fill price,
   execution time or commissions from completion messages.
3. Bound connect+request lifetime by source timeout/AbortSignal. Cleanup timer,
   listeners and socket on every path. Disconnect/account change/broker error or
   timeout never produces a successful empty snapshot. Await bounded asynchronous
   disconnect before releasing the serial queue. Unconfirmed shutdown fences this
   client until restart; retain only a stateless late-error sink after cleanup. Ignore only documented
   informational farm messages. Concurrent callers serialize; queued aborted
   callers never connect. Capture execution connection generation before/after all
   reads; session/account/generation changes invalidate the composite capture.
4. Integrate as a fourth source with current production reconciliation adapter and
   index wiring. Source available only on validated end, expose meaningful failure
   reasons. Persist the observed rows even when their API orderId is unavailable
   (explicit null); do not synthesize broker-order observations or auto-match such
   rows. Keep existing positive recovery behavior for rows with actual IDs.
5. Conservative recovery coverage: if there is an ambiguous historical submission,
   completed-order boundedWindow remains false with an explicit historical-window
   unproven reason. Never infer never-submitted/cancelled from an empty result.
   With no ambiguous submission, a successful current completed list can complete
   source coverage and allow CLEAN if all other existing checks pass. Exposure
   coverage remains independently derived; no hold, risk or write gate relaxation.
   Mark successful coverage based on no ambiguity as current-state-only. Runner
   revalidates this basis against ambiguous proposals loaded AFTER capture: if any
   currently evaluated ambiguous proposal exists, downgrade boundedWindow and
   recoveryComplete before matching, status, snapshot persistence and reporting.
   This fences submissions appearing during capture; it is not historical proof.
   Update readiness classification to require completedOrders.boundedWindow as well
   as available, and audit every source-coverage consumer for the same distinction.
6. Document the completed-order limitation and recovery policy. No schema migration
   is needed for JSON snapshot rows; update nullable brokerOrderId type and exclude
   missing-ID rows from matching/observation insertion explicitly. Keep all existing
   exact-identity safeguards and no-unknown-retry rules.

## Verification and delivery

- Independent plan acceptance, implementation, separate hostile implementation review.
- Fake socket tests: handshake/account, apiOnly=false, empty/full end, missing ID,
  malformed data/conflicting duplicates, informational vs fatal errors, timeouts,
  disconnect, abort before/while queued/requesting, serialization and cleanup.
- Production adapter tests use real completed client with fake transport: successful
  coverage, failure/old ambiguity fenced, execution generation change fenced.
- PostgreSQL runner: actual adapter successful no-ambiguity capture yields CLEAN;
  unavailable source yields INCOMPLETE; ambiguous missing-ID record cannot be linked
  or automatically resolved, even across multiple records sharing absent IDs.
- PostgreSQL race: no oldest ambiguous attempt at capture start, a submission
  attempt appears during capture; published snapshot/report must remain INCOMPLETE,
  without absence inference. Readiness must reject available but unbounded coverage.
- Full lint/typecheck/unit/integration/build, clean Docker build, report, commit/push
  main and exact CI. Preserve unrelated research files and trading-disabled settings.
- Deploy reviewed image with writes/scheduler/AI disabled, trigger readonly evidence
  capture/reconciliation, inspect PKO quotes/history, account PLN and SMR without
  altering SMR. Run verifier and report actual remaining launch blockers.
- No entry/close/cancel orders, paid provider calls or trading-window activation.
