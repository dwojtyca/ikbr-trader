# Current failure and recovery rules

Reviewed 2026-09-26. This page supersedes early retry/timeout assumptions.
[State model](STATE_AND_RECONCILIATION.md), [Paper target](../phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md).

| Failure | Current required behavior |
| --- | --- |
| Invalid contract/policy/strategy or failed risk | No dispatch; expose reason; fix configuration through reviewed scope |
| Missing auth/account mismatch | No mutation; do not retry with broader permissions |
| No signal or AI REJECT | Valid non-entry result; no fabricated signal or repeated model call to seek approval |
| Provider unavailable/invalid output/expired claim | No approved delivery; preserve rejection/expiry and diagnose coverage/deadline |
| HTTP timeout/disconnect after handoff | UNKNOWN; no automatic resubmission; reconcile broker ownership/state |
| Broker cancel acknowledgement missing | Cancellation unproven; no replacement close or release merely because time elapsed |
| Stale quote/session/account/reconciliation | Block new entries; fresh evidence is required before resumption |
| Broker protection fills while close starts | Recompute owned remaining quantity using supported lifecycle; never oversell |
| Close unfilled/failed after protection cancelled | Critical incident; current operator observation/recovery required |
| Database unavailable before durable reservation | Do not send broker order; reconcile any previously attempted work after recovery |
| Configuration mismatch | Planned PP1 explicit gate; current consumers still independently parse old settings |

Source timeout defaults are defined by application schemas, not a universal 1-second
cycle or independent connect-timeout promise. Current AI claims last30s and context
requests are sequential; PP4 addresses the total deadline. Polling/repeating a
read is different from resubmitting a write. Even the same ID is not a recommendation
to replay an unknown operation blindly.

## Current operator boundaries

Use existing authenticated reconciliation/lifecycle APIs and the applicable
[PKO](../../runbooks/GPW_PAPER_ROUND_TRIP.md) or
[AAPL](../../runbooks/AAPL_PAPER_ROUND_TRIP.md) procedure. Only current broker
quantity plus durable ownership can authorize the supported close. An unsupported
legacy position or fractional residual requires an implementation extension or
owner-operated broker action, never an ad hoc API bypass.

TRADING_ENABLED=false blocks new guarded writes and also current full close; it
does not cancel protection or flatten. Expiring the entry window likewise does
not close. Do not confuse kill/pause state with a safe flat account. The production
Paper plan introduces an explicit entry pause and automated exit supervision;
those are not available merely by following this documentation.

No automated IBKR UI, unknown-submission retry, local-row deletion as closure proof,
reversal during close or new request ID to defeat a hold. Unresolved uncertainty
requires escalation, not increasingly permissive flags.
