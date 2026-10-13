# Repair continuous Paper startup

Date: 2026-10-13. Baseline: `cc5ada1`. Owner requests removal of the manual
startup pause obstacle and repair of `ENTRY_START_CONFIGURATION_UNAVAILABLE`.
Continuous Paper authorization remains PKO/AAPL, one share and one open position
per instrument, existing risk and source limits, USD5/day AI. No new entry window.

## Observed defect

The private profile and CLI require `TRADING_LOOP_INSTRUMENT_IDS`, but the shared
bundle loader forbids that competing legacy authority. Signal-engine exits with
`CONFIG_AUTHORITY_CONFLICT`; its configuration observation expires, giving
`CONFIG_SERVICE_UNAVAILABLE`, masked by the startup preparation error. The three
other consumers have matching current configuration hashes. Tests used a fixture
that repeated the CLI's incorrect assumption instead of the service contract.

## Bounded change

1. In `tools/paper-verify-stack/src/paper-runtime.ts`, validate each rendered app
   environment through the existing shared `loadTradingConfiguration` contract.
   Read only the already proof-covered, fixed private strategy file, mapped from
   the validated container path; verify its actual canonical hash. Derive the
   expected entry instruments from that validated bundle (`entryEnabled`), never
   a legacy environment allowlist. Reject empty/invalid scope and every loader
   failure before any service mutation, with a secret-safe error. Do not change
   the shared loader, admission rules, research eligibility or trading guards.
2. Adjust fixtures/tests to use a valid bundle with its real canonical hash.
   Regress the exact formerly accepted conflicting variable before any Compose
   up or HTTP mutation. Also cover corrupt bundle identity, all service loader
   conflicts, disabled instrument filtering, and positive PKO/AAPL scope. Keep
   current cancellation, durable pause/revision, unknown-outcome and resume gates.
3. Improve CLI messages: preparation is an automatic startup phase, not an
   instruction to manually unpause. For configuration waiting, obtain read-only
   `/execution/configuration` diagnostic reasons and display only fixed known
   configuration reason codes. Missing service remains a wait; configuration
   drift/store failure is never bypassed. Deduplicate unchanged wait messages.
   Unknown/malformed diagnostic data stays a generic wait, never permission to
   prepare/resume. Retain strict local URL allowlisting and output bounds.
4. Update the continuous runbook and write a factual implementation report.
   No edits to unrelated dirty backtest or signal-engine work.
5. After review and checks, install the corrected private profile: clear only
   `TRADING_LOOP_INSTRUMENT_IDS`, preserve the approved strategy/research/accounting
   bytes, all risk/budget/expiry values, pin the newly built image and reissue the
   existing file/config proof. Backup previous private profile. This restores the
   already approved bundle authority; it does not expand the instrument set.

## Acceptance and validation

Independent critical plan review precedes implementation; a different independent
critical reviewer reviews the final change. Run targeted runtime tests, then the
required lint, typecheck, test, isolated-PostgreSQL integration and build checks
from a clean source snapshot with only this scope. Clean Docker build required.
Use existing isolated test PostgreSQL at port 55432; never operational fixtures.
Mechanically run each of the four built services' config-module import under the
corrected effective environment without importing service entry points or making
broker/provider calls; this must reproduce the old rejection and accept the fixed
configuration. Do not expose environment or secrets in logs.

Publish a scoped main commit and verify exact-commit CI. Then use the supported
explicit startup flow within existing owner Paper authorization: retain the
audited startup pause during preparation, confirm four fresh matching config
observations and passage of the previously blocked preparation step, and resume
only via existing gates. No direct SQL control edits, direct orders, unknown
request retries, manually renewed source qualifications or fabricated readiness.
Report actual remaining blockers if encountered; tests alone do not prove live
startup or a broker round trip. `pnpm stop` must still supersede pending starts.

## Routing

Validation amendment, 08:40Z: an existing fixture test leaks a successfully bound
port when another default port is already occupied. Both full host test attempts
hang for this reason; an isolated app-image attempt cannot run Compose tests
because that runtime image deliberately lacks the Docker CLI. Extend scope only
to `tools/paper-verify-stack/src/fixture/fixture-stack.test.ts`: await all bind
outcomes and close every successful listener before propagating a failed bind.
Keep all assertions and host-port compatibility behavior unchanged. Reproduce the
partial-occupancy case and run the full host suite to completion. No operational
service is stopped to free test ports. This test-only cleanup requires the same
independent reviewers' acceptance, followed by updated clean image build; already
passed unchanged production integration checks need not be repeated solely for
test resource cleanup. Sol owns this bounded cleanup, with lead/reviewer oversight.

Lead: critical contract and private deployment. Independent plan and final review:
different `gpt-6-astra` agents, high. Bounded CLI implementation under this contract:
`gpt-6-sol`, medium; escalate critical uncertainty to lead. Mechanical checks,
clean build, scoped reviewed publication and exact CI: `gpt-6-luna`, low (available
fallback for unavailable `gpt-5.6-luna`). Read-only initial diagnosis: `gpt-6-luna`,
medium. Record actual routes, findings, repairs, elapsed and available usage in
the report; unavailable token usage is not zero.
