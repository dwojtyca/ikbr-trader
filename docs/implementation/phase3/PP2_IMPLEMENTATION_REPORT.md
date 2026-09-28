# PP2 implementation report

Date: 2026-09-28. Status: **PP2 delivered**. Independent hostile/document review,
all required local checks, main publication and exact-source-commit CI passed.
This source delivery is not deployment or broker-readiness evidence.

## Scope and preservation

Owner-selected PP2-A/B/C extends published PP1 on `main` at `aba2928`. The
[accepted plan](PP2_IMPLEMENTATION_PLAN.md) and
[normative contract](PP2_RUNTIME_CONTRACT.md) define parameters, configured
evaluation, immutable attribution, conversion, stable safety state and replay.
No PP3/PP4 implementation, operational deployment, trading activation,
broker/provider action, strategy addition or reset policy belongs to this package.
Bundle entries retain `PP3_EXECUTION_POLICY_UNAVAILABLE`.

The lead recorded pre-existing dirty-file hashes in a local inventory. PP2-C did
not edit the frozen simulator, legacy `SignalEngine` or backtest package manifest.
A separate candidate exported from the baseline, overlaid with package files while
excluding the baseline dirty inventory, validates replay against the committed
simulator/factory seam. The final publication must preserve and exclude all
unrelated local work and recheck the reviewed staged scope.

## PP2-A/B implementation

The momentum factory consumes all three normalized PP1 overrides at both the public
strategy and its internal evaluator. Default construction preserves existing
profiles, signals, rejection reasons, sizing and exit behavior; explicit parameters
with a conflicting nondefault legacy profile reject. No new algorithm or tuned
production configuration was introduced. Other registered algorithms keep their
legacy factory; unsupported configurable algorithms reject.

Each account/instrument/instance revision receives its own strategy object. Only
enabled assignments load history or run. Priority selection uses exact referenced
instance IDs with unique integer ranks; opposite directions and any strategy
exception discard the complete evaluation. The scheduler and manual diagnostic
route use that same evaluator, and neither enters the execution path.

Version 2 attribution binds implementation, instance ID/revision/hash, immutable
effective configuration, instrument and trusted 1-minute observation bucket.
It travels through signal metadata/ticket mapping, persisted proposal/AI review,
risk evidence, original-proposal broker links, replay and read models. Version 1
canonical bytes and digests remain unchanged. A v2 proposal cannot be relabelled
or deleted; readers never replace its historical identity with the latest config.
AI claim/finalize, prepare, reservation and final dispatch validate the identity.
The server's loaded hash is checked separately from the proposal's original hash.
Final dispatch rechecks locked approval status, account/session, identity and
finite risk/AI deadlines immediately before the synchronous send callback.

Migration 17 adds attribution and immutable trigger/conversion records; migration
18 adds the inherited safety baseline and binding outcome ledger. Conversion
requires explicit disabled writes, four fresh matching services and a proven
legacy-management or fresh-configuration source. Unresolved unknown/attempted ownership,
active close work or review leases block conversion. Only proven unattempted
proposals are expired. The irreversible next-minute cutoff excludes old or purged
legacy triggers. Database insert/reservation guards close the stale legacy writer
race; supported legacy close records remain usable.

Trigger uniqueness is account/broker/conId/direction/source/timeframe/bucket,
independent of revision, instance name and logical instrument name. Safety state
is account/broker/conId/implementation. Immutable one-time inheritance preserves
legacy loss/cooldown/disable state; new revisions never reimport/reset it. Existing
account-wide reservations and GPW/AAPL attempt budgets remain authoritative.
Nonfinite legacy timestamps reject conversion, and invalid decoded dates block
runtime readiness rather than clearing a hold.

The state synchronizer consumes only owned, completed round trips with complete
accounting from the existing read-only execution report. It checks report identity
and exact linked fill/commission/close evidence, then rechecks locked database rows
before recording an immutable outcome. Three losses trigger cooldown; a second
loss streak permanently disables the safety key. Missing fees and unavailable
outcomes block the current evaluation and are rechecked later. Out-of-order outcomes
and corrections to consumed economic/typed-identity evidence persist durable holds. Full-close evidence uses stored link roles consistently. The existing
collector's supported instrument scope is preserved; generic broker lifecycle
expansion remains PP3. The original-strategy resolver reconstructs the original
snapshot and exit parameters even after current assignment removal or disablement.

## Independent review and repairs

The plan and contract were accepted by an independent Astra/high reviewer before
implementation. Four initial plan findings addressed priority semantics, account
authority, completed-outcome economics/inheritance, and trusted trigger/cutoff
proof; follow-up clarification covered correction races and already-latched PP1
conversion. The implementation reviewer is a different Astra/high agent and wrote
no implementation.

Hostile implementation review found and drove these repairs:

- Database conversion barrier for a waiting legacy producer and later reservation.
- Identical raw linked full-close evidence in the report and ledger.
- Independent current-loaded configuration checks during resume/reserve/dispatch.
- Typed-fill conflict flags in economic evidence and immutable-source proof.
- Explicit environment forwarding without Compose's inferred Paper default.
- Finite persisted risk deadlines and final AI approval/expiry checks at dispatch.
- Rejection of nonfinite legacy dates and invalid runtime cooldown dates.

Each has targeted negative/positive evidence. Independent source/document review accepted the repaired package; final full
check/publication details follow below.

## PP2-C delivered integration

Signal startup installs `ConfiguredStrategyRuntime` and its read-only
`POST /runtime/strategy-evaluation` route in bundle mode when the runtime is enabled.
The same evaluator is injected into `TradingLoopService`. Bundle scheduling uses
the existing scheduler flag with the execution write route independently controlled
by its original flag. The configured loop branch returns diagnostic evaluation
without entering execution submission. The critical runtime/loop implementation
and hostile-spy coverage are lead/B2 work.

The production state callback calls shared `preparePP2Conversion`. Missing or
invalid `TRADING_ENABLED` text is treated as insufficient explicit disabled-write
evidence for initial conversion; the operation itself handles an existing immutable
marker. Explicit account scope is parsed from `IBKR_ACCOUNT_ID`, exact
`IBKR_ENVIRONMENT` and its matching allowlist. No port, position or first-allowlist
fallback exists. Compose forwards the account/environment/allowlists. Safe
configuration diagnostics expose only account readiness/reason, never its ID.

Diagnostic readiness uses the actual current peer admission and ignores only the
fixed PP3 entry blocker. Drift, preparation, store failure, missing peers or any
other blocker remains fatal. Entry/provider paths retain their existing entry gate.

Recent signal reads select original instrument/attribution/trigger/hash-version
fields. Shared decoders validate the attribution/trigger pair and version, with
explicit rejection if the persisted instrument or algorithm differs. Legacy rows
retain absent attribution; no latest snapshot lookup is used.

The configured replay wrapper creates one independent simulator/run per binding,
uses fresh parameterized strategy factories and matching symbol/contract candles,
and returns full attribution on raw signals, orders and fills. Its existing run
metadata records attribution, normalized instance and contract. Run/report reads
expose saved attribution, with malformed metadata rejected. Replay results are
labelled `independent_binding_replay`; they are not combined into portfolio P&L.
The helper adds no production replay HTTP endpoint or changes to backtest controls.

Existing order details, backtest run choices and report trade rows render original
algorithm, instance, revision and short instance/config hashes. Missing historical
attribution visibly remains `Legacy · attribution unavailable`. No new trading
controls or readiness inference was added. Operator documentation is in
[STRATEGY_INSTANCES.md](../../runbooks/STRATEGY_INSTANCES.md).

## Targeted PP2-C validation

Commands executed in the working checkout:

- `pnpm --filter @ikbr/signal-engine build`: passed after shared API wiring.
- `pnpm --filter @ikbr/backtest-engine typecheck`: passed.
- `pnpm --filter @ikbr/ui typecheck`: passed.
- `node --import tsx --test src/trading-configuration-bootstrap.test.ts src/strategy-attribution-read-model.test.ts` through the signal workspace: 6 passed.
- `node --import tsx --test src/configured-replay.test.ts src/configured-replay-read-model.test.ts` through the backtest workspace: 4 passed.
- `node --import tsx --test src/strategy-attribution.test.ts` through the UI workspace: 2 passed.
- Scoped ESLint for C source/tests: passed; final integrated lint also passed.
- `git diff --check`: passed at the targeted checkpoint.

The baseline candidate in `/private/tmp/pp2-c-check` excluded frozen dirty files.
Shared and signal builds passed; the four configured replay/read-model tests passed
there with the committed simulator and legacy SignalEngine. Offline dependency
installation could not find an ESLint package tarball; copying the already installed
baseline candidate dependencies supplied the same locked packages. No dependency
manifest or lockfile change was required.

Replay assertions compare nonempty raw default signals, complete orders/fills and
all simulator metrics with the legacy factory under identical candles/options.
The fixture includes per-share commission and checks full fill records and P&L,
not only trade count. A default instance emits on the boundary fixture while a
separate instance requiring daily return 40% emits none; both retain separate
instance attribution and run metadata. Contract mismatch and duplicate configured
symbol reject before run creation. Run read tests preserve original removed-instance
identity and reject malformed persisted metadata.

Bootstrap tests deny inferred environment, missing/untrimmed account and
wrong-environment allowlist; valid exact paper/live scopes parse without conferring
entry admission. Readiness tests exercise drift/store/preparation/missing-peer
rejection and preserve every blocker except PP3. Signal read tests cover legacy
absence, exact v2 pair/version and instrument/algorithm mismatch rejection. UI
presentation tests cover explicit legacy absence and original removed-instance
revision/hashes.

## Model routing and repair record

| Work | Requested / actual route | Evidence / repair record |
| --- | --- | --- |
| PP2-A parameters/factory | `gpt-6-luna` medium / same | 23 focused tests, signal typecheck; one TypeScript cast repair, no semantic escalation |
| PP2-B2 critical runtime/state and delegated integrated tests | `gpt-6-astra` high / same | Shared priority/runtime/loop/state/full-migration evidence; plan clarifications and hostile repairs above. One canonical-order test repair and three identity-fixture corrections; no guard weakening |
| PP2-B1 lead critical integration and publication | Astra/high route / capable lead; exact session model/effort telemetry unavailable | Shared hash/attribution, execution/AI, conversion and economic integration; review repairs above; two conversion-fixture corrections (process UUID and complete historical approval) |
| PP2-C wiring/replay/read models | `gpt-6-sol` medium / same | Three targeted correction batches: two API/signature/import batches and one synthetic replay fixture repair; zero model promotions. Critical account/identity/scheduler/conversion questions returned to lead |
| Independent plan review | `gpt-6-astra` high / same | Accepted plan/contract after four initial findings and follow-up clarifications; reviewer authored no implementation |
| Independent implementation/document review | Different `gpt-6-astra` high / same | Accepted frozen source and nine documents; verified final check logs |
| Mechanical infrastructure preparation | `gpt-5.6-luna` low / disclosed `gpt-6-luna` low fallback | Requested model unavailable; isolated PostgreSQL/Colima and clean baseline archive only; no source changes |
| Final checks/publication | `gpt-5.6-luna` low / capable lead fallback | Resuming mechanical workers hit the collaboration thread limit; lead ran commands and published the exact reviewed scope |

Agent token usage and individual elapsed telemetry are unavailable, not zero. No
model quality or percentage-savings claim is made. Package elapsed time is measured
from 2026-09-28 15:48:15 UTC; the source-gate elapsed time appears below. Sandbox loopback,
Docker and public-network access used scoped execution escalation; no approval
review rejection blocked the work. Test runner IPC denial was retried with the
native Node import runner; no runtime acceptance was relaxed.

The replay fixture repair introduced consolidation oscillation and a bounded
breakout to avoid RSI saturation, retaining actual strategy thresholds. Default
signals/orders/fills are nonempty. Synthetic alternate parameters demonstrate
independence; no deployment configuration was tuned to produce a transaction.

## Full validation and publication

Final frozen candidate: 69 source/config/test files and nine documents. Independent
review accepted the source/document scope, verified every source hash and all 25
unrelated dirty-file hashes, and inspected final logs. Source inventory SHA-256:
`d08cd86ac9d4098f61ede39e122576b374f60cc8e71e6fb23893db9027b7d38b`.

| Check | Final result |
| --- | --- |
| `pnpm lint` | Exit 0; zero errors, two existing unused-disable warnings in committed simulator and llm config |
| `pnpm typecheck` | Exit 0, all workspaces |
| `pnpm test` | Exit 0; 2,645 passed, 72 database-gated tests skipped without PostgreSQL, zero failures |
| `pnpm test:integration` | Exit 0 on isolated PostgreSQL 16; 2,135 passed, zero skipped/failed (execution 1,469; backtest 18; llm 13; ingestion 111; signal 524) |
| `pnpm build` | Exit 0, all workspaces |
| Relevant configured backtests | Four replay/read-model tests passed inside the final backtest suite: exact default signal/order/fill/metric parity, alternate instance, metadata and contract rejection |
| `docker build --no-cache` | Exit 0; final image digest `sha256:1844267a8cbc82c1d2801362cdeef07042009051009bf643bf41f36554c80c19` |
| Targeted hostile integration | Actual v2 insert/AI/reserve/dispatch/cutoff 8/8; state/economic/inheritance 12/12; conversion/PP1 upgrade 4/4; included in final suites |
| Local scope and documentation | Frozen source hashes and 25 dirty baseline hashes unchanged; all local links resolve; diff check passed |

Final logs are retained locally under `/private/tmp/pp2-delivery/final-*.log`.
The full source gate completed at 2026-09-28 17:14:45 UTC, about 86 minutes after
package start, including delegation, implementation, reviews, repairs and checks.
No further source edits followed the frozen candidate validation.

All checks use a clean archive of `aba2928` plus PP2 files, excluding the 25 dirty
baseline files and operational `.env`. PostgreSQL 16 is dedicated `pp2-postgres` on
the isolated `pp1-verification` Colima daemon/network. Full integration runs in the
same VM as PostgreSQL. The operational database/profile is untouched. A synthetic
Compose omission check with an empty temporary env file confirms missing account,
environment and matching allowlists remain empty; the file was removed afterward.

Source commit: [`7da3832f61459bde3880241c17161130f8225ba3`](https://github.com/dwojtyca/ikbr-trader/commit/7da3832f61459bde3880241c17161130f8225ba3),
pushed to `origin/main`. Its exact-commit [GitHub CI run 36457062279](https://github.com/dwojtyca/ikbr-trader/actions/runs/36457062279)
completed with **success** on 2026-09-28. The published 69 source hashes match the
validated candidate; all 25 pre-existing dirty files remain byte-identical and
unstaged. This documentation-only follow-up records verified delivery evidence;
it changes no runtime source.

PP3 remains planned and bundle entries remain denied. This report records no
deployment, broker action or trading activation.
