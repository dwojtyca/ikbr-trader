# PP1 bounded implementation plan

Date: 2026-09-28. Status: accepted by independent Astra plan review after two
repair rounds, before PP1-B implementation. The primary-listing/fresh-install
clarification was independently accepted during integration. Baseline `a56bc5c`
on `main`. Delivery evidence is in [the PP1 report](PP1_IMPLEMENTATION_REPORT.md).

## Outcome and scope

Deliver one startup configuration authority shared by ingestion, signal-engine,
execution-engine and llm-agent: strict strategy-instance/instrument/policy catalogue,
normalized defaults and hash, disabled rollout identity, read-only mounted file,
per-instrument monitoring/readiness, durable snapshots and compatible legacy
management. The normative field/default/unit/reference/denial rules and public
interfaces are in [PP1 configuration contract](PP1_CONFIGURATION_CONTRACT.md).

Owner authorization covers full PP1 only. No PP2 strategy factories, runtime
parameter application, proposal hash migration, budget migration, PP3 generic order
execution, new algorithm, real broker/provider call, operational deployment or
trading activation. Existing execution limitations remain explicit. Every new
bundle-mode entry is blocked pending PP2 and PP3; correct configuration is useful
for monitoring and is not presented as trading readiness.

Read AGENTS.md, [roadmap](../ROADMAP.md), [delivery PP1](PAPER_PRODUCTION_DELIVERY_PLAN.md#5-pp1--one-versioned-configuration-authority),
[routing](MODEL_ROUTING_GUIDE.md), and the [architecture](../../architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md).
Current momentum thresholds live in
`apps/signal-engine/src/strategies/momentum-breakout-long.strategy.ts`. Current
binding parser, registry and session evidence are reused, not replaced. Existing
close risk depends on the original execution-enabled binding, so entry-disabled
monitoring and retained management must use distinct authorities.

## Preserved work and allowed files

The dirty `apps/signal-engine/src/signal-engine.ts` and all existing backtest ES
research source/config/docs are unrelated owner work. Do not edit/stage/revert them.
No `.env` content reads, force pushes, branch creation or blanket staging.

Permitted implementation scope: new shared `trading-configuration` modules/tests;
shared barrel exports; ingestion config/index/bound watchlist/verification and their
tests; signal config/index/runtime route wiring and new focused entry guard tests;
execution config/index/binding/entry boundary/close context wiring and focused tests;
llm config/index/worker admission wiring and tests; one new additive migration;
versioned example JSON; Docker Compose and necessary Docker copy/mount adjustments;
package scripts only when needed for included test discovery; current-state,
architecture, plan/contract/report and configuration/runbook documentation. Lead owns shared broker-evidence types/evaluator
  and execution configuration metadata client/route; Sol owns metadata client-ID
  setting/collision plumbing. Generic metadata reads are authenticated on demand.
No unrelated subsystem rewrites. Escalate if a required change touches preserved
signal-engine.ts, alters strategy formula, released migration, proposal hashes,
authentication, broker submission semantics or supported ownership quantity.

## Work packages and independent review

| Task | Route, requested model/effort | Owned result | Dependencies |
| --- | --- | --- | --- |
| PP1-A contract | A, `gpt-6-astra` high | This plan and normative contract, concrete integration semantics | Source inspection |
| PP1-RA plan review | RA, independent `gpt-6-astra` high | Accept/reject against PP1 and hostile migration/entry cases | A documents |
| PP1-B pilot | L, `gpt-6-luna` medium | Pure parser/types/defaults and fixture tests only | Accepted A contract |
| PP1-A identity/admission | A, `gpt-6-astra` high | Canonical identity, loader authority, snapshots/drift, entry barriers and retained management | Accepted contract; types first |
| PP1-C integration | S, `gpt-6-sol` medium | Startup consumers/mount/diagnostics and integration tests | A interfaces and B parser |
| PP1-RA implementation | Different independent `gpt-6-astra` high | Integrated hostile review, no authored implementation | Full diff and checks |
| PP1-M | M, `gpt-5.6-luna` low | Supplied checks, reviewed publication and exact-commit CI | Accepted implementation scope |

Lead keeps shared exports, critical integration and publication authority. Workers
receive bounded packets with baseline, owned files, this contract, dependencies,
commands and one ordinary repair attempt; ambiguous defaults/capabilities or critical
findings return to A immediately. Do not let Luna decide rejection semantics or
relax tests. Reuse bounded workers for repairs. Reviewers neither implement nor
approve their own work. Record requested/actual model+effort, elapsed/usage if exposed,
repair/escalation count and findings; unavailable usage is recorded as unavailable.

## Implementation sequence

1. Obtain independent plan/contract review and resolve concrete findings. Freeze
   the parser contract before PP1-B starts; no coding under unresolved semantics.
2. Implement pure schema and fixture pilot; integrate reviewed shared types before
   parallel disjoint identity/persistence work. Publish targeted parser evidence.
3. Implement canonicalization and env/file loader. Exercise strict authority
   conflicts, exact hash pin, immutable revisions and fail-before-I/O boot behavior.
4. Add append-only snapshots, service observations/leases and legacy management
   persistence with an additive migration. Verify migration/restart/concurrent
   conflicts against an isolated PostgreSQL database. Preserve existing hashes and
   safety counters byte-for-byte/row-for-row in fixtures.
5. Wire four services and Compose read-only mount. Bundle monitoring derives from
   the file, with exact broker identity checks, primary listing, existing schedule
   evidence and explicit unknown/unavailable grid/quote/research states. Expose
   common identity plus per-instrument read model. Persist llm observations without
   adding a public listener.
6. A integrates actual entry barriers including old signal callback, runtime/loop,
   direct/migrated execution and llm provider/claim paths. Matching hashes still
   cannot admit bundle entries. Mixed legacy/bundle hashes block new legacy entry.
   Preserve original supported close/reconciliation via management authority.
7. Run focused end-to-end dependency-injected fixtures for PKO+AAPL and a third
   stock; verify no source symbol branch is required. Test legacy to bundle, removal,
   restart, conflicting/stale/missing consumers, corrupt snapshots and rollback.
8. Different independent Astra reviewer examines the complete diff and hostile
   evidence. Resolve findings; material changes update and re-review contract.
9. Run required repository and Docker checks once integrated changes settle; write
   the report with unresolved operational limitations and measured pilot outcome.
   Stage only reviewed scope, commit/push main, verify CI on that exact commit.

## Acceptance criteria

- All four real bootstrap paths strictly load the same immutable versioned bundle;
  configured-file failure cannot continue with default watchlists or old profiles.
- Complete fixed rules in contract §2 pass positive/hostile fixtures. Two distinct
  parameter sets are representable; existing strategy runtime behavior is unchanged.
  Unsupported algorithms/capabilities, references, duplicate identities and source
  authority conflicts fail with safe diagnostics before downstream calls.
- Canonical/default/order equivalence and material-change differences are proven;
  immutable revision reuse conflicts fail. Snapshot/migration history survives
  restart. Secrets/accounts/paths are absent from persisted bundle identities.
- PKO+AAPL and third stock reach actual shared projections and all service diagnostics
  through config only. Monitoring metadata/sessions/grid/quote evidence is honest;
  operator expectation or successful parser is never broker verification.
- Missing/stale/drifting/unknown peers and DB failures deny entries; any concurrent
  differing process remains visible. Matching consumers still deny bundle entry
  because PP2/PP3 are absent. Actual downstream spies prove no proposal/provider/
  entry broker call across every identified entry path.
- Existing hashes, attempted/unknown state and budgets are unchanged. A retained
  original binding resolves supported one-share owned close after disable/removal and restart through the actual
  close service/risk checks, with mandatory retained ingestion watchlist evidence also when present-but-disabled;
  missing/conflicting management evidence refuses conversion/close rather than
  manufacturing ownership. Management bindings cannot authorize new entries.
- Legacy remains backward compatible with explicit deprecation diagnostics. Bundle
  conversion is disabled and auditable; rollback retains state and original ownership.
- Independent plan and different implementation reviews accepted; lint/typecheck/unit/
  isolated integration/build and clean Docker build pass; report, commit/push and
  exact-commit GitHub CI pass or access limitations are explicitly left pending.

## Validation and publication

Use native Node test runner and existing workspace commands. During development,
run shared parser/hash tests and affected service tests only. Full final commands:
`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` using a disposable
PostgreSQL database, `pnpm build`, and clean `docker build --no-cache` using the
repository Dockerfile. Confirm test DB isolation before migration/fixture commands;
never point destructive fixtures at either operational database. No backtest behavior
changes are planned, so strategy backtests are not required; if implementation
changes formula/factory/simulator behavior, stop and review the PP2 scope crossing.

Validate Compose with a safe synthetic empty env file and explicit disabled settings;
do not output rendered operational secrets. Verify read-only bind mounts and identical
config mode/path/hash forwarding. Capture exact commands, exit codes and focused
failure evidence. A test infrastructure or unrelated dirty-tree failure is reported,
not repaired outside scope. The final report links tests and independent findings,
records commit SHA/CI URL/conclusion and distinguishes configuration delivery from
operational market-data or broker/provider acceptance. No readiness claim substitutes
for the still-required PP2–PP7 work.

## Planning evidence

Author requested/actual: `gpt-6-astra`, `high`; no fallback. Plan repair/escalation:
2: initial independent review requested four safety clarifications; final P2 review
required exact real-time quote provenance/freshness and monitoring retention for
present-but-disabled owned instruments. Contract review history records fixes and
accepted re-review. Independent RA also accepted the narrow implementation
clarification for absent legacy primary-listing fields and proven fresh installs. Token usage: unavailable. The lead owns generic read-only broker evidence integration; A owns shared identity/loader/projection/audit/management; C owns four-service startup wiring, ingestion primary-listing plumbing and Compose. Elapsed time is recorded by the lead
from dispatch/completion timestamps. Files changed by contract author are only this
plan and PP1_CONFIGURATION_CONTRACT.md; all inspected application code is unchanged.
