# PP2 bounded implementation plan

Date: 2026-09-28. Status: accepted by independent Astra plan review on 2026-09-28. Owner-selected scope: PP2-A/B/C following published
PP1, without PP3, deployment or trading. Baseline `aba2928` on main; PP1 and current
baseline exact-commit CI were rechecked by the lead. Normative semantics are in
[PP2_RUNTIME_CONTRACT.md](PP2_RUNTIME_CONTRACT.md); unresolved semantic changes return
to independent plan review rather than being decided by a helper worker.

## Outcome and boundaries

Apply the three already-validated momentum overrides through fresh strategy
factories; execute only explicit per-instrument assignments in an actual reachable
diagnostic/scheduled bundle evaluator; retain independent binding state and stable
safety counters; support explicit priority selection with tie/opposite-direction rejection; durably
bind algorithm/instance/revision/configuration identity
through the existing proposal/AI/risk/order lifecycle. Add dual-read migration,
disabled conversion drain, retained exit identity, read model attribution and
deterministic simulator parity evidence. Existing legacy defaults stay compatible.

All bundle entry admission remains denied by `PP3_EXECUTION_POLICY_UNAVAILABLE`.
No new strategies, policy relaxation, research calls,
new broker APIs, budget generalization, automated exits, live activation or UI
trading controls. A successful diagnostic signal is not an admitted proposal.

## Source findings and preservation

The inspected source uses `Strategy.id` as implementation ID throughout profiles,
portfolio, old signal engine, simulator sizing and exits. Momentum's `generateSignal`
constructs another default evaluator, so merely adding a constructor would drop
parameters. `StrategyPortfolioManager` shares objects supplied at startup and the
active resolver inspects all profile IDs. Current state is global
`strategy_runtime_state(strategy_id)`. The trading loop derives a v4 trigger with
algorithm identity; client-order hashing is v1 and excludes strategy attribution.
AI reviews bind its digest/contract/account/session, and broker legs already link
to original proposal IDs. PP1 supplies immutable config/instance snapshots, service
observations, a durable bundle latch and retained legacy management authority.

At startup, `index.ts` gates existing producers with PP1 admission. The loop begins
with entry admission and cannot currently evaluate bundle assignments. PP2 must
supply the separate reachable evaluator and scheduler branch specified by the
contract rather than unblocking the execution policy or exposing only a helper.

Pre-existing dirty files are frozen by the lead's inventory at
`/private/tmp/pp2-delivery/baseline-dirty.json`. This includes `signal-engine.ts`,
`simulator.ts`, backtest package metadata and ES research diagnostics. These files
remain byte-identical and unstaged. The committed simulator already has a
`strategyFactory` seam, allowing a new wrapper without changing either dirty core
file. The research context-observation hook is not a PP2 dependency. Validation
exports baseline plus only PP2 scope to a fresh isolated candidate. Do not publish
or repair unrelated dirty research files.

## Work sequence and exact ownership

1. Lead/PP2-B author this contract; independent RA reviews the whole package.
2. After acceptance, lead establishes the shared attribution type/hash interface
   and migration schema signatures. PP2-A can proceed independently on its narrow
   constructor/factory contract; PP2-B and PP2-C depend on accepted shared exports.
3. Integrate the shared contract, binding evaluator/state and persistence guards.
   PP2-C wires only accepted DTOs/factory/runtime interfaces. Disjoint files below
   must be observed; request a handoff before touching another writer's file.
4. Different RA reviews complete implementation and hostile tests. Fix findings
   until acceptance, then freeze candidate and run required validation.
5. Write report/status/runbook changes, reviewed scoped commit and push on main;
   verify CI for the exact SHA. No branch/PR and no operational deployment.

| Task | Requested/selected route | Owned writes | Dependencies and boundaries |
| --- | --- | --- | --- |
| PP2-A | L: `gpt-6-luna`, medium | `apps/signal-engine/src/strategies/momentum-breakout-long.strategy.ts`, `strategy-registry.ts`, their parameter/factory tests | Contract §1; no shared hashes, state, runtime, profile defaults or strategy formula changes |
| PP2-B1 lead | A: capable lead / high critical semantics | shared `index.ts`, new attribution module/tests, `client-order-hash.ts`/tests and exports; `infra/sql/migrations/000017_strategy_instance_attribution.sql`; execution `index.ts`, repository/row decoding, submission-service, AI review/risk and lifecycle identity tests; llm bound-review repository/worker identity tests; new drain/retained-policy modules; shared config store/startup migration integration | Contract §§3/5/6; owns attribution/trigger/cutoff/drain schema; preserve all existing risk/write guards |
| PP2-B2 worker | A: `gpt-6-astra`, high | `infra/sql/migrations/000018_strategy_binding_state.sql`; new `apps/signal-engine/src/runtime/strategy/configured-strategy-runtime.ts`, `configured-strategy-state.ts`, associated tests; `runtime/trading-loop/trading-loop-service.ts` and types/tests; new strategy evaluation routes/tests and bounded authenticated outcome reader; shared `trading-configuration/types.ts`, `parser.ts`, `identity.ts`, `admission.ts`, `projection.ts` and their tests (additive priority contract) | Contract §§2/4/5; consumes B1 shared type/schema and A factory; no source edits to dirty `signal-engine.ts`; coordinates exact scheduler option with C before index wiring |
| PP2-C | S: `gpt-6-sol`, medium | new configured backtest wrapper/replay tests and narrowly needed clean backtest repository/types DTOs; `apps/signal-engine/src/index.ts`, `config.ts`, bootstrap wiring/tests, `docker-compose.yml` account/env allowlist forwarding; runtime route registration if separate; new read-model mapping tests; existing UI read-only display/DTO files after lead inventory approval | Contract §7; no edits to dirty simulator/package metadata; B2 exposes evaluator, B1 owns critical proposal decoding; no safety/hash/risk semantics |
| Plan review | RA: independent `gpt-6-astra`, high | Review only | Entire plan/contract/source, no authored implementation |
| Implementation review | Different RA: `gpt-6-astra`, high | Review only | Full integrated diff, migration/hostile cases and evidence; must not be an implementer |
| Checks/publication | M: `gpt-5.6-luna`, low or disclosed available stronger fallback | Specified commands, reviewed report evidence, approved staging only | Lead diagnoses failures and approves exact scope; no force push, blanket staging or broker/provider actions |

Exact UI/read-model filenames will be listed in C's packet after the shared DTO is
fixed and the clean-file inventory is checked. This is a bounded presentation
handoff, not permission to edit all UI files. Pure signature adaptation inside an
owned file is allowed; behavioral contract changes require escalation/review.

## Acceptance matrix

| Area | Required positive and hostile evidence |
| --- | --- |
| Defaults/factory | Legacy/default configured signals, levels, confidence, rejections and exits match; every three-parameter boundary validated; explicit parameters survive helper path; legacy profile conflict rejects; unsupported registered algorithms reject |
| Selection | PKO/AAPL and generic third stock; only assigned instance runs; unassigned enabled algorithm never called and adds no candle demand; disabled instrument/instance and empty assignment skip; priority winner follows explicit rank; opposite directions block regardless of rank; malformed priority/tie injected config rejects; exception returns no partial signal |
| Isolation | Same instance on two instruments creates distinct objects/state; different revisions/parameters attributable; concurrent evaluations do not leak last rejection; restart reconstructs only from immutable authority and durable state |
| State/fences | Three-loss/second-cooldown semantics unchanged; COMPLETED+accounting COMPLETE owned outcome source; same-time processing exactly once; missing fees/currency/late correction and out-of-order outcome hold; HTTP-report-versus-DB correction interleaving cannot save stale P&L with new fingerprint; revision/config/instance/logical-instrument renames cannot clear safety key; inherited legacy hold remains; same underlying trigger conflicts across revisions; unknown/attempted fence never released; immutable cutoff excludes purged legacy triggers and delayed observations; account-wide reservation/budgets still dominate |
| Hash/identity | Golden v1 bytes/digest unchanged; v2 full roundtrip; mutate/remove each attribution field and version fails; forged assignment/snapshot/revision/contract rejected before claim/prepare/dispatch; risk evidence and broker links expose original attribution |
| Migration/drain | Fresh and populated isolated PG; old v1 remains readable; only proven unattempted rows expire; live claim/delivery/submission/unknown/links/close ownership retain; race with worker/dispatch cannot erase attempt; immutable DB identity updates reject; unknown schema/version fails |
| Retained exits | Current configuration removed/disabled/revised; original policy/levels/parameters and ownership still resolved; actual existing close fixtures pass; missing/conflicting original snapshot fails; no entry AI fabrication or broadened close quantity |
| Reachability/admission | Fastify route with real loader/factory path; scheduler bundle branch reaches same evaluator; production bundle assertEntryAllowed still fails PP3; zero proposal inserts, provider calls, broker calls from all production bundle entry/diagnostic paths; legacy runtime behavior regresses cleanly |
| Backtests/read models | Deterministic default replay equals legacy signals/fills/P&L; distinct parameter fixture results and IDs; separate binding replay state; old rows explicitly legacy; current config does not rewrite historical UI attribution |

Tests use injected data/broker/provider clients. No real IBKR, Marketaux/OpenAI or
operational Postgres is required or authorized. Strategy replay is a fixture
backtest, not an ES diagnostic or profitability assertion.

## Validation and publication

During implementation run focused Node test files through existing package test
commands and affected TypeScript checks. The exact command packet names the files
once created; no new test runner. Include isolated PostgreSQL concurrency/rollback
fixtures for binding state, trigger fences, attribution and drain, plus the existing
AI/submission/lifecycle tests. Backtest replay must run from the frozen baseline
candidate without the dirty research hooks.

Final required commands on frozen candidate: `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm test:integration` with a disposable isolated PostgreSQL URL, and
`pnpm build`. Run the new deterministic configured/default replay and relevant
existing momentum/session/simulator regressions. Account/environment forwarding changes Compose; a clean Docker build and synthetic
Compose validation with an isolated empty environment are required. Do not
use operational DBs for fixtures or change the normal Docker context. Inspect all
results; failures return to responsible A/S/L with the routing repair limits.

Check local links, stage only the accepted PP2 files, compare the baseline dirty
hash inventory, and review the staged diff. Update ROADMAP/CURRENT_STATE/delivery
plan only to evidence actually achieved. Report requested/selected model+effort,
review/repair/escalation counts, elapsed time and tokens (unavailable if not exposed).
Commit/push main only after review/local checks; report exact-commit CI URL/result.
Do not call PP2 complete while tests fail or CI is unverified.

## Stop conditions and rollback

Stop affected implementation if it needs a dirty core-file rewrite, another
algorithm's parameter schema, different fill/P&L semantics, caller-controlled
identity, relaxed admission or new broker/quantity capability. Return the smallest
reproduction and proposed contract amendment to the lead and independent reviewer.
One failed targeted noncritical repair promotes L to S; critical findings go to A.
No escalation authorizes provider spend or operational writes.

Rollback pauses entries and preserves configuration latch, immutable audit,
reservations, unknown holds and original close identity. Do not drop new schema,
rehash historical rows, delete ownership or reset counters. An older image is not
allowed to admit v2 records it cannot understand; keep disabled writes and use a
compatible management image. PP2 does not perform the operational migration/drain
or rollback; only fixture evidence and operator procedure are delivered.

## Plan repair history

Initial independent RA review: changes required (four P1 clarifications). The
amended contract implements explicit priority selection, exact configured account/
environment/allowlist plumbing, a reachable completed-outcome sync using the
existing round-trip evaluator with immutable economic evidence and one-time conservative
legacy inheritance, and a complete trigger envelope plus irreversible migration cutoff
that excludes purged legacy triggers. Independent re-review accepted all amendments before code.
