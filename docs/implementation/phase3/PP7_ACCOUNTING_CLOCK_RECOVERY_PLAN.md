# PP7 accounting clock recovery

Date: 2026-10-07. Status: source implementation and independent Astra/high review accepted;
full local release checks passed; publication/CI and operational recovery pending.
Package: separate from retained strategy-state recovery; do not combine publication
or operational acceptance. Owner scope is supervised Paper readiness and one AAPL
share through the existing proposal, risk, research, AI and broker gates.

## Observed failure

The deployed accounting source first persisted ACCOUNTING_CLOCK_INVALID at
18:12:07.008 UTC, observation sequence 1120. Its last successful inspection was
18:12:02.034 UTC. Later broker clock observations were valid, including a 738 ms
receipt difference at 18:29:31.738 UTC, while the durable hold remained.

At the pre-change baseline, the collector rejected an invalid clock or absolute
receipt-time difference above two seconds before persisting the offending value. That value and exact skew are
unavailable; do not claim the original cause was proven drift or latency.
AccountingSourceStore.begin preserves the hold; gap with no new code preserves it;
invalidate revokes qualification without clearing it. Inspection checks the hold,
and qualification calls inspection first. At the pre-change baseline there was no supported recovery.
The existing source contract section 8 describes clock correction/requalification,
which could not finish through the pre-change routes.

A further boundary matters: the pre-change gap method could overwrite a previous
non-clock durable hold with CLOCK_INVALID. Recovery must not treat the latest hold
string alone as proof that no unresolved contradiction exists.

## Selected approach and bounded scope

Provide an explicit authenticated source operation `recover-clock`, implemented
inside the existing accounting service/store and using the existing dedicated
accounting socket. It is not a general hold-clear endpoint. Ordinary inspect,
qualify, invalidate, startup and reconciliation must not silently clear this hold.
No broker orders, provider calls, competing client-0 connections, database resets,
budget refunds or synthetic fee/P&L evidence are involved.

Expected files: accounting/source-collector.ts, source-service.ts, source-store.ts,
relevant accounting types/tests, accounting/routes.ts and source-cli.ts, their tests,
and the minimal index.ts dependency wiring needed for server-owned write guards.
Include only the exact POST recover-clock write-guard exemption and its tests;
Bearer authentication, account guards and the stricter disabled-Paper checks remain.
Update PAPER_ACCOUNTING_SOURCE.md and the relevant source-contract recovery section.
No schema migration is expected: immutable observations already permit named kinds.
If recovery requires new persisted authority or broader history repair, stop and
return for plan review rather than widening this package.

## Authorization and admission

The new authenticated POST /execution/accounting/source/recover-clock and CLI
`accounting:source recover-clock --out /absolute/private/inspection.json` require:

- Configured accounting source for explicit Paper environment and the currently
  selected allowlisted account, using existing source/account authentication.
- TRADING_ENABLED=false, checked from server configuration, and effective entries
  paused, checked through the existing pause path. Request JSON cannot assert these.
- No in-flight source inspect/qualify/join/recovery, pending persistence failure or
  known persistence corruption. Keep the existing service serialization boundary.
- Current durable hold exactly ACCOUNTING_CLOCK_INVALID. Null or another hold
  rejects with a named recovery-specific reason; this is not an arbitrary override.

The command never enables trading or changes pause, settings, qualification expiry,
Paper debts/budgets, executions, fees or broker ownership. The private output uses
existing nonsymlink regular-file, parent0700/file0600 and exclusive-write conventions.
Status and errors must not leak raw provider payloads, account IDs or secrets.

## Fresh recovery evidence

1. Retire the old accounting socket and instantiate a new socket using the same
   configured endpoint/client identity. Bind every callback to its immutable socket
   generation and discard callbacks from retired sockets. A reconnect counter on a
   reused socket is insufficient: `currentTime` has no request ID. Arm clock acceptance
   only immediately before `reqCurrentTime`, after the new handshake and account
   identity are ready; unsolicited pre-request callbacks cannot certify recovery.
   Persist normal generation/gap events; do not reuse an old clock or inspection.
2. Require a current handshake/protocol, matching managed-account identity, unchanged
   execution-source session/generation and current settings hash. All existing
   identity validation remains; no filtering of foreign or contradictory data.
3. Request broker time before execution replay. Retain the existing maximum absolute
   two-second clock difference, strict sub-ten-second freshness and same Warsaw-day
   constraints. Do not widen thresholds or reinterpret receipt time as broker time.
4. Complete the existing unfiltered execution replay with the exact end marker and
   normal matching finite fee/realized-P&L requirements. Missing fees, unknown prices,
   orphan commissions, later-than-anchor executions, malformed timestamps or replay
   timeout remain refusals. No clock-only ping may clear the durable hold.
5. Persist and drain the complete inspection evidence. A narrowly scoped internal
   inspection mode may tolerate only the expected CLOCK_INVALID hold while acquiring
   recovery evidence. It cannot suppress any other assertion and cannot publish a
   positive accounting capture or bypass qualification.

A new invalid clock during recovery must abort the attempt, retain its evidence and
leave the hold effective. Do not wait for a second callback and accept a later good
clock in the same failed attempt. Abandon the failed connection before another
explicit recovery. A successful normal clock callback alone never resolves a hold.

## Durable transaction and hold precedence

Recovery is based on immutable observed evidence, not an operator assertion that the
clock is now healthy. The service passes the exact inspection, source/process and
both connection identities, settings identity, drained lane/barrier state, gap epoch
and semantic revision into the store transaction.

Under the existing source-row lock, re-read the control state and stored inspection.
Require the expected hold, current process/generation/account/settings, exact revision,
complete persisted clock/replay/inspection references and current freshness using
both process and database time. Recheck in-memory identity, pending lanes, gap epoch
and semantic state after awaited lock acquisition and immediately before transaction
completion. A new callback, correction, invalid clock, connection loss, revocation,
settings change or competing source process must prevent the attempted clear.

The transaction appends an immutable `clock_recovery` observation referencing the
failed-clock hold evidence and successful inspection, then clears only the expected
CLOCK_INVALID value and increments semantic revision. It retains gap=true, no latest
capture and the existing qualification identity/expiry. Null qualification remains
null. Entries still require normal qualification and a subsequent complete joined
reconciliation capture; old capture references remain invalid. Rollback leaves both
hold and absence of a recovery receipt unchanged.

Preserve stronger failures. Make durable hold updates non-downgrading: a later clock
or generic gap must not overwrite a non-clock contradiction/identity/persistence
hold. Corrections observed during recovery remain durable and cannot be lost through
a stale compare-and-update. Before clearing a pre-existing hold created by the old
implementation, inspect retained source observations for unresolved non-clock durable hold
or invalid-broker-event evidence, changed execution/commission payloads for the same
identity, or execution correction-family conflicts. These are the same conditions
that create existing durable holds, not new economic reconstruction. Any such history
refuses clock recovery. Ordinary ACCOUNTING_SOURCE_GAP observations are not
contradiction evidence; the new identity-checked complete replay must resolve that
connection discontinuity. No resolution capability for non-clock durable failures is introduced.
If historical evidence is insufficient to prove this narrow condition, refuse.

Do not infer successful recovery from restart or replay duplicates. Restart reloads
the hold and original observations; a fresh explicit operation may recover a pure
clock failure. Repeating a completed recovery sees no clock hold and refuses/no-ops
with a named non-clear result, without altering the prior receipt or qualification.

## Rejected-clock diagnostics

Persist a bounded `clock_rejected` observation before/with the gap, containing source
connection generation, active replay ID, local receive/request timestamps, value
kind and a safely bounded representation of the reported seconds, and computed skew
only when numeric/finite. Do not serialize NaN/Infinity as valid numeric evidence or
include arbitrary large objects. Valid time requires the API's finite integral epoch
seconds and representable UTC timestamp. Malformed values retain CLOCK_INVALID.
Existing clock failures without this new observation remain recoverable only through
fresh independent recovery evidence and the historical contradiction checks above;
do not fabricate their missing original clock values.

## Acceptance and hostile tests

| Case | Required result |
| --- | --- |
| Existing persisted CLOCK_INVALID, unqualified source, new good clock plus full empty replay | Immutable recovery receipt, hold cleared, gap remains, qualification still absent; no capture/entry admission |
| Same with real current-day executions and matching finite fees | Exact executions/costs retained; recovery requires complete replay, never substitutes zero |
| Existing valid qualification | Its ID/expiry preserved; recovery does not refresh qualification or reuse old capture |
| Clock skew/malformed/NaN/Infinity/fractional/out-of-range value | Rejected-clock evidence safely persisted; failed attempt cannot accept a later good callback |
| Old inspection, retired-socket clock/disconnect, unsolicited pre-request clock, stale/future clock, wrong day/end marker, timeout | Refusal and no recovery receipt |
| Missing fees/orphan fee/unknown price/foreign account or timestamp error | Refusal; normal failure remains effective |
| Current non-clock hold or historical identity/correction/invalid-event evidence hidden by old clock overwrite | Refusal; no hold erasure or audit rewriting |
| CLOCK_INVALID arrives after a stronger durable hold | Stronger hold remains; both observations preserved |
| New invalid clock/correction/gap or settings/process/generation change while waiting for source lock | Atomic refusal; no stale clear, no successful receipt |
| Persistence failure or injected failure between receipt and hold update/commit | Rollback; hold retained and no successful recovery audit |
| Restart with pure old clock hold | Hold persists until a fresh explicit successful operation; old evidence cannot clear it |
| Repeat after success | No second clear, qualification renewal or capture resurrection |
| Enabled writes, live environment, unpaused entries, unauthenticated/foreign account, service busy | Refusal before recovery acquisition; no side effects beyond ordinary auth diagnostics |
| Private CLI file/symlink/permissions/output collision | Existing file preserved; no secret/account leakage |

Use fake socket collector tests and disposable PostgreSQL integration tests, including
real source/store wiring and lock interleavings. Preserve the existing qualification,
reconciliation, correction, admission and daily-loss suites. Tests must not connect
to the operational broker or mutate the operational database.

## Workflow and operational use

Independent Astra/high plan acceptance precedes source edits. Implement at Astra/high;
a different Astra/high reviewer, with no implementation authorship, performs hostile
review. Required validation: pnpm lint, pnpm typecheck, pnpm test, isolated PostgreSQL
pnpm test:integration, pnpm build and clean Docker build. No strategy/backtest behavior
changes. Keep this package distinct from the already reviewed retained-state release.
Record requested/actual model/effort, repair rounds, elapsed time and available usage.
Commit/push main and verify exact-commit CI before deployment or recovery use.

Then back up the current database, deploy the reviewed package with writes/producer/AI
disabled, check ordinary source identity and recover through the supported command.
Verify immutable recovery evidence, preserved history/qualification and the remaining
qualification/capture holds. Obtain fresh actual operator evidence if qualification
is absent or settings changed. The owner ledger-prefix setting and market/research/
strategy readiness remain separate gates. Clock recovery never proves or forces a
Paper entry. No-signal or AI rejection remains an acceptable operational outcome.
