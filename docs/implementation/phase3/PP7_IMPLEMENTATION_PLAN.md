# PP7 — complete the configured Paper flow and prove broker acceptance

Date: 2026-10-05; implementation update 2026-10-06. Status: **source locally verified; operational acceptance blocked**.
The accepted [delivery contract](PP7_DELIVERY_CONTRACT.md) fixes the implementation
semantics; the [report](PP7_IMPLEMENTATION_REPORT.md) tracks actual evidence.
Owner request: include the missing bundle scheduler-to-proposal connection in PP7
and provide an implementation prompt. [Delivery plan](PAPER_PRODUCTION_DELIVERY_PLAN.md)
owns Gates A–D; [ROADMAP](../ROADMAP.md) owns sequence. Existing PP0–PP6 mechanisms
must be reused. Their delivery does not prove an end-to-end configured Paper bot.

## 1. Historical planning delivery and review boundary

The original October 5 planning revision changed documentation only: this plan, the delivery plan, ROADMAP,
CURRENT_STATE, the production Paper acceptance runbook and a PP7 planning report.
It does not change application code, configuration, `.env`, deployment or broker
state. Preserve unrelated ES work. Obtain independent Astra high plan review before
editing the linked documents, then a different Astra high document review. Validate
source claims, relative links and scoped diff; commit/push only the reviewed prose
on main and verify CI for that exact commit. No unchanged runtime suites for prose.

The subsequent implementation chat must inspect current HEAD and reconcile this
plan with newer code/evidence, specifying contracts, migrations and task packets
before code changes. Material changes require independent plan review. Completing
this planning delivery is not completing PP7 or authorizing broker/provider calls.

## 2. Verified starting gaps

Read-only observations on 2026-10-05, baseline `be980da5335cd940edc2ec2e60871961444cd8b6`
(unrelated local changes excluded):

| Gap | Source evidence | Required result |
| --- | --- | --- |
| Configured cycle only records evaluation | `TradingLoopService.#runConfiguredCycle` in [trading-loop-service.ts](../../../apps/signal-engine/src/runtime/trading-loop/trading-loop-service.ts); [configured-strategy-runtime.ts](../../../apps/signal-engine/src/runtime/strategy/configured-strategy-runtime.ts) always reports `entryAllowed: false` / `PP4_RESEARCH_UNAVAILABLE` | Scheduled assigned signal can reach the existing persisted proposal and AI workflow under real admission guards |
| Per-proposal research and operational feeds are incomplete | [PP4 report](PP4_IMPLEMENTATION_REPORT.md), [provider contract](PP4_PROVIDER_CONTRACT.md) and [research example](../../../config/research/paper.example.json) | Real mandatory coverage for each issuer, verified model and bounded provider budgets; configuration placeholders never count as evidence |
| Full account-day broker accounting cannot currently be certified | [paper-daily-loss.ts](../../../apps/execution-engine/src/paper-daily-loss.ts) requires `certifiedFrom` covering Warsaw midnight; [production adapter](../../../apps/execution-engine/src/reconciliation/ib-broker-adapter.ts) and [PP3 report](PP3_IMPLEMENTATION_REPORT.md) | Broker-derived, fresh and complete account-day execution/fee evidence, or an explicit unresolved entry blocker |
| Repeated scheduled policy is refused | [paper-run-policy.ts](../../../apps/execution-engine/src/paper-run-policy.ts) rejects `bounded_scheduled` and its transition with `PP5_LIFECYCLE_REQUIRED` | Reviewed durable transition and bounded multi-session policy for Gate C; initial Gate B retains the stricter one-attempt policy |

Configuration status in [projection.ts](../../../packages/shared/src/trading-configuration/projection.ts)
is not an execution permit: it reports research as per-proposal evidence. Do not
turn a configuration-valid flag into blanket permission to submit. Recheck all
starting gaps against code before implementing; old report labels may be stale.

## 3. Outcome and exclusions

PKO/WSE/PLN (`pko_wse`) and AAPL/SMART/NASDAQ/USD (`aapl_nasdaq` in the bundle)
coexist, select independently configured instances of the existing momentum
strategy and run the full normal path:

`closed market data -> scheduled assigned strategy -> validated ticket -> persisted
proposal -> immutable research/context -> mandatory AI verdict -> fresh execution
risk -> durable attempt -> IBKR bracket -> observer/exit -> broker/accounting proof`.

No manual run-once, raw-ticket injection, fabricated signal or manual close is
needed for a normal accepted lifecycle. Valid no-signal/REJECT is observable and
does not constitute a round-trip pass. Retain quantity1, long, LMT/bracket, verified
stock capabilities, USD account valuation, one active bot intent/position per
account, no overnight and the existing Paper-only guard. A third supported stock
fixture must use configuration only; never special-case the two initial tickers.

No new strategy/formula tuning, UI/dashboard, Live activation, ETF/FUT/OPT/shorts,
fractional/partial-close expansion, automated IBKR UI or unrelated ES changes.
Do not rewrite services or replace the established proposal/review/risk/close flow.

## 4. Task contracts and order

Keep existing PP7-A/B/C IDs. Add PP7-D/E/F/G; D/E/F are implementation prerequisites
for Gate A/B and G for Gate C. Source development of G may finish before Gate B,
but its operational activation may not. A owns cross-package contracts and final
integration. Parallel writers require disjoint files and agreed shared contracts.

### PP7-D — bundle scheduler to durable proposals (A / RA)

1. Trace the configured and legacy runtime, shared pipeline, execution submitter,
   `submitTicket`, persisted review and existing identity/budget fences. Specify one
   supported handoff; do not route bundle signals through a legacy symbol endpoint.
2. Preserve the selected `StrategySignal`, exact instance/revision/config identity,
   bound contract and trusted trigger through ticket construction and persistence.
   Reuse strategy entry/SL/TP evidence; do not rerun an unassigned/default strategy
   or substitute generic pipeline prices. Keep parameter/state isolation.
3. Separate diagnostic evaluation, proposal admission and final broker permission.
   Enforce applicable configuration/peer/account/environment, loop allowlist,
   enabled assignment, session/history/quote, pause/hold, exposure and policy checks
   on the configured path. Replace placeholder blocker behavior only where actual
   production evidence supports progress; per-proposal research/AI/risk stay mandatory.
   No-signal, disabled or blocked evaluations must not call the model or broker.
4. Define durable idempotency for account/contract/strategy trigger using existing
   canonical identity and safety-counter contracts. Repeated ticks, two processes,
   restart, instance revision/config changes and ambiguous HTTP responses must not
   create an alternate proposal/model call/broker attempt for an already handled
   trigger. Preserve terminal rejection and unknown/attempted reservations. A timeout
   is not permission to submit under another ID; separate safe observation from retry.
5. Route through the authenticated execution API to persist `proposed_orders` and
   its pending AI review. Only the existing adjudicated path may request broker
   dispatch. Retain fresh risk after AI and durable reservation before broker writes.
6. Extend PP6 correlation from evaluation to proposal/research/AI/risk/attempt/fill/
   close and expose actual denial reasons. Diagnostic/read-only requests must never
   become trading triggers. Preserve retained management after config removal.

Acceptance: an isolated production-service integration path starts with a scheduled
bundle cycle, passes assigned strategy output to the real persistence/review path,
uses stub external adapters and ends with observed bracket/exit evidence. It must
not seed an approved proposal or invoke only `submitTicket` to claim scheduler E2E.
Cover PKO, AAPL and a config-only third stock; no-signal and failure cases below.

### PP7-E — real research and model readiness (A, bounded L/S helpers / RA)

1. Close the PP4 gaps: latest required PKO periodic report extraction, complete
   issuer-matched material news and upcoming events for both issuers, reporting
   deadlines, source automation/retention evidence and an available supported model.
   Inspect current sources; do not copy dated report expectations as current facts.
2. Select verifiable provider contracts before adapters. Reuse SEC/XHTML/mapped
   evidence infrastructure; add only required parsers/feed integration. A selects
   issuer/period/currency/unit/coverage semantics; L may implement pure mappings under
   that accepted contract. An arbitrary URL or declared-evidence fixture is not a
   verified operational provider. Never replace required research with optional data.
3. Preserve independent cached refresh, immutable snapshots, exact request/decision
   binding, required citations, deadlines, one charged model request per proposal,
   late-response audit and conservative unknown-call handling. Verify stale snapshots,
   source outages, amendments and prompt-injection text cannot authorize entry.
4. Keep versioned examples disabled and without real secrets. Operational manifest
   adoption, actual paid model/source probes and refresh budgets require the recorded
   owner scope. Public read-only source verification may inform implementation;
   provider expenditure is not implied. Report unavailable credentials/coverage with
   exact evidence and required action while completing independent code work.

Acceptance: real-source observations for both issuers distinguish extraction,
completeness, freshness, entitlement and model availability. Fixtures prove mechanics
only. All required groups must pass before the relevant broker entry; AAPL cannot
substitute for PKO evidence. No mock-positive or invented EMPTY coverage in production.

### PP7-F — certified account-day broker/accounting coverage (A / RA)

1. Inspect installed IB libraries, Gateway/TWS capabilities and adapter behavior.
   Establish an evidence-backed contract for the full account day from Europe/Warsaw
   midnight through the fresh observation, including account-wide executions, fills,
   commissions, positions/open/completed orders, session and connection generations.
   Requesting a `from` timestamp or receiving `reqExecutionsEnd` alone is insufficient.
2. Implement the verified broker-backed collection/persistence and freshness fences
   needed by existing daily-loss risk. Preserve external/manual exposure and costs,
   currency units, unknown/missing values and reconnect/coverage gaps. Do not infer
   no losses from an empty local DB or certify history from process uptime alone.
3. Keep identity/generation/coverage checks at context preparation and final entry;
   changes during AI or reservation invalidate evidence. Test midnight/DST, late fees,
   duplicate/corrected fills, foreign accounts, disconnect/restart and missing history.
4. If installed API cannot supply required evidence, document the exact limitation
   and propose/review a bounded supported adapter/data-source extension. Do not set
   `certifiedFrom` optimistically or weaken the risk requirement. Keep operational
   acceptance blocked until genuine evidence exists; complete unaffected work.

Acceptance: positive evidence exercises the real collector contract in isolated
tests; live read-only evidence separately proves its actual broker coverage. The
existing `paper_daily_loss_*` failures remain correct for incomplete observations.

### PP7-G — durable bounded scheduled policy (A / RA)

1. Keep supervised Gate B at one attempt/account/day. Implement the missing
   `bounded_scheduled` parser, shared configuration compatibility, durable adoption/
   transition and reservation integration only after defining a versioned contract.
   Retain existing counters, unknown attempts and legacy/imported holds.
2. Gate C caps: quantity1, max two attempts/account/day, max one/instrument/day,
   one active account-wide bot intent/position, finite per-currency notional/stop/
   daily-loss caps and no overnight. Config/run ID/strategy revision changes or
   restart cannot reset consumed allowances. Account day stays Europe/Warsaw.
3. Define finite multi-session authorization/window representation, actual broker
   calendars and early-close entry/exit cutoffs; existing one-hour supervised windows
   are not implicitly expanded. Enable transition only for a subsequent account day,
   with freshly reconciled flat state, no unresolved reservations and PP5 observer/
   alert readiness. A request to implement code is not policy activation.
4. Test cross-instrument contention, overlapping windows, both day boundaries/DST,
   stale/no-session evidence, policy revision/migration/rollback and crash after
   reservation. Preserve original exit policy for any already-owned position.

Acceptance: both instruments can consume their separate allowed slots in fixtures
without exceeding the shared limit; concurrent reservations cannot create two active
intents. Gate C activation remains after Gate B and explicit bounded authorization.

### PP7-A/B/C — operational evidence and failure harness

- **A (`gpt-6-astra`, high; RA):** integrates D/E/F/G, prepares private launch manifest,
  judges readiness and conducts only authorized Gate A–D work and incident decisions.
- **B (`gpt-5.6-luna`, low; lead checks evidence):** specified read-only queries,
  checks, evidence transcription and reviewed commit/push/exact-commit CI. No code
  repair, broker/provider writes, activation or independent go/no-go decisions.
- **C (`gpt-6-sol`, medium; RA):** isolated failure/restart harness under A's accepted
  invariants. New broker/race/ownership semantics remain A. No live fault injection.

D/F/G and E critical semantics use `gpt-6-astra` high. E pure normalizers may use
`gpt-6-luna` medium and known-contract wiring `gpt-6-sol` medium. Independent plan
and final hostile reviewers are different Astra high agents, neither implementing
the reviewed work. Task packets and repair escalation follow [routing](MODEL_ROUTING_GUIDE.md).

## 5. Integrated acceptance and validation

- Production-wired isolated tests demonstrate scheduler -> persistence -> AI ->
  fresh risk -> broker stub -> lifecycle/close, separately for both initial stocks,
  with config-only third-stock and two independently attributed parameter instances.
- Hostile tests: no-signal; disabled/unassigned instrument; stale/missing data;
  wrong contract/hash; global/instance pause; exposure; AI REJECT/malformed/timeout/
  late result; changed order/research/account; duplicate ticks/processes; rejected
  delivery; lost acknowledgement; DB/Redis/broker outage; restart and config change.
  Assert no unauthorized write, duplicate attempt, invented evidence or lost hold.
- Lifecycle tests retain TP/SL confirmation, deadline/early-close handling, protective
  fill racing close, no oversell/reversal, unfilled/unknown close HOLD, alert failures,
  retained ownership and supported recovery. Entry pause must not stop exit supervision.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` against
  isolated PostgreSQL and `pnpm build`; relevant backtests if strategy/simulator
  behavior changes, clean Docker build for deployment changes. Follow AGENTS.md;
  never use operational DBs for fixtures. Keep UI stopped in acceptance/drills.
- Update current docs/runbooks from actual commands and outcomes, review hostile
  failures independently, publish scoped commits on main and verify exact-commit CI.
  Record model/effort, review/repair counts, elapsed time and available token usage.

Gate A then verifies disabled-write deployment, versions, config, actual broker,
research/model, PP5 supervision/alerts and PP6 diagnostics. Gate B requires a real
strategy/AI-approved round trip for each stock under initial limits (separate account
days if necessary). Gate C requires five consecutive scheduled sessions per stock
under the bounded policy and unchanged launch manifest. Gate D covers isolated
failure injection plus an authorized clean Paper restart. Full criteria and incident
reset rules remain in [delivery Gates A–D](PAPER_PRODUCTION_DELIVERY_PLAN.md#gate-a-disabled-preflight)
and [acceptance runbook](../../runbooks/PRODUCTION_PAPER_ACCEPTANCE.md).

## 6. Authorization, rollout and honest completion

Implementation proceeds after accepted plan review without repeated code approval.
This planning request does not authorize deployment, enabling entries, broker
orders, real alert delivery, paid calls or ongoing monitoring. Before operational
work, carry forward any actual applicable owner authorization; otherwise present
the concrete tested release and private manifest for a final bounded decision.
Never invent the account, dates, amounts, provider allowance or permission to trade.

Deploy a reviewed release with writes disabled and entries paused, retaining private
backup, original hashes/ownership and audit. Supervised Gate B enablement requires
Gate A to pass plus explicit bounded owner authorization. Gate C scheduled-policy
enablement requires Gate B to pass plus its own applicable bounded authorization;
Gate C/D evidence is collected during or after that authorized scope. Rollback
must keep old ownership/counters interpretable and
exit observation available. Unknown actions are never retried or deleted to unblock.

Report status separately as **code delivered**, **Gate A ready/blocked**, **Gate B
per-instrument evidence**, **Gate C session counts**, and **Gate D evidence**.
Full PP7 is complete only when all required evidence passes, not when code/CI pass.
Missing real signal, closed market, unavailable sources or unverified broker history
remain explicit operational blockers, never reasons to force a trade or weaken risk.
