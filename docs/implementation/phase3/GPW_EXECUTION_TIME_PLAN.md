# GPW execution timestamps and durable reconciliation failure

## Evidence and scope

The authorized Paper observation was stopped with writes and scheduler disabled.
The current Gateway configuration explicitly names Europe/Warsaw. A read-only
execution snapshot returns bare `YYYYMMDD  HH:mm:ss` local timestamps after an
unrelated instrument's execution. No execution identifiers or quantities belong
in committed documentation. The current parser accepts UTC/GMT or explicitly
configured bare UTC only; rejected times become Invalid Date. Phase C passes that
non-null value to PostgreSQL, which rolls back and leaves the earlier RUNNING row.

Fix this bounded defect on main, preserving the 29 unrelated research files.
No strategy, AI, risk, order submission, budget or Paper activation changes.

## Changes

1. Extend explicit EXECUTION_BROKER_TIME_ZONE configuration to UTC or
Europe/Warsaw; unset remains fail-closed for bare timestamps. Parse calendar-valid
2000–2100 timestamps with one or multiple date/time separator spaces. Explicit
UTC/GMT suffix remains authoritative; unsupported suffixes/trailing garbage fail.
For configured Warsaw bare times, enumerate UTC+1/UTC+2 candidates and verify each
against Intl Europe/Warsaw calendar fields. Exactly one matching instant is
required; DST gaps and repeated ambiguous times fail closed. Never infer timezone
from host, exchange or account. No new dependency. Put parser in a focused module.
2. Validate snapshot capturedAt and timestamp-bearing execution/order evidence
before matching or any Phase C write; missing/invalid execution time cannot borrow
capture time. Preserve existing optional order timestamp semantics, but reject
invalid provided dates. Diagnostic failure uses a stable sanitized reason.
3. Catch Phase C failures and finalize only the same account's still-RUNNING row
as FAILED in a fresh short snap-locked transaction, with completedAt and incomplete
snapshot state; no snapshot, observations, holds or lifecycle writes reused.
A guarded update must not overwrite a committed terminal result after ambiguous
COMMIT. If no row is finalized or finalization fails, propagate an error, never
claim success/FAILED falsely. Existing lock-release finally remains.
4. Document the explicit timezone assertion and failure behavior. Deploy reviewed
image disabled and set local timezone to Europe/Warsaw based on inspected Gateway
configuration, not guessed clock offset. Do not modify Gateway UI or old snapshots.
Existing abandoned-run cleanup is used; no manual status repair.

## Acceptance and validation

Independent plan ACCEPT then implementation; different independent implementation
reviewer ACCEPT. Tests: summer/winter Warsaw conversion, leap/calendar bounds,
DST gap/fold rejection, no configuration, explicit UTC/GMT override, unsupported
suffixes, bare spacing and malformed values; config acceptance/rejection; actual
TWS snapshot integration. PostgreSQL runner regression: invalid execution date
leaves durable FAILED with no partial Phase C observations/hold/lifecycle changes;
injected publication error rolls back and finalizes FAILED; next valid run works
and releases locks; guarded finalizer cannot overwrite terminal/foreign rows;
finalization failure/no-op propagates. Preserve current reconciliation suites.

Full clean lint, typecheck, unit, isolated PostgreSQL integration, build and Docker.
Sanitized report; exact-scope commit/push main and exact GitHub CI. Then disabled
execution deployment and actual broker replay: parsed times are finite UTC, latest
reconciliation finishes (CLEAN only if genuine evidence supports it), /ready no
longer stuck on artificial RUNNING. Report any independent P&L/ownership blocker
rather than loosening it. Keep Paper writes/loop off and monitoring paused.

## Timestamp consistency amendment

The same TWS execDetails event also feeds persisted fill accounting via a callback.
Currently it forwards raw bare text to a legacy repository parser that assumes
UTC. Normalize this callback's executedAt through the same explicit-zone parser
and emit a canonical UTC ISO string, or undefined for an untrusted time. Do not
fabricate a timestamp or rewrite historical rows directly. Add production event
callback tests proving parity with snapshot parsing and refusal of missing-zone
or ambiguous Warsaw times. This prevents fixing snapshot time while continuing
to persist a two-hour-shifted fill time through the adjacent event path.
