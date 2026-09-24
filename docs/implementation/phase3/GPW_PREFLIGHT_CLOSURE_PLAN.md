# GPW preflight closure — three observed integration defects

## Scope and authorization

Owner requested closure of the three observed blockers, followed by disabled-write
Paper deployment/preflight. Work on main; preserve 29 unrelated research files.
No entry, cancellation, close, live write, AI call or entry-window activation.
Plan requires independent acceptance before code and a different implementation
reviewer. Real broker/account/order identifiers live only in local .env, not git.

## 1. Explicit external manual reducing order recognition

Add strict EXECUTION_EXTERNAL_ORDERS_JSON configuration (default empty), each
approval containing accountId, permId, conId, symbol, secType=STK, currency,
exchange, action=SELL, totalQuantity (positive integer), validFrom, expiresAt and
operator note. No wildcard symbols or blanket client0 exemption; approval lifetime
at most24h. Reject malformed/duplicate identities at startup. Runtime acceptance
requires full exact identity, clientId0, empty orderRef, finite filled/remaining
with filled+remaining equal approved total, remaining positive, and a matching
long broker position covering the SUM of remaining quantities of ALL current
unowned SELL orders on that account/contract, not each order separately. Any
unrecognized competing order prevents approval of the group. Require complete fresh current
account/session snapshot and unique permId/contract rows. No bot management rights
are created. Expired/revoked/malformed/changed orders remain orphaned.

Exclude every configured executable bound contract from eligibility. Refuse
collisions with persisted broker links/refs or active proposals for the same
contract; never use brokerOrderId0 as an ownership identity. Recognition is a
separate external classification preserved in the reconciliation report, including
approval identity/expiry and observed quantities. Other positions remain subject
to existing account exposure and risk policy.

Existing orphan hold can resolve only with complete current evidence, for its
exact contract and payload order identity, when ALL currently unowned orders for
that identity are individually approved. Add permId to new orphan payloads. Legacy
hold without permId must load the persisted snapshot referenced by that hold
and find exactly one record matching its full account/contract/payload identity;
that historical record must have the same valid permId as the current approval.
Missing/conflicting historical identity leaves the hold active (manual orderId0
alone is never proof). Never clear unknown_submission, position_mismatch or other holds. Resolve
with existing audited auto_snapshot_clean disposition and explicit external-order
reason; no direct SQL operational bypass. Preserve unknown orders in holds/status.
Ensure unresolved existing holds cannot yield misleading CLEAN. If approval expires
or is removed while order remains, recreate the orphan hold on next capture.

## 2. Broker-evidenced zero daily P&L when no fills exist

Keep the existing cumulative/nonempty P&L aggregation semantics. Empty local fills
alone remain incomplete. Add a bounded zero-day evidence path to daily-loss
status using current account/session reconciliation plus explicit account data:
- Execution capture starts no later than today's UTC midnight (earlier recovery
  windows stay earlier), records actual end time and account filter.
- Require successful matching execution end, healthy session/generation, current
  UTC date, fresh complete snapshot (max60s), zero broker executions, and no filled
  completed-order records. Source absence/timeouts, historical dates, malformed
  counts, foreign account/session or changed broker generation fail closed.
- Account download must have completed for the same account/current generation,
  with explicit finite USD RealizedPnL equal0, explicit USD net liquidation, and
  freshness max60s. Never infer it from BASE/fallback metrics or an absent value.
- Read local current-day fills under the same consistent DB read as reconciliation
  evidence. Any local fill for this account or missing account identity blocks the
  zero fallback; a nonempty day continues to use the existing aggregation path.
- Expose reason/provenance in kill-switch diagnostics. A broker fill after capture,
  a reconnect or incomplete position generation invalidates zero evidence. No
  setting disables the kill switch and no missing commission is treated as zero.

Account-summary intentionally bumps position generation on refresh. If the local
current day is empty and cached account zero evidence is fresh, daily-loss
consumption may trigger the existing readonly reconciliation scheduler at most
once when evidence is unavailable or its generation changed. Null/in-flight/failed
refresh stays incomplete. Reread DB proof and rebuild current time/day, account,
session, connection generation, cache and synchronous fill timestamp after await;
revalidate all strict predicates. No account-refresh loop. Tests cover successful
refresh, null/failure, fill/reconnect races and account expiry during await.

Tests must distinguish zero broker P&L backed by an empty current day from absent
records. This is a narrow bootstrap correction, not general P&L/FX redesign.

## 3. Authenticate internal readiness probe

Pass the existing EXECUTION_API_TOKEN from signal runtime wiring into
HttpReadyProbe and send Bearer to /ready. Keep /ready protected. Reject missing
credentials without network, reject non200/503 statuses (including401), redirects,
invalid JSON/body and unexpected environment. Preserve explicit disabled-write
semantics and prevent token leakage in errors/logs. Fake HTTP server integration
covers real protected endpoint shape, wrong/no token,503,malformed and redirects.

## Acceptance and delivery

- Unit/config + PG production runner tests: external manual SELL alongside PKO
  permits CLEAN, exact existing orphan hold resolves, unknown/duplicate/foreign/
  expired/colliding/individually-or-collectively-overselling/protected-contract orders remain blocked. Unknown
  holds survive. No dispatch/cancel methods invoked.
- PG daily-loss evidence tests: no rows without evidence incomplete; valid empty
  day zero; stale/wrongday/session/account/nonzero broker P&L/missing USD/partial
  coverage/missing commissions/unassigned local fill/reconnect/fill-generation race
  do not accept zero. Adapter test asserts UTC-midnight query and completion fence, actual UTC wire filter format and fill-generation fence at
  the consuming daily-loss gate (not only at capture).
- Independent hostile implementation ACCEPT, full clean lint/typecheck/unit/PG/
  build plus Docker build. No strategy tuning; backtest not otherwise required.
- Report; stage exact scope; commit+push main; verify exact GitHub CI.
- Configure only the owner-confirmed observed manual SMR SELL approval in local
  .env with bounded expiry, then deploy execution and signal (writes/scheduler off).
  Rerun reconciliation and verifier, confirm original SMR order remains untouched,
  record actual PKO history/quotes/PLN and any external blockers. Do not claim
  launch readiness from disabled scheduler ready response or counts alone.
