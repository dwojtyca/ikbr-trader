# Accounting source release acknowledgement — bounded CI amendment

Status: ACCEPTED by independent `research_plan_final`, requested Astra/high,
2026-10-19. Implementation is authorized within this bounded contract.
This is a bounded follow-up to [the startup plan](PAPER_STARTUP_DATA_RECOVERY_PLAN.md).
It changes shutdown completion of the existing PostgreSQL accounting owner only.
No broker request, provider request, schema migration, ownership takeover, accounting
hold clearance or trading activation is authorized by this amendment.

## Evidence and defect

GitHub Actions run `39223023425`, attempts 1 and 2, failed immediate replacement
initialization after `await service.close()` with `ACCOUNTING_SOURCE_OWNER_CONFLICT`.
The failing existing service cases preserve corrections across restart and preserve
an old clock hold across restart. Local targeted execution passed 37/37, so another
blind CI rerun is not evidence of repair. CI used Node24.21.0/Linux; local tests used
Node24.4.1/macOS. Accounting ownership files were unchanged in source commit5648530.

`AccountingSourceService.close()` already awaits collector retirement, queued
persistence, durable owner retirement, and `owner.release()`. The defect is that
`release()` calls `PoolClient.release(true)` and immediately resolves. Installed
pg8.20.0 / pg-pool implementation removes the client and calls `client.end(callback)`;
only the later connection-end callback finishes pool removal. Destruction initiation
is not PostgreSQL acknowledgement that the advisory lock has been released.

## Bounded contract

1. Keep the dedicated advisory-lock session and durable fencing identity. Acquire
   still uses one `pg_try_advisory_lock`; contention fails immediately. There is no
   acquisition retry, force unlock on another backend, takeover, sleep, or change to
   the ACTIVE/UNKNOWN durable takeover prohibition.
2. `release(): Promise<void>` remains the public interface. Publish a single shared
   release promise before asynchronous work, stop verification scheduling, and
   synchronously revoke all local capabilities using a RELEASING state before any
   await. Repeated/concurrent release calls share the same completion or failure;
   no duplicated unlock or double client destruction is allowed.
3. Only a previously healthy RETIRED owner with its exact client/current fence uses
   the confirmed orderly-release path. Under one original 2000ms monotonic deadline,
   query that dedicated session to conditionally unlock the exact bigint key only
   when the durable endpoint/ownerId/generation row is RETIRED. Require exactly one
   result with `unlocked === true`. Then query `pg_locks` on the same backend for
   that exact bigint key (`classid`, `objid`, `objsubid=1`) and require absence. This
   second proof rejects unexpected stacked ownership rather than assuming a single
   unlock emptied a reentrant lock. Both queries use the remaining original query
   timeout, with a local deadline race bounding even a stalled response/queued
   verifier. The installed 2000ms statement timeout stays in place.
4. After successful acknowledgement, destroy the dedicated client exactly once.
   Do not wait for transport teardown: PostgreSQL has already confirmed that this
   session no longer holds the ownership lock. A replacement can immediately run
   its ordinary acquire after awaited normal close, even if old transport teardown
   is deliberately delayed. This grants no replacement special privilege.
5. Timeout, rejected query, lost acknowledgement, false/missing unlock, remaining
   matching lock, or changed/missing retirement row rejects the normal release with
   `ACCOUNTING_SOURCE_OWNER_RELEASE_UNKNOWN`, preserving the original Error as its
   cause where available. Revoke local authority, destroy the dedicated session,
   and do not retry unlock, read back and infer success, claim ownership, or change
   the durable row. A late response cannot turn the rejection into success.
   Durable RETIRED remains actual collector-retirement evidence; ACTIVE/UNKNOWN
   remain holds. The release error does not fabricate broker retirement evidence.
6. Preserve cleanup-only release semantics for NEW, failed acquisition and LOST
   owners: idempotently destroy any remaining dedicated session, without claiming
   orderly handoff acknowledgement or changing durable state. ACTIVE cleanup still
   invokes existing owner-loss handling before destroying its session. Existing
   killed-owner and UNKNOWN-retirement cleanup paths remain supported. Only the
   healthy RETIRED path above provides the new normal-shutdown completion proof.
7. A verification already in flight when release begins must not restore ACTIVE,
   RETIRED or fresh local proof after RELEASING/RELEASED, nor cause a second loss
   callback solely because normal release revoked authority. Release/activate and
   release/retire races cannot revive a released local owner. Acquire already in
   progress must check release fencing after asynchronous boundaries; if release
   wins, acquisition fails, destroys any late client exactly once, and never returns
   a live fence. Any durable ACTIVE claim written in an ambiguous acquisition race
   remains unretired and therefore fail-closed. This is local lifecycle fencing,
   not a new acquisition or recovery protocol.
8. Do not change service-close ordering, broker collector retirement, persisted
   accounting holds, generation rules, account/endpoint identity, or source recovery
   admission. `source-service.ts` is read-only unless review identifies a concrete
   additional requirement and the plan is amended first.

## Files and acceptance

Permitted runtime file: `apps/execution-engine/src/accounting/source-owner.ts`.
Permitted tests: its existing owner/service PostgreSQL integration files and a
focused owner test file in the same directory if deterministic fault injection is
clearer there. Plan/report files are this document, the parent startup plan link,
and the startup implementation report. No dependency or migration changes.

Tests must show:

- A normal retired owner completes acknowledged unlock; immediate ordinary
  replacement acquires while fake delayed old-client teardown remains pending.
  Observe the exact advisory lock on PostgreSQL, not a timing delay.
- Pause unlock delivery deterministically: release remains pending, old local
  capabilities fail immediately, competing acquisition still conflicts until the
  actual unlock, and concurrent release calls issue only one unlock.
- False unlock, stacked lock, thrown/lost-ACK unlock, delayed verification and a
  never-completing response reject or stay revoked as specified; total deadline
  cannot renew per query. No new owner generation or durable retirement is written
  by release. A late completion cannot restore local authority.
- Pending acquire/activate/verification cannot resurrect an owner after release.
- Existing ACTIVE/UNKNOWN retirement and killed-session tests remain meaningful.
- Existing service restart tests continue to assert retained correction and clock
  holds before and after immediate replacement; no sleeps or weakened assertions.

Use only the isolated PostgreSQL on loopback55434/database
`ikbr_startup_recovery_test`. Run focused owner/service tests, execution typecheck,
scoped lint and build. Lead reruns repository checks and obtains independent
Astra/high hostile implementation review, then scoped publication and exact-commit
CI. Record attempted/actual model, repair findings and unavailable telemetry in
[the report](PAPER_STARTUP_DATA_RECOVERY_REPORT.md). A second CI pass without the
acknowledgement change does not satisfy acceptance.
