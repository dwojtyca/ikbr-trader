# Current state, identity and reconciliation

Reviewed 2026-09-26. [Runtime flow](RUNTIME_FLOW.md), [current limitations](../CURRENT_STATE.md).

## Sources of truth

IBKR owns actual orders, executions, positions and account state. Postgres owns
our intent, configuration/approval evidence, dispatch reservations, audit and
ownership mappings. Disagreement is resolved using verified broker facts, never
by deleting local evidence or assuming a timeout cancelled an order.

proposed_orders carries client_order_id/client_order_hash and bound instrument
identity. proposal_ai_reviews records claims, decisions and delivery status.
Broker links/order-ref maps establish ownership; prefix matches alone are not
ownership. Reconciliation runs retain source coverage and holds; lifecycle/close
operations retain original proposal identity and current broker observations.
See [migration directory](../../../infra/sql/migrations/) and
[repository](../../../apps/execution-engine/src/repository.ts).

## Durable entry ordering

Persist proposal and pending review -> claim/review -> persist decision and delivery
marker -> fresh execution checks -> reserve broker plan -> dispatch -> broker
observation/reconciliation. This is conceptual ordering, not a replacement for the
actual database status enums. A claim/HTTP success does not imply broker acceptance.
Unknown submission remains reserved and cannot be retried under a new ID.

clientOrderId/clientOrderHash travel in the request body and are validated server
side. Existing hashes must not be recomputed under future strategy-instance/config
schemas. Broker orderRef assists correlation; do not rely on IBKR deduplicating
arbitrary repeated submissions by orderRef. Durable local reservations and verified
broker observations provide the safety boundary.

## Coverage and recovery

The production adapter now requests completed-order evidence through a dedicated
client as well as positions/open orders/executions. This closes the original
missing-source defect; it does not prove all ambiguous cancellations or lost API
order IDs can be recovered. Distinguish exposure completeness from recovery
completeness and apply the actual account/instrument hold gates.

Latest durable readiness rejects stale/future snapshots, incomplete exposure,
account/session changes and failures. A previously CLEAN row cannot lend freshness
to a newer failed observation. Known unrelated external contracts may coexist under
explicit identity/risk rules; their presence is not blanket permission to ignore
account exposure. See [completed source report](../phase3/GPW_COMPLETED_ORDERS_REPORT.md)
and [preflight closure](../phase3/GPW_PREFLIGHT_CLOSURE_REPORT.md).

Restart must re-establish broker/session evidence before entries. Current
process-local in-flight maps are concurrency conveniences, not restart-safe duplicate
protection. No document prescribes a retention/garbage-collection policy for live
ownership records that the code has not implemented.

## Full-close and future attribution

Current supported full-close is one whole long stock share with original ownership
and deterministic close-risk evidence. See [full-close report](../phase3/PR16B_FULL_CLOSE_REPORT.md).
PP2 adds separate instance/revision/config attribution; PP3 generalizes Paper budget
and completion records; PP5 automates observation/recovery. All must preserve old
positions and consumed attempts through migrations and config rollback.

The current signal execution runtime is Paper-only. There is no implemented PR18
checklist that enables Live by a flag in this path.
