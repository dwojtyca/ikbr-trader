# CASH execution classification in securities reconciliation

## Evidence and bounded objective

After the disabled AAPL deployment, fresh broker evidence confirms live AAPL
bid/ask and sufficient USD cash for the configured test budget. A normal currency
conversion exposes a separate reconciliation defect: the broker execution is
explicitly `CASH`, but `BrokerExecutionFill` drops contract security type and
`computeExpectedNetPositionsWithIdentity` treats all fills as security shares,
returning `NULL` for security type. The broker positions snapshot contains a CASH
virtual position which does not represent the currency cash balance. Comparing
these quantities creates a false `position_mismatch`.

Correct only the distinction between securities positions and explicitly proven
CASH contracts. Keep all fills, completed orders, execution observations, cash
balances and account-wide risk evidence. No symbol/exchange allowlist or ownership
shortcut may suppress an unknown instrument. Private account, order and quantity
evidence stays outside committed files. Existing AAPL and PKO policy is unchanged.

## Scope and implementation

1. Add the next immutable SQL migration with nullable `sec_type` and a persistent
   `sec_type_conflict` flag (default false) on `broker_execution_fills`. Existing
   rows remain unknown; no SQL backfill by symbol, exchange or currency. Propagate
   normalized nonempty `contract.secType` through the existing live fill callback
   and repository upsert. Commission-only rows remain valid and unknown.
2. Preserve all existing fill fields and evidence. Missing type cannot erase a
   known type. A typed replay may enrich an untyped fill only when account,
   contract ID, symbol and currency agree with the existing nonmissing identity.
   Conflicting known types or conflicting identity associated with typed evidence
   set a durable conflict flag; they must never overwrite a known type with CASH
   and silently remove exposure. Conflicts remain fail-closed for reconciliation,
   with a stable sanitized reason, until a separately reviewed repair. No raw
   account/order values are needed in the error reason.
3. Carry type into the identity-aware expected-position read. Exclude a fill from
   the securities calculation only when its type is explicitly CASH and it has
   no identity/type conflict. All untyped fills and all other types keep their
   current comparison behavior. Do not alter other reporting/FIFO calculations
   in this delivery.
4. For legacy untyped rows, allow proof from the current complete broker execution
   snapshot: correlate exact execId plus account, conId, symbol, currency, side
   and quantity. Require nonmissing identity, valid quantity and consistent type
   across duplicate evidence. Never infer type from conId alone, symbol EUR,
   IDEALPRO, currency pairs or an unrelated execution. The current capture can
   classify the matching legacy row for this reconciliation, without rewriting
   historical financial quantities or relying on an earlier-session snapshot.
   Prefer existing callback enrichment when it has already persisted the type.
   Missing or conflicting proof leaves the row in securities comparison; an
   explicit type contradiction fails the run closed rather than accepting CASH.
5. Exclude explicitly typed CASH rows on the broker-position side of the same
   securities comparison. Preserve those rows verbatim in the stored snapshot;
   this is not a fabricated zero balance. Cash adequacy and account-wide limits
   continue to use completed broker account evidence through existing risk code.
   Retain CASH executions and orders for audit, ambiguity recovery, identity and
   source coverage; do not change historical coverage claims.
6. Resolve an existing false CASH `position_mismatch` through the normal runner
   transaction, never by deleting a hold or editing its status manually. Require
   complete current exposure/recovery coverage, exact account+conId identity,
   affirmative CASH evidence from current broker records, no contradictory typed
   records or unresolved legacy fill contributing to that identity, and complete
   proof for all local fills under the identity. The comparison may retain an
   explicit zero/zero bookkeeping identity solely to use the existing audited
   auto-resolution path, or build an equivalent guarded `HoldResolve`; record
   that the resolution used CASH classification in its note. Resolve only this
   reason and exact identity. Missing proof, foreign account, ambiguous identity,
   incomplete sources, other hold reasons or active bot submission ambiguity
   remain blocked. Do not manufacture a security position or lifecycle transition.

## Required verification

- Callback and PostgreSQL round trip: CASH/STK/unknown security types preserved;
  commission-first and missing-type replays retain evidence; typed enrichment
  requires exact identity; conflicts are durable and fail closed.
- Production client/repository/runner regression: a synthetic CASH conversion and
  zero virtual FX position no longer create a securities mismatch; raw fills,
  quantities, executions and snapshots remain intact. An unrelated stock proposal
  and all ownership maps remain unchanged. Existing false CASH hold is resolved
  once, with normal run/audit evidence and no manual state changes.
- Legacy exact-correlation success; different execId/account/conId/currency/side/
  quantity, absent type, duplicate contradictory type and stale/partial capture
  do not gain CASH exemption or clear the hold. Multiple fills under one identity
  require every contributing fill to be classified; partial proof is insufficient.
- A stock named EUR, a non-CASH IDEALPRO record, another non-CASH type, unknown
  types and actual stock quantity differences remain reconciled/blocked normally.
- CASH classification does not bypass incomplete execution/position coverage,
  unknown submissions, active-order holds, cash/FX risk evidence, AI, trading
  switches, entry windows or one-entry budget. Existing account-risk tests stay
  green; no trading policy or limits change.

## Review and delivery

Follow the repository workflow on main: independent plan ACCEPT before code,
then a different independent implementation reviewer ACCEPT. Preserve the 29
unrelated research files. Run targeted tests and all clean-copy gates: lint,
typecheck, unit tests, isolated PostgreSQL integration, build and Docker build.
Write a sanitized report, exact-scope commit/push and verify exact-commit CI.
Deploy execution only with Paper writes and loop disabled; preserve explicit
Gateway timezone. Run ordinary account refresh and reconciliation, inspect
coverage and holds, and claim CLEAN only from broker evidence. Do not replay
unknown submissions or submit an order as part of this fix. A subsequent test
uses the existing authorized AAPL flow only after every operational gate passes.
