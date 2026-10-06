# PP7 implementation and acceptance evidence

2026-10-06. Source and documentation accepted by independent hostile review;
all required local release checks passed. Publication and exact-commit CI remain
pending until the publication receipt below is filled.
This report follows the [implementation plan](PP7_IMPLEMENTATION_PLAN.md) and
independently accepted [delivery contract](PP7_DELIVERY_CONTRACT.md).

## Separate delivery outcomes

| Outcome | Current evidence |
| --- | --- |
| Implementation | D/G flow and policy implemented, E calendar/F request-bound fixes implemented; real E/F capability gaps remain. Source/harness review accepted; all required local checks passed; publication/CI pending |
| Gate A | BLOCKED: PKO capital source conflict; mandatory news/calendar permissions and completeness; exact model access; certified Warsaw account-day executions/costs; no authorized disabled deployment/preflight |
| Gate B | PKO 0, AAPL 0 real normal-flow round trips |
| Gate C | PKO 0/5, AAPL 0/5 scheduled sessions; no activation authority |
| Gate D | 17/17 focused isolated scheduler/flow tests passed, including restart/unknown cases; 2427/2427 isolated integration regressions passed; no authorized Paper restart |

No broker connection, order, real alert, paid provider/model request or operational
deployment is authorized by this source-delivery request. Test adapters establish
mechanisms, not genuine research/account readiness or operational acceptance.

## Implemented scope

D connects assigned parameterized strategy evaluation to the existing ticket,
durable proposal, mandatory research/AI and fresh execution-risk flow. It preserves
selected confidence, prices, strategy instance/configuration attribution and stable
trigger identity. Verified stock market-rule normalization is shared with the
existing WSE rule. Authenticated ready/exposure evidence populates preliminary
broker context; no account balance or risk approval is invented. Diagnostic routes
stay read-only. Configured scheduling preserves its allowlist, in-flight and
concurrency fences and rotates starting order so later instruments are evaluated.
PP6 cycle diagnostics retain proposal attribution and precise denial codes.

E separates calendar acquisition timestamps from actual occurrence coverage,
requires the full 24-hour event-blackout horizon and expires eligibility before
coverage runs out. Old immutable research remains readable but cannot grant new
entry authority without the required coverage. Public issuer sources were inspected;
[receipts and remaining extraction/provider gaps](PP7_EF_EVIDENCE.md) are explicit.
PKO H1 Tier 1 values conflict across issuer documents. No guessed normalizer,
complete feed declaration or model-access claim is supplied.

F requests execution history from at least Warsaw midnight, retaining earlier
recovery boundaries. The installed adapters do not establish certified account-day
completeness across client visibility, retention and corrected/late costs. The daily-
loss gate therefore continues to reject missing evidence. This is a bounded
collector fix and capability finding, not completion of positive broker coverage.

G adds finite version-2 bounded scheduling with explicit dated windows, two attempts
per account/Warsaw day, one per instrument/day and one active intent. Migration 26
preserves old rows and introduces immutable authority events plus monotonic account
authority. First authority explicitly names registered prior v1 and target hashes;
future-day scheduling, adoption and cancellation use CAS/idempotency, disabled
writes, durable pause, fresh reconciliation/flat state and observer/alert readiness.
Allowance survives run/config/revision changes; unknown outcomes consume budget.
Legacy v1 retains its stricter one-attempt compatibility path until authority exists.
See the [operator procedure](../../runbooks/PRODUCTION_PAPER_ACCEPTANCE.md#pp7-release-preparation-and-scheduled-policy-controls).

## Reviews and repairs

Independent Astra/high plan review accepted the contract after one repair clarifying
bootstrap authority, contention, cancellation and expiry. A different Astra/high
implementation reviewer found two P2 production issues: local-time parsing of
PostgreSQL policy dates, and starvation of instruments beyond the concurrency cap.
Civil-date text comparison and round-robin scheduling fixed them. Targeted Warsaw/
DST SQL/application tests passed; the reviewer independently ran the civil-date
unit regression and both captured-timer concurrency regressions.

One harness repair round replaced hard-coded CLEAN reconciliation with the actual
production runner/matcher from initial flat state through every lifecycle state.
It also made scheduler waits assert no active work and added explicit persisted
attribution/trigger/revision/confidence/reason, raw/normalized price, bracket and
contract assertions. The no-signal test enables submissions, so a missing signal
actually proves the enabled path stays read-only. The completed source/document
review accepted all corrections, with no remaining blocking finding. This approval
does not substitute for release checks or real operational evidence.

## Integrated evidence

The four `apps/execution-engine/src/pp7-scheduler*` files drive the actual
`TradingLoopService.start()` captured timer. They use configured strategy factories,
native candle context/indicators and production strategy state, preparation pipeline,
authenticated ticket transport/route, ExecutionRepository, research-bound review
repository/worker, current entry-control/research/budget checks, deterministic fresh
risk, ReconciliationRunner, lifecycle observer and audited FullCloseService.

Each PKO, AAPL and configuration-only XYZ fixture reaches a pending proposal without
broker dispatch, consumes one controlled model request, passes fresh risk, submits
one bracket, observes ownership/protection, reaches a session deadline, cancels
protection through the close barriers, submits a bounded full close and observes
FLAT with a COMPLETED round-trip and COMPLETE fee accounting. Exact normalized
entry/SL/TP are 100.20/99.37/104.35 in the controlled candle fixture; actual raw
strategy levels and attribution are retained. XYZ uses a distinct custom revision 2;
PKO/AAPL use default revision 1. Production parameters are unchanged.

| Focused evidence | Result and boundary |
| --- | --- |
| Scheduler to supervised close | 3 positive instrument cases within 14/14 PG flow tests; actual internal guards and reconciliation, controlled external data/provider/broker adapters |
| Hostile flow cases | Simultaneous scheduler processes, HTTP acknowledgement loss, broker UNKNOWN and restart, AI REJECT/malformed output, research supersession, durable pause and missing source/configuration evidence preserve holds and avoid duplicate dispatch/model charge |
| Scheduler diagnostics/fairness | 3/3 tests: enabled no-signal, disabled/allowlist behavior and recurring cap1/cap2 evaluations without starvation |
| Selected-signal boundaries | Real shared decision safety rules/RiskEngine, low confidence, malformed identity/prices, unsupported protection, broker context and normalization regressions |
| Durable policy/budgets | 19 shared and 91 execution focused passes plus 13 Warsaw/DST passes; migration, CAS/replay, readiness rollback, concurrent reservations, two sequential distinct slots, per-instrument cap, expiry and unknown/legacy debt |
| Research and accounting | 30 focused calendar/provider/eligibility, 7 research audit PG and 44 broker/daily-loss/lifecycle passes; actual production adapter never manufactures `certifiedFrom` |
| Migration preservation | 4 upgrade tests pass, with expected additive version 26 and old proposal/AI/order/close/window evidence unchanged |

The fixture's external calendar, provider decisions, quotes, account financials,
execution history and coverage certificate are synthetic. They test the normal
mechanism without asserting that the current broker source can provide that
certificate. Reconciliation CLEAN/HOLD, ownership, budget, AI admission, close
risk and terminal proof are computed by production components. A model stub initially
completed before the Docker database reservation time because that clock was about
49ms ahead; bounded controlled provider latency fixed the fixture without relaxing
the production timestamp fence. After real reconciliation replaced the seeded
verdict, the UNKNOWN test correctly encountered a hold and now asserts rejection
instead of expecting the worker to continue.

## Validation and publication

The publication candidate is archived baseline `021960e83610d5fab2d3e20a2b7f832a7fef5b9c`
plus 69 explicit PP7 paths, excluding pre-existing local backtest/ES diagnostics and
`apps/signal-engine/src/signal-engine.ts`. Initial baseline
[CI37320187469](https://github.com/dwojtyca/ikbr-trader/actions/runs/37320187469)
was independently read as SUCCESS. The final path/SHA256 manifest fingerprint is
`8960df2ad8e51c49878632973d60987e3833a5123d176b19498c3de9dc1a8fff`.
No non-documentation source, test or configuration changed after that snapshot.
All 25 unrelated local file hashes match the original snapshot.

| Check | Final result |
| --- | --- |
| `pnpm lint` | PASS, exit 0; two baseline unused `no-console` disable warnings |
| `pnpm typecheck` | PASS, exit 0; root pretypecheck rebuilt shared/signal outputs |
| `pnpm test` | PASS, exit 0: 3055 total, 2922 pass, 133 PostgreSQL-dependent skips, 0 failures |
| `pnpm build` | PASS, exit 0 |
| Clean Docker `build --no-cache` | PASS, exit 0; image below |
| Docker `pnpm test:integration`, disposable PostgreSQL16 | PASS, exit 0: 2427/2427, 0 skips/failures |
| Independent source/document hostile review | ACCEPTED; all reported production and harness findings closed |
| Local relative links, scoped diff and preservation | PASS; all 25 unrelated files retained |
| Scoped publication/main and exact-commit CI | Pending publication receipt |

Unit package passes: shared546, llm-agent91, ingestion107, paper-verify-stack173,
execution1349, UI14, signal533, backtest109. Integration passes: execution1734,
backtest18, llm-agent17, ingestion111, signal547. Native-runner integration package
durations sum to approximately 208s; total shell wall time was not independently
captured. Source validation uses local Node24.4.1/pnpm9.15.4. Final Docker uses
Node24.20.0 and the repository-declared pnpm9.5.0.

The clean image `ikbr-pp7-verification:release` has inspected image ID
`sha256:93cabb270f472843b5cfc0af032b33e2645b3b608d848853b5a7cd7a3967cb07`.
Its application/configuration/test sources match the frozen publication scope;
subsequent documentation records these results. Build context contained no private
`.env`. Integration used only Docker context `colima-pp1-verification`, dedicated
network `pp7-verification-net` and disposable `pp7-postgres`. Its standard
`pnpm test:integration` ran with `--cpuset-cpus 0`, retaining the documented local
freshness-test resource constraint from PP6. Explicit concurrent reservation tests
remain active; no assertion or freshness threshold was weakened. GitHub's standard
workflow remains a separate exact-commit requirement without that local CPU flag.

Initial loopback sandbox EPERM was resolved using approved isolated-test access.
One earlier unit rerun encountered stale compiled shared output after a candidate
source refresh; the normal root pretypecheck build fixed the ordering. Final full
checks above passed on the rebuilt snapshot. The migration-upgrade regression now
expects additive version 26 and keeps all existing preservation assertions.

Evidence files are retained in the private, git-ignored
`backups/pp7-release-2026-10-06/` directory, including command logs, the source scope
and disabled launch manifest. These are local receipts, not operational evidence.

No strategy formulas, production parameters or simulator behavior are changed.
Existing momentum/backtest regression fixtures passed within the required suites;
no separate strategy backtest is applicable. No threshold tuning
or market replay selected to force a transaction is part of this delivery.

## Routing and execution record

| Work | Requested route | Actual route / evidence |
| --- | --- | --- |
| Lead integration/D/contracts | Astra high | Lead; backend model/effort/token telemetry unavailable |
| Independent plan review | Astra high | Separate plan reviewer; accepted after 1 contract repair |
| E/F evidence and implementation | Astra high | Separate worker; focused suites passed, no initial repair |
| G policy/migration | Astra high | Separate worker; hostile date repair 1 |
| C harness | Sol medium | Original worker interrupted by availability; disclosed Astra high fallback; 1 hostile harness repair round; fixture setup/clock/schema fixes, no production guard relaxation |
| Independent hostile review | Astra high | Different reviewer; accepted after 2 production findings and 1 harness repair round |
| Mechanical verification | GPT-5.6 Luna low | Unavailable in the tool model list; disclosed fallback GPT-6 Luna low |

Work started October 5 at 13:34 UTC (initial file fingerprint) and resumed October 6
after the owner's usage-limit reset. The final local verification completed roughly
23 hours later, including the interruption.
Wall elapsed time includes interruption and is not active model compute time.
Per-agent token usage and backend actual-model telemetry are unavailable, not zero.
No token-savings percentage or model quality guarantee is claimed.

## Release manifest and unresolved operational inputs

The [launch template](PP7_LAUNCH_MANIFEST.template.json) is documentary, disabled and
not executable as a policy. The private manifest binds the disabled config hash
`60cd6b0368d6d176a3d85f750b11bace5b2f7880576e85441099ba80fd229f10`
and inspected image ID; source commit/CI are filled after publication.
Account identity, dates, monetary caps, provider/model limits, source permissions,
broker coverage evidence and owner authorization must be supplied and verified
before any operational stage. None is inferred from code approval or green tests.
