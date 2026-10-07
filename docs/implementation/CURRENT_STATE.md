# Current project state

Owner correction 2026-10-07: [WSH context implementation](phase3/PP7_WSH_CONTEXT_IMPLEMENTATION_REPORT.md) removes event-proximity vetoes and supplies available calendar/news/forecast context to AI for existing technical proposals. Its report distinguishes source validation from operational readiness; this note does not certify a Paper entry.

Source update: 2026-10-06; PP7 reviewed source published with successful exact-commit CI. [PP0 delivery evidence](phase3/PP0_IMPLEMENTATION_REPORT.md)
supersedes the operator-security gap below. Other capability and broker observations
retain the September26 audit baseline `6cbd2c7ee9d4b9d15537441ffd9ffc714f1d306f`.
That audit tested a dirty workspace; its uncommitted ES work remains unshipped.
PP0 changes source/security controls. PP1 source adds versioned JSON configuration,
canonical hashes, snapshots/service observations and monitoring diagnostics.
Independent review, all required local checks, publication and exact-commit CI
passed; evidence is in the
[PP1 report](phase3/PP1_IMPLEMENTATION_REPORT.md). PP2 adds configured factories,
assignment-only diagnostic/scheduled evaluation, durable attribution and stable
safety counters; accepted review, required checks and successful exact-source-commit
CI are recorded in the
[PP2 report](phase3/PP2_IMPLEMENTATION_REPORT.md). These source updates establish
no operational deployment or broker readiness. PP3 adds common stock capability,
immutable Paper budgets and generic lifecycle evidence; the
[PP3 report](phase3/PP3_IMPLEMENTATION_REPORT.md) records accepted review, required
local checks, publication and successful exact-source-commit CI.
PP4 implements cached research and immutable AI evidence, but real-source acceptance
remains blocked; see the [PP4 report](phase3/PP4_IMPLEMENTATION_REPORT.md).
PP5 adds automatic ownership/protection/close observation, pinned session deadlines,
durable entry pause and alert delivery. Its [report](phase3/PP5_IMPLEMENTATION_REPORT.md)
records final validation. This work performs no deployment or broker actions.
PP4 source coverage and unavailable certified Warsaw-day accounting still prevent entry.

Owner scope update 2026-10-04: custom UI development is deferred. PP6 implements
readable Polish logs/JSON and filtered terminal reports through `pnpm paper:ops`,
reuses authenticated PP5 controls, and supplies UI-off deployment/recovery procedures.
Independent reviews, required checks, isolated restore/root-CLI drills and exact-source CI passed; evidence is in the
[PP6 report](phase3/PP6_IMPLEMENTATION_REPORT.md).
Existing UI source is retained; no operational service was stopped or deployed by this update.

PP7 addresses the October 5 configured-flow inspection. The scheduler now prepares
and submits the selected configured strategy through the existing persisted
proposal, research/AI and fresh execution-risk path. Diagnostic evaluations remain
read-only. Versioned bounded scheduled policy and migration 26 add explicit future-
day authority, immutable transitions and budgets across run/config changes.
Research calendars require explicit future occurrence coverage; execution-history
requests include Warsaw midnight without fabricating a completeness certificate.
The [PP7 report](phase3/PP7_IMPLEMENTATION_REPORT.md) records review, test, publication
and gate evidence independently. Required real research/model evidence and broker
account-day certification remain [blocked](phase3/PP7_EF_EVIDENCE.md). No deployment,
broker transaction, paid call or operational gate is established by these changes.

## Delivery objective

The owner wants a production-style bot operating on **IBKR Paper**, initially with
PKO/WSE and AAPL, with instruments configured independently from reusable named
strategy parameter sets. Instruments select previously configured strategies.
Automated evaluation, persisted AI adjudication, risk, execution, protection,
exits, recovery and operator visibility are required. A supervised one-share round
trip is an intermediate proof, not final delivery. See the [delivery plan](phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md)
and [PP1 configuration contract](phase3/PP1_CONFIGURATION_CONTRACT.md).
The [architecture page](../architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md)
links the implemented PP1 configuration and additive PP2 runtime contract.

## Evidence vocabulary

- **Implemented:** reachable production code exists; fixtures alone are insufficient.
- **Locally verified:** identified checks passed for the stated workspace.
- **Deployed observation:** dated observation of a particular image/configuration.
- **Broker accepted:** fills, ownership and final broker state establish the claimed outcome.
- **Planned:** requires implementation and review; examples are not supported configuration.

None of these labels implies profitability or permission to activate Live.

## Capability matrix

| Capability | Implemented state | Remaining gap / evidence |
| --- | --- | --- |
| Service boundaries | Ingestion owns data; signal owns strategy evaluation; llm-agent adjudicates entries; execution owns broker writes and reconciliation | Preserve these boundaries; no new orchestrator service is needed |
| Instrument registry/configuration | PP1 startup JSON projects exact bindings, separate instrument/instance/policy catalogues, hashes, snapshots and monitoring readiness across all four services | PP1 review/checks/CI passed; bundle entry requires per-proposal research, lifecycle and risk evidence; legacy opt-ins remain mutually exclusive |
| Strategy framework | Seven registered implementations; portfolio selection and regime detection exist; PP1 represents reusable momentum parameter instances and assignments | PP2 applies instance parameters, assignment-only evaluation and isolated state; review/checks/publication/CI passed; see PP2 report |
| Market data | Bound subscriptions, Redis market state, native closed history, generic session schedules/readiness | Must prove current quote entitlement, calendar coverage and warmup per configured instrument |
| Entry orchestration | PP7 configured scheduler prepares selected strategy tickets; execution persists proposal/AI review; AI approval and fresh risk required | PP3 validates WSE/WSE/PLN or SMART/NASDAQ|NYSE|AMEX/USD; one whole long stock share and LMT bracket; real research/account coverage still blocks operational entries |
| Financial risk | Deterministic entry recheck after AI, quote/account freshness, currency evidence and limits | USD base account evidence remains required; generic daily loss additionally requires full Warsaw-day broker/fee coverage, unavailable in the current production adapter |
| Reconciliation | Durable snapshots, coverage, holds, unknown-submit handling, dedicated completed-order source | Ambiguous submission/cancellation recovery remains intentionally bounded; completed source does not prove every lost acknowledgement |
| Exit/ownership | PP5 background observer restores durable ownership/close state, verifies exact protection and broker flat evidence, and can invoke the audited deadline close | One share only; disabled by default; unknown/rejected/unfilled close retains HOLD; no automatic replace/reprotection |
| AI evidence | PP4 cached research, strict listing/period/units, immutable snapshot and decision binding | Latest PKO periodic extraction, complete news/events, operational permissions and model acceptance remain blocked; see PP4 report and [PP7 source receipts](phase3/PP7_EF_EVIDENCE.md) |
| Operator control | PP0 authenticated delegation plus PP5 authenticated durable entry pause/resume and lifecycle/fault/delivery read endpoints; master switch retains its meaning | PP6 delivered readable logs/JSON, terminal reports and recovery procedures with review/checks/exact-source CI passed; custom dashboard deferred; manual IBKR changes require supported reconciliation |
| Scheduler | PP7 connects assigned instances to the persisted flow, with fair bounded concurrency and diagnostics; v2 policy has durable future-day authority | Code/evidence status in PP7 report; actual research/broker readiness, round trips and soak remain unaccepted |
| Research/backtest | Mechanical fixture E2E and frozen ES research exist | ES terminal result stays REJECTED_FOR_ES; local PR15.5F diagnostics remain deferred |
| Paper/Live | Same repository with explicit environment/account controls | Current runtime deliberately Paper-only; no Live acceptance or activation in this track |

## Source-backed implementation map

- PP1 configuration: [parser](../../packages/shared/src/trading-configuration/parser.ts),
  [loader](../../packages/shared/src/trading-configuration/loader.ts),
  [canonical identity](../../packages/shared/src/trading-configuration/identity.ts),
  [store](../../packages/shared/src/trading-configuration/store.ts),
  [admission](../../packages/shared/src/trading-configuration/admission.ts),
  [monitoring projection](../../packages/shared/src/trading-configuration/projection.ts)
  and [configuration runbook](../runbooks/TRADING_CONFIGURATION.md).
  Entry readiness requires current PP4 research evidence and PP5 supervision; PP3 generic policy does not grant activation.
  PP2 applies parameters through fresh configured factories and exposes guarded
  diagnostic evaluation; see the [runtime contract](phase3/PP2_RUNTIME_CONTRACT.md).
- Registry: [definitions](../../packages/shared/src/instruments/definitions.ts),
  [configured profiles](../../packages/shared/src/instruments/configured-registry.ts),
  [binding authority](../../packages/shared/src/instruments/bindings.ts).
- Strategy: [implementation registry](../../apps/signal-engine/src/strategies/strategy-registry.ts),
  [profiles](../../packages/shared/src/strategy-profiles.ts),
  [portfolio selection](../../apps/signal-engine/src/portfolio/strategy-portfolio-manager.ts),
  [runtime evaluation](../../apps/signal-engine/src/runtime/trading-loop/trading-loop-service.ts).
  Bundle runtime uses PP2 assignment-only parameterized instances; the legacy
  runtime retains its older implementation-policy evaluation.
- Data/session: [context loader](../../apps/signal-engine/src/runtime/strategy/strategy-context-loader.ts),
  [session adapter](../../apps/ingestion/src/session-schedule-adapter.ts),
  [session report](phase3/INSTRUMENT_SESSION_READINESS_REPORT.md).
- AI: [bound worker](../../apps/llm-agent/src/bound-review-worker.ts),
  [review store](../../apps/llm-agent/src/bound-review-repository.ts),
  [AI integration report](phase2/PR15_6_AI_PROPOSAL_GATE_REPORT.md).
  PP4 adds the research snapshot/coverage contract; unavailable real-source coverage
  remains an admission failure as detailed in its report.
- Execution: [entry risk](../../apps/execution-engine/src/ai-entry-risk.ts),
  [submission service](../../apps/execution-engine/src/reconciliation/submission-service.ts),
  [close risk](../../apps/execution-engine/src/lifecycle/close-risk.ts),
  [round-trip evidence](../../apps/execution-engine/src/lifecycle/round-trip-evidence.ts).
  PP3 checks exact stock/route/primary-listing/currency capabilities, fresh metadata
  and market-rule bands. Its [policy](../../apps/execution-engine/src/paper-run-policy.ts),
  [budget](../../apps/execution-engine/src/paper-entry-budget.ts) and
  [daily-loss evidence](../../apps/execution-engine/src/paper-daily-loss.ts) preserve
  immutable attempts and fail closed on uncertified account-day coverage.
- PP5: [observer](../../apps/execution-engine/src/lifecycle/observer.ts),
  [durable observer store](../../apps/execution-engine/src/lifecycle/observer-repository.ts),
  [entry pause](../../apps/execution-engine/src/entry-control.ts),
  [fault/delivery ledger](../../apps/execution-engine/src/lifecycle/lifecycle-alerts.ts)
  and [permission/recovery runbook](../runbooks/PAPER_LIFECYCLE_SUPERVISION.md).
- Security: [UI proxy](../../apps/ui/vite.config.ts), [Compose](../../docker-compose.yml),
  [signal controls](../../apps/signal-engine/src/index.ts),
  [ingestion controls](../../apps/ingestion/src/index.ts).

## Important current limits

1. PP1 can load PKO and AAPL together for configuration and monitoring. Every bundle
   entry requires PP4 evidence and PP5 supervision, with operational acceptance still pending; the legacy registry still
   rejects simultaneous execution opt-ins. Seed entries remain disabled without opt-in.
2. ETFs map to IBKR STK at the binding layer but `assetClass=etf` is rejected by
   production entry/close risk. Futures/index types likewise do not prove tradability.
3. PP3 generic windows, immutable attempts and completion reports support configured
   stock capabilities, including a third fixture without a source-registry addition.
   Historical AAPL/GPW adapters preserve management and consumed budgets. First
   generic adoption requires disabled writes; resets and unknown-submit retries
   are forbidden. See the [policy runbook](../runbooks/PAPER_EXECUTION_POLICY.md).
4. Full close cancels protection before submitting its bounded SELL limit. An
   unfilled/failed close may leave an unprotected position. No blind replacement;
   PP5 automatically observes and escalates, while unsupported recovery still needs
   owner intervention. `TRADING_ENABLED=false` neither
   closes positions nor cancels existing broker protection and blocks full close.
5. PP4 adds lease/deadline and immutable source/decision checks. Real-source coverage,
   provider permissions and model availability remain blocked as recorded in its
   report; PP5 does not override those admission failures.
6. The September 26 operator-security gap is fixed in the reviewed PP0 source:
   authenticated UI delegation, direct mutation gates, loopback defaults and the
   supported bound runtime action are implemented and CI-verified. Retired direct
   signal routes still return 503. Operational deployment of PP0 remains separate;
   source verification does not establish the security state of an older running image.

## Dated operational evidence

The initial [September 24 preflight](phase3/GPW_PREFLIGHT_DOCKER_REPORT.md) is
historical. Later [completed-order](phase3/GPW_COMPLETED_ORDERS_REPORT.md),
[preflight closure](phase3/GPW_PREFLIGHT_CLOSURE_REPORT.md) and
[session readiness](phase3/INSTRUMENT_SESSION_READINESS_REPORT.md) reports document
subsequent fixes and disabled deployments. Do not reopen already-fixed work from
an early report without reproducing a current failure.

On September 26 the read-only stack verifier reported stale PKO market data,
incomplete reconciliation exposure and an account-summary timeout (overall
UNREACHABLE, exit 20). It observed the scheduler disabled. Docker showed ingestion,
signal and execution running the instrument-session-reviewed image, llm-agent in
Created state, and UI stopped. Saturday explains absent fresh market ticks, not
complete broker/account readiness. No restart, paid provider call or order was
performed by that audit. The observation is not a permanent diagnosis of the broker.

No inspected versioned report proves a real normal-flow entry plus exit for both
initial instruments. The AAPL provider diagnostic was a synthetic non-deliverable
proposal with a real model REJECT; it was not a trade. The PKO profile replay remains
INSUFFICIENT_EVIDENCE with zero signals; no threshold was selected for activation.

## Local and CI evidence from the audit

On the existing working tree: lint PASS (three warnings), typecheck PASS, unit
command 2,472 passes/52 skips, build PASS. Standard CI-environment integration on
disposable PostgreSQL16: 2,037 passes, zero failures/skips. An earlier nonstandard
attempt set `TEST_RESEARCH_POSTGRES_URL` to an empty database; that frozen-source
ES test cannot run there. This was test setup error, not a demonstrated regression.

[Exact baseline CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/36064194643)
passed for `6cbd2c7`. It excludes local uncommitted changes. The local toolchain was
Node24.4.1/pnpm9.15.4; the repository declares pnpm9.5.0, so this is not an exact
local reproduction of the declared package-manager version.

The historical production dependency audit reported two moderate Fastify5.8.5 advisories and no
high/critical findings in that scan. Patched version is5.12.1:
[schema coercion advisory](https://github.com/advisories/GHSA-w2qp-rph6-63g4),
[trustProxy advisory](https://github.com/advisories/GHSA-3m5p-2c4r-xxw2).
No vulnerable route configuration was demonstrated; this is dependency evidence,
not a penetration-test result. The [PP0 report](phase3/PP0_IMPLEMENTATION_REPORT.md)
records patched versions, refreshed full/production audits and residual exposure.

## Authority and next work

Use [ROADMAP](ROADMAP.md) for order, the [detailed plan](phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md)
for acceptance and [docs index](../README.md) for document status. Historical plans
are not the current queue. The root AGENTS.md contains an older PKO-only priority;
the owner's September26 direction supersedes that ordering, while its safety,
review and delivery rules remain applicable. PP3 preserves unrelated local ES diagnostics and legacy SignalEngine changes;
only its reviewed package is staged.
