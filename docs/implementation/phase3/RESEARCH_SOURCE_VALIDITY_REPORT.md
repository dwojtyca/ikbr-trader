# Research source validity: implementation and deployment record

Date: 2026-10-15. Implementation validation and independent review passed; operational completion
is not yet claimed. Scope follows the independently accepted
[plan](RESEARCH_SOURCE_VALIDITY_PLAN.md).

## Problem and behavior

The configured WSH and Marketaux qualification/entitlement records expired at
2026-10-14T21:48:23Z. This was a local operator-policy deadline, not observed
subscription cancellation. Both WSH calendars last published successfully around
2026-10-14T17:09:28Z; the additional deadline rejected them before their24-hour
freshness limit. The owner confirmed both paid subscriptions and requested a
permanent fix plus completion of the hourly Paper deployment.

The new explicit ongoing policy requires a recorded operator confirmation,
nonsecret reference and receipt hash, with null expiry. Legacy finite policies
keep their existing expiry behavior and canonical bytes. Original source identity,
metadata, verification timestamps and evidence remain unchanged. Neither a missing
expiry nor an unverified source grants access. Known finite termination retains
its finite deadline. A confirmation is an operator policy, not a provider guarantee.

WSH uses a separatev2 acquisition receipt for ongoing policies, binding the full
qualification and entitlement hashes. A receipt predating confirmation is rejected.
Legacyv1 receipts retain their shape and interpretation. Marketaux already binds
both complete records by hash. Operation and binding deadlines remain finite;
calendar freshness remains24 hours and news freshness30 minutes. HTTP/provider
denial, metadata/identity mismatch, incomplete coverage and unknown outcomes remain
holds. No provider request, quota/retry algorithm, strategy or broker-write path was
added or relaxed.

The SQL audit found no qualification-expiry predicate in the existing migration
chain. Migration34 source hashing handles the new canonical source policy without
schema changes. Existing migrations and immutable audit history are untouched.
The runbooks and architecture addendum describe ongoing access separately from
cached-data freshness and clarify the existing on-demand news behavior.

## Validation and independent review

- Plan: independent gpt-6-astra/high reviewer ACCEPT after one clarification cycle
  (truthful recorded confirmation time and WSH historical receipt-time checks).
- A bounded deployment amendment permits only SEC cap4→6 after verifying two prior
  charges, leaving room for at most four ordinary requests; independently accepted.
- App focused tests:84/84 passed, including ongoing ordinary acquisition, finite
  request deadlines, hourly WSH pacing, real hard-denial propagation, future
  confirmation zero-send and mixed finite-policy expiry between sends.
- llm-agent typecheck passed. Initial test-only repairs corrected nullable fixture
  narrowing and checked the provider-message field actually used by HTTP errors.
- Shared focused unit16/16 and isolated PostgreSQL28/28 passed. The final combined
  recovery/hourly PostgreSQL run passed41/41 without skips. Final production
  bind()/validateBinding() regressions3/3 passed after review requested explicit
  binding-path coverage. One old fixture used independent clock reads for a news
  window and could differ by1ms; it now derives the window from its checkedAt.
- Two default-concurrency full unit runs hit an unchanged25ms completed-order
  diagnostic fixture before it left the queue. Its isolated suite passed unchanged.
  All five required checks passed with workspace concurrency one; no timeout or
  assertion was weakened. Original failure logs are retained.
- Final independent hostile source/document review: ACCEPT; no remaining correctness
  findings. This is implementation acceptance, not operational readiness.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` and
  `pnpm build`: all exit0. Integration used isolated PostgreSQL port55432, never
  the operational database. Lint retained two existing warnings, no errors.
- Clean Docker build from git archive plus only the reviewed scope: exit0.
  Final report packaging is source-identical for runtime code. Commit/image source
  correspondence and exact-commit CI are checked during publication.

## Delivery and operational boundary

The preceding hourly implementation is commit
`083f39a58c3b0a1adecd8b1903746f8c37695cb4`, with successful exact-commit CI.
This package must receive its own reviewed commit, clean image and exact-commit CI.
Do not infer deployment or trading readiness from local tests.

The authorized rollout keeps entries paused and adopts a new immutable private
manifest with writes disabled. The candidate records the owner's ongoing paid
access confirmation, retains original provider evidence, sets WSH refresh3600000
and maxAge86400000, and preserves Marketaux on-demand behavior and2400/day local
allocation. New ordinary research is required; no old calendar/news timestamps are
rewritten or copied into the new manifest. The separate six-call qualification
workflow and automatic48-hour renewal were abandoned and were never executed.

Operational acceptance requires fresh ordinary provider data, exact image/profile
proof, current broker reconciliation and the supported Paper startup gates. Provider
or capacity failures are reported as actual blockers; no paid subscription is
assumed to guarantee a successful response. Old code cannot blindly replace the
new authoritative manifest/receipts during rollback.

## Agent routing and efficiency evidence

Shared implementation and plan author: gpt-6-astra/high. Independent plan reviewer:
a different gpt-6-astra/high agent. Final implementation reviewer: a third
independent gpt-6-astra/high agent, with no implementation ownership. Lead integrates
app callers/tests, documentation, validation and deployment. Requested and actual
routes match; no downgrade or local-model pilot was used. Token telemetry is
unavailable. Production repair count is zero; one implementation-review coverage
repair added real binding-path evidence. Resumed implementation/review/validation took approximately27 minutes
(09:33–10:00UTC); publication and operational rollout are separate. Unrelated backtest/signal work is excluded from publication.
