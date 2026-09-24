# Completed Filled records with zero total — bounded prerequisite for AAPL

## Evidence and scope

The disabled Paper preflight still returns INCOMPLETE because the completed-order
adapter rejects a real terminal Filled record. A dedicated read-only capture of
the installed @stoqey/ib 1.6.10 callback confirms totalQuantity is exactly zero,
filledQuantity is positive and finite, and state.status is Filled. The decoder
reads both decimal fields directly. Private account/order/quantity evidence stays
in /tmp; committed tests use synthetic quantities. Do not infer an original total
from a human-readable completedStatus string.

This first delivery fixes reconciliation only. The separately planned AAPL profile,
USD caps, supervised window and data preflight follow it. Trading stays disabled.
Preserve all 29 unrelated research files and work on main.

## Implementation

1. Keep strict account, contract, permanent ID, action, terminal-status and quantity
validation. Accept exactly one additional representation: status Filled,
totalQuantity === 0 and finite positive filledQuantity below Number.MAX_SAFE_INTEGER.
For that representation retain broker filledQuantity and set remaining to zero,
as asserted by terminal Filled status. Do not fabricate totalQuantity, executions,
positions, ownership, API IDs or lifecycle transitions.
2. All positive-total records retain current filled <= total validation and Filled
equality. Reject negative, missing, string, nonfinite or unset totals and invalid
filled values. Cancelled/ApiCancelled/Inactive zero-total records remain rejected.
A Filled zero/zero record remains rejected. Preserve end-marker requirement,
account/session fences, exact duplicate handling and historical coverage limits.
3. Add unit regression cases for the accepted zero-total representation and hostile
neighbors above. Check exact normalized filled/remaining and conflicting duplicate
refusal. Add a production completed-client/composite-adapter/runner PostgreSQL
regression using an external synthetic completed record: current-session complete
sources can finish CLEAN, snapshot/observation evidence retains filled and zero
remaining, without creating bot ownership or mutating proposals. Invalid variants
remain INCOMPLETE. Existing ambiguous-history coverage tests must remain intact.

## Acceptance and delivery

Independent plan reviewer ACCEPT, implementation, different independent reviewer
ACCEPT including hostile cases. Run targeted tests, full clean-copy pnpm lint,
typecheck, test, isolated-Postgres test:integration and build; clean Docker build.
Write sanitized report; exact-scope commit/push main and exact CI. Deploy execution
image only with Paper writes/loop still off and Warsaw timezone unchanged. Perform
normal reconciliation, verify completed coverage and inspect any remaining holds.
CLEAN is claimed only from actual evidence; no manual DB status repair. Record
results and independent document review, commit/push/report CI. No order submission
or automatic test activation belongs to this prerequisite change.
