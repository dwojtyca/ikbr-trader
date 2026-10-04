# Production-style Paper bot delivery plan

Date: 2026-09-26; PP5 source status updated 2026-10-04. Status: **delivery specification**;
PP0 is implemented and published with successful CI, recorded in the [PP0 report](PP0_IMPLEMENTATION_REPORT.md).
PP1 source implements the bounded [configuration contract](PP1_CONFIGURATION_CONTRACT.md),
with independent review, local checks and exact-commit CI passed; evidence is in the [PP1 report](PP1_IMPLEMENTATION_REPORT.md).
PP2 source implements the [bounded runtime contract](PP2_RUNTIME_CONTRACT.md);
its [report](PP2_IMPLEMENTATION_REPORT.md) records accepted review, required local
checks, publication and successful exact-source-commit CI.
PP3 is delivered with accepted review, required checks and successful exact-source
CI; see the [PP3 report](PP3_IMPLEMENTATION_REPORT.md). PP4 implementation is independently reviewed, with real-source acceptance blocked;
see the [PP4 report](PP4_IMPLEMENTATION_REPORT.md). PP5-A/B is delivered with independent review, required checks and exact-source CI passed; see the [PP5 report](PP5_IMPLEMENTATION_REPORT.md). PP6–PP7 remain planned. [Current state](../CURRENT_STATE.md) is the baseline;
[ROADMAP](../ROADMAP.md) owns sequencing. Each PP package below requires its own
bounded implementation plan and independent acceptance before code changes.
Model assignments added 2026-09-28; they do not change the product acceptance gates.
Owner scope revision 2026-10-04: PP6 delivers readable headless diagnostics and
operations; custom web UI is deferred. PP0–PP5 implementation evidence is retained.

## 1. Product outcome and boundaries

The operator defines reusable strategy instances (implementation + parameters),
then defines instruments and assigns those instances. Initial instruments are
PKO/WSE/PLN and AAPL/SMART/NASDAQ/USD; initially one existing long momentum instance.
A supported new instrument or parameter set is added through configuration only.
Production code must not branch on these two tickers to select business behavior.

The bot runs scheduled evaluation, mandatory persisted AI entry review with
issuer research, deterministic fresh risk, execution, broker-side protection,
automated exit observation, bounded recovery and operational alerts. It survives
restart/reconnect without duplicating entry or losing ownership. Production-style
means these lifecycle properties, not a claim of strategy profitability, unrestricted
instruments or Live approval. Paper remains the only authorized deployment target.

The owner uses IBKR desktop for account inspection and discretionary manual trades.
The bot must explain its decisions and health through readable logs, reports and
alerts. A custom web UI is outside this delivery track; existing UI source/security
fixes remain intact. PP6 and PP7 must work with the UI service stopped. This changes
the presentation channel, not the required risk, audit, visibility or recovery.

Keep current service boundaries and schema compatibility. Initial supported scope
remains whole-share long stocks, LMT entry, bracket protection, USD and WSE/PLN,
USD account valuation, no overnight holdings, and one active bot intent/position
per account. PKO and AAPL can both be configured without concurrent positions.
A generic capability validator must make the boundary explicit at startup.

ETF configuration/research contracts are extensible, but ETFs and other currencies,
futures, options, shorts, leverage, fractional quantities, general partial closes,
trailing and advanced order replacement require separately accepted capability
extensions. Do not unblock them by bypassing a guard or marking them as stocks.

## 2. Non-negotiable invariants

- IBKR is authoritative for account, orders, positions and executions.
- Every entry has an immutable persisted proposal, assigned strategy-instance
  attribution, configuration identity, AI verdict and deterministic execution risk.
- Dispatch identity is reserved durably before the first broker write. Timeout,
  disconnect, crash and missing cancellation acknowledgements never mean cancelled.
- No automatic retry of unknown submissions; retain durable hold and escalation.
- Configuration/research changes cannot reauthorize an already-attempted trigger.
- Removing an instrument or disabling its strategy stops new entries, not ownership
  tracking or supported protection/close management of its existing position.
- Risk-reducing close uses ownership and close-risk policy; no fabricated entry
  signal or new entry AI review. It must never oversell or reverse a position.
- Paper/Live business lifecycle stays shared. Deployment environment and safety
  limits differ through explicit configuration; the current Paper-only gate stays.

## 3. Work package dependencies

`PP0 -> operational use`; `PP1 -> PP2 -> PP3 -> PP5`.
`PP1 -> PP4`, with PP4 integrated before broker entries.
`PP0 + PP2 + PP3 + PP4 + PP5 -> PP6 -> PP7`.

PP numbers identify new delivery packages, not historical PR numbers or GitHub PRs.
Work directly on main under the existing repository workflow. ES diagnostics are
not prerequisites and must remain preserved outside these commits.

### 3.1 Model assignments

The assignments below split implementation within each package. Quality and working
mechanisms take priority over token use. [Routing guide](MODEL_ROUTING_GUIDE.md)
defines task packets, eligibility, review independence, escalation and the first
pilot. These are development-agent settings; the bot's decision model is unchanged.

| Route | Exact model | Reasoning | Role |
| --- | --- | --- | --- |
| M | `gpt-5.6-luna` | `low` | Specified checks and reviewed publication/CI |
| L | `gpt-6-luna` | `medium` | Bounded implementation under accepted semantics |
| S | `gpt-6-sol` | `medium` | Noncritical integration and ordinary debugging |
| A | `gpt-6-astra` | `high` | Critical design, implementation and integration |
| RS | `gpt-6-sol` | `high` | Independent noncritical review |
| RA | `gpt-6-astra` | `high` | Independent critical/mixed review |

The review column is a minimum for an independently delivered task. One RA review
of the integrated PP package covers its L/S/A tasks together; do not add redundant
reviews for each helper. All complete PP packages include critical work, so their
bounded plans and final integrated changes require RA, with different agents for
plan and implementation review. Neither reviewer may author the change it accepts.
RS is allowed for a separately bounded noncritical delivery with accepted contracts.

| Task / coverage in the package below | Implement | Review | Prerequisite or boundary |
| --- | --- | --- | --- |
| PP0-A: route/threat inventory; loopback exposure; operator auth, CSRF/origin, proxy trust/secrets; security acceptance and rollback | A | RA | Owns steps 1–2 and security semantics of 3–4; never delegate credential or permission decisions as UI work |
| PP0-B: UI action/response rendering, old-route UI removal and component tests (step 3) | L | RS | PP0-A defines authenticated endpoint/response; backend forwarding and auth enforcement stay A |
| PP0-C: dependency update and compatibility integration (step 4), Docker build fixes | S | RA | A assesses exposure and approves target/compatibility boundary; changed auth/network semantics return to A |
| PP1-A: configuration contract/defaults/units, references, capabilities, broker identity/session/grid, canonical hashes/drift admission, migration and rollback (steps 1–5 semantics) | A | RA | Shared authority and fail-closed behavior agreed before helpers; no code-generation shortcut decides semantics |
| PP1-B: pure schema/parser implementation, error diagnostics and fixture tests (steps 1/5 details) | L | RS | PP1-A accepted field/range/reference/rejection contract; excludes hashes, migration, broker calls and activation; first pilot |
| PP1-C: startup loader consumers, read-only mount plumbing and readiness projection (steps 2/5 wiring) | S | RA | PP1-A/B artifacts exist; enforcement of drift/unknown versions stays A; A integrates rollout and existing-position compatibility |
| PP2-A: existing momentum parameter schema/factory, defaults fixtures and pure parameter tests (step 1) | L | RS | A-approved parameter units/ranges/defaults and isolation interface; no strategy formula/threshold redesign |
| PP2-B: binding isolation, selection/conflicts, cooldown/revision fences, durable identity and proposal migration (steps 2–5) | A | RA | PP1 identity contract; owns race/exception/restart tests and preserving old-position exit policy |
| PP2-C: attribution read models, simulator construction/parity harness and service wiring (steps 1/5 integration) | S | RA | PP2-A/B interfaces fixed; simulator behavior/risk or hashing changes return to A; relevant backtests required |
| PP3-A: generic contract/venue/currency risk, window/attempt reservation, budget migration, dispatch and close evidence, bounded policy transition (steps 1–5) | A | RA | PP1/PP2; owns accounting/day/DST/races, invariants and all broker-facing integration |
| PP3-B: generic round-trip report formatting and fixture presentation (step 3 details) | L | RS | PP3-A defines completion/evidence contract; formatter cannot declare flat/completed, consume/reset budget or clear holds |
| PP4-A: issuer/listing/time/period/unit contract; provider coverage selection; required research policy; snapshot/decision binding; lease/deadline/retry/cost semantics; ETF rejection (steps 1–6) | A | RA | PP1 identity plus PP2/PP3 integration before entries; paid diagnostics require separately scoped authorization |
| PP4-B: provider response parsers/normalizers, news/report mapping and fixtures (steps 1/3 details) | L | RS | Verified A-selected source contract, collision/time/unit rules and fixtures; no invented facts or eligibility decisions |
| PP4-C: fetch/cache scheduler, storage/audit wiring, prompt assembly and source display (steps 3–5 integration) | S | RA | A defines immutable hashes, schema migration, coverage/claim rules and untrusted-text boundary; changes to them return to A |
| PP5-A: durable lifecycle observer, pause/close permissions, session exit deadline, protective cancellation/reprotection, unknown holds and recovery (steps 1–5) | A | RA | PP3; includes lifecycle race/crash tests, state migration, shutdown and critical-alert trigger semantics |
| PP5-B: alert transport/delivery ledger/dedup wiring and observability (step 5 integration) | S | RA | PP5-A defines fault IDs, persistence/ack contract and unattended gate; stubs only; critical suppression or retry semantics remain A |
| PP6-A: Polish log/report rendering, read-only filters, timelines, source references and formatter tests | L | RS | PP6-C event/privacy contracts first; presentation only, with no derived safety state, P&L calculation or authorization |
| PP6-B: structured event instrumentation, read aggregation, terminal report integration and existing authenticated control access | S | RA | PP6-C contracts and PP0–PP5 interfaces fixed; no new broker route, retry, risk, ownership or admission semantics |
| PP6-C: event/coverage/privacy and control contracts, UI-off deployment, retention/restore, manual-intervention evidence and integrated recovery acceptance | A | RA | Design before PP6-A/B; integrate after them; owns missing-data semantics, broker mismatch holds, secrets and rollback compatibility |
| PP7-A: prepare manifest; judge Gates A–D; authorized supervised entry/exit, soak and restart coordination; incident decisions | A | RA | PP0–PP6 complete plus explicit Paper/provider authorization; model routing is not operational permission |
| PP7-B: execute specified read-only evidence queries, collect/format session observations and CI/check results | M | A judges evidence | PP7-A supplies exact commands and scope; no broker writes, paid calls, repairs, activation or automatic go/no-go |
| PP7-C: isolated failure/restart harness integration and evidence summaries (Gate D) | S | RA | A specifies failures and invariant assertions; new broker/race/recovery semantics stay A; disposable state/stub adapters |

Every row includes implementation of its relevant positive/negative tests and
documentation; critical acceptance tests are designed and reviewed by A/RA, not
merely generated from the code under test. Package acceptance, migration and
rollback obligations below remain binding even if not repeated in a row. The
package's A task owns unresolved requirements and critical integration; a task
discovered later is classified before delegation, never implicitly assigned to L.

For all packages, M runs the exact checks specified by the lead, commits only the
reviewed scope, pushes and monitors exact-commit CI. The lead owns diagnosis and
acceptance. M may transcribe evidence into the report; A verifies critical claims.
Follow section 12 and AGENTS.md in full. A failed targeted repair promotes L -> S
and persistent/critical work -> A under the guide; promotion never weakens a gate.
Each package report records actual model/effort, acceptance, repair/review effort
and usage when available. Do not promise savings before the PP1-B pilot is measured.

## 4. PP0 — Operational security and usable controls

Implementation evidence: [bounded plan](PP0_IMPLEMENTATION_PLAN.md),
[report](PP0_IMPLEMENTATION_REPORT.md) and
[operator security runbook](../../runbooks/OPERATOR_SECURITY.md).
This package does not authorize operational deployment or entries.

**Problem:** UI delegates its execution token to unauthenticated callers, published
ports default to all host interfaces, ingestion/strategy mutations lack complete
authentication, and the UI signal action calls a deliberately retired route.

**Implementation boundaries:** `docker-compose.yml`, `apps/ui/vite.config.ts`,
UI actions, ingestion/signal route registration, shared existing auth helpers where
appropriate, dependency manifests/lockfile and security/runbook docs.

1. Default host-published operational services, Postgres and Redis to loopback;
   retain internal Docker connectivity. Inventory every mutating operational route.
2. Authenticate ingestion start/stop and strategy controls. Protect UI delegation
   with an authenticated operator session or approved authenticated reverse proxy.
   Do not put shared backend secrets in browser storage/bundles. Include CSRF/origin
   protection appropriate to the selected browser authentication mechanism.
3. Switch the UI action to the supported bound runtime with its proper response
   contract and authenticated forwarding. Preserve retired route rejection.
4. Refresh dependency audit and remediate reachable/advised Fastify upgrades with
   compatibility tests. Document residual exposure, not just audit score totals.

**Acceptance:** unauthenticated direct/proxied mutations fail; an authorized
operator can evaluate through the normal flow. Cookies/tokens cannot leak through
logs or redirects. LAN reachability is an explicit opt-in. No risk/account/write
checks are bypassed, including cancel exemptions. Test wrong credentials, cross-origin
requests, proxy path confusion and disabled writes. Clean Docker build required.

**Rollback:** deploy last reviewed image with entries disabled; never restore the
unprotected proxy to regain convenience. No schema migration anticipated.

## 5. PP1 — One versioned configuration authority

**Implemented source scope:** strict four-service JSON startup consumers, versioned
momentum parameter declarations, canonical hashes, durable snapshots/observations,
entry admission barriers, retained management monitoring and broker-evidence reads.
Independent review, local checks, publication and exact-commit CI passed.
No strategy factory parameter application,
trading activation or deployment is included. Bundle entries remain denied even
with matching hashes and entry-enabled declarations.

**Normative contract:** [PP1 configuration](PP1_CONFIGURATION_CONTRACT.md).
See the [bounded plan](PP1_IMPLEMENTATION_PLAN.md), [report](PP1_IMPLEMENTATION_REPORT.md)
and [configuration runbook](../../runbooks/TRADING_CONFIGURATION.md).
The [architecture design](../../architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md)
contains future PP2 behavior and a non-loadable illustrative shape.

**Touchpoints:** shared instrument/config types and registry, application config
bootstrap in ingestion/signal/execution/llm, Compose read-only mount and diagnostic
endpoints. No new strategy algorithm or trading activation.

1. Implement strict schema for strategy instances, instruments, assignments,
   account/entry/execution/research policy references and explicit units.
2. Resolve effective defaults and canonical hashes once; every service verifies
   the same version. Separate secrets and environment activation from the bundle.
3. Resolve/verify broker contract metadata without ticker fallbacks. Derive sessions,
   tick bands and quote requirements from broker identity and supported capabilities.
4. Add migration mode for old flags/bindings, rejecting simultaneous conflicting
   old/new authorities. Default to disabled entries during conversion. Both stock
   definitions may be loaded together; do not preserve mutual exclusion as design.
5. Expose validation diagnostics and per-instrument readiness, with config drift
   blocking entry. Initial loading is at startup; hot reload is out of scope.

**Acceptance:** invalid references/parameters/capabilities fail before any dispatch;
monitor-only remains possible; unknown config versions fail explicitly. Two copies
of one strategy definition with distinct IDs are representable without shared state.
Use fixture-only instruments outside the production ticker catalogue to verify
all consumers. Test duplicate conId/listing, primaryExchange versus routing venue,
unknown fields, mismatched currencies, missing mappings and cross-service hashes.

**Migration:** add versioned configuration audit/snapshot persistence as needed;
never modify released SQL. Preserve old proposals and their existing hashes. Record
old/new config identities and disabled rollout evidence. Rollback restores the last
compatible bundle and image while retaining management of existing owned positions.

## 6. PP2 — Parameterized strategies and assignment-aware runtime

**Touchpoints:** strategy registry/factories/types, shared profiles, portfolio
manager, active resolver, context loader, runtime state repository, ticket mapping,
proposal/AI identity and simulator strategy construction.

1. Separate algorithm ID from instance ID/revision. Define implementation-specific
   parameter schemas with units/ranges and versioned defaults. Initially expose
   the existing momentum strategy's parameters; other registered algorithms gain
   configurations only with their own schema and parity checks, without new algorithms.
2. Construct isolated strategy objects per account/instrument/instance binding.
   Reuse immutable parameters, never mutable rejection/cooldown state.
3. Evaluate only assigned enabled instances. Implement single selection and test
   explicit priority-mode conflict rules; opposite-direction candidates block.
   No unrelated enabled strategy may create a mismatch or demand extra candles.
4. Scope state/cooldowns to the binding, preserve account-wide risk/entry fences.
   Changing a revision cannot reset safety counters or duplicate a trigger.
5. Add durable algorithm/instance/revision/config identity through signal,
   proposed_orders, review, risk, order links and UI/backtest attribution.

**Migration:** additive columns/tables and versioned canonical hashing; dual-read
old records while controlling new writes. Define an explicit drain/invalidate
procedure for unattempted old proposals; unknown/attempted records cannot be reset.
Old positions retain the original exit policy even if the instance is disabled.

**Acceptance:** identical defaults preserve existing signals in fixtures/replays;
two parameter sets of the same implementation produce independently attributable
results; two bindings do not share state. Reassigning an instrument requires no
code edit. Test multiple algorithm schemas, malformed params, strategy exceptions,
priority ties/conflicts, disabled assignment, restart and revision-change races.
Run relevant backtests in addition to required repository suites.

## 7. PP3 — Generic bounded stock execution and evidence

**Implementation:** [bounded contract](PP3_IMPLEMENTATION_PLAN.md),
[report and validation](PP3_IMPLEMENTATION_REPORT.md),
[policy runbook](../../runbooks/PAPER_EXECUTION_POLICY.md). Bundle entries retain
PP4 research denial; full Warsaw-day accounting certification is an additional
operational blocker. No deployment/activation or PP5 scheduled policy is included.

**Touchpoints:** configured registry/policies, ai-entry-risk, broker order planning,
market-rule/session adapters, submission service, generic window/budget repository,
lifecycle close risk and round-trip collector. Reuse existing binding and calendar.

1. Replace AAPL/GPW business branches with validated stock/venue/currency capability
   checks. Never derive venue from USD alone. Verify current broker metadata and
   exact quote/session evidence immediately before submission and close.
2. Introduce generic Paper run policy and durable attempt reservation. Migrate
   aapl_windows/gpw_windows through adapters or additive generic tables, keeping
   historical consumed budgets/reports and preventing reset by account/config/run ID.
3. Generalize entry/exit audit and completion reporting to any supported contract;
   retain instrument-scoped completion and account-wide risk/identity reconciliation.
4. Preserve one whole share and one active account-wide bot intent for initial
   broker acceptance. Do not claim general partial-fill/quantity support. Reject
   unsupported quantities/currencies before risk/provider use.
5. Define the transition from supervised one-attempt windows to the PP7 bounded
   scheduled policy: at most two entry attempts/account/day, at most one per
   instrument/day, quantity1, one active owned intent/position, no overnight, and
   explicit per-currency notional/stop/daily-loss caps signed off in the launch
   manifest. Until that transition is deployed/reviewed, keep the current stricter
   budget. Unknown dispatch consumes a slot; no automatic same-day rearm.

**Acceptance:** PKO and AAPL load together and pass fixture paths independently;
a third fixture stock absent from source does too. Reject ETF/FUT, unsupported FX,
wrong venue/grid, stale BBO/calendar, foreign config hash and missing account evidence.
Race tests include simultaneous instruments competing for the single account
reservation, day boundaries/DST, crash after reservation and before ack, config
rollback, budget migration and external/manual exposure. No duplicate broker call.

**Rollback:** pause new entries; keep reconciliation/protection operating. Switch
image/config only after compatibility and original ownership are verified. Never
delete local orders or budget rows to mimic a flat account or regain permission.

## 8. PP4 — Instrument research and complete AI audit

Implementation: [bounded plan](PP4_IMPLEMENTATION_PLAN.md),
[source mapping contract](PP4_PROVIDER_CONTRACT.md),
[implementation and actual coverage report](PP4_IMPLEMENTATION_REPORT.md).
Code review is accepted; latest PKO periodic extraction, complete news/calendar
coverage and operational permissions remain explicit blockers. This is not full
real-source acceptance or trading authorization.

**Contract:** [research context](../../architecture/INSTRUMENT_RESEARCH_CONTEXT.md).
**Touchpoints:** llm-agent providers/repository/worker/decider, shared evidence types,
issuer/provider mappings and additive research storage. Execution consumes only
validated decision identity/results; no LLM reasoning is moved there.

1. Implement generic issuer/listing resolution for both initial stocks; remove
   hardcoded PKO/AAPL prompt identity branches after parity/collision tests.
2. Verify practical source coverage/entitlements for PKO and AAPL before purchasing
   broad subscriptions. Record selected provider/endpoints, allowed use, normalized
   fact mappings, refresh schedule and failure behavior in the bounded PP4 plan.
3. Fetch/cache immutable research snapshots independently of entry claims, including
   reports, issuer facts, material news and earnings/event coverage. See the source
   policy defaults and bank-specific reporting requirements in the contract.
4. Pin eligible snapshot/config hashes to proposals/decisions. Validate source
   identity, time, currency, coverage and required-data policy deterministically.
5. Persist model riskFlags, evidence references, prompt/model version, timings and
   outcomes. Implement deadline/lease budget and bounded provider retries/costs.
6. Define ETF-specific schema with explicit NOT_SUPPORTED status until verified
   providers and full ETF execution/lifecycle capability are delivered together.

**Acceptance:** reproducible context for a stored decision; required missing/stale
research blocks entries; optional missing sources are visible. Test issuer collision,
future reports/restatements, reporting periods/units, malformed news timestamps,
prompt injection text, invalid model output, claim expiry/restart, source outage
and price change while AI runs. Fresh risk recheck must reject a now-invalid entry.
A rejecting model does not trigger threshold tuning or a retry-for-approval loop.

**Operations:** live provider diagnostics need separately scoped authorization and
request/cost caps. No claim of provider readiness from an API key alone. Rollback
halts new reviews/entries while retaining snapshots and existing exit supervision.

## 9. PP5 — Automated protection, exits and recovery

Implementation: [accepted bounded plan](PP5_IMPLEMENTATION_PLAN.md),
[implementation report](PP5_IMPLEMENTATION_REPORT.md) and
[permission/recovery runbook](../../runbooks/PAPER_LIFECYCLE_SUPERVISION.md).
The supported failure fallback is durable HOLD and critical escalation; automatic
replacement/reprotection is not implemented. Master-switch meaning is unchanged.

**Touchpoints:** execution lifecycle service/repository/routes, reconciliation
scheduler, broker adapter, account reservations, entry guards and alerts. Keep close
as a deterministic audited operation independent of entry AI availability.

1. Add durable background observation of owned bracket/close legs and final flat
   state. Restart reconstructs pending work from durable ownership and broker facts.
2. Implement explicit entry pause while preserving supported cancel/exit/reconcile
   permissions under auth/account/risk guards. Do not reinterpret TRADING_ENABLED
   silently; document a migration from its current full-close-blocking behavior.
3. Enforce the configured end-of-session exit deadline relative to verified broker
   sessions, including early close/DST. Expiring an entry window is not an exit.
4. Specify safe handling after protective cancellation if close cannot be placed,
   remains working/unfilled or becomes unknown. Bounded cancel/replace/reprotection
   is allowed only after exact broker outcome/current quantity is proven and through
   audited deterministic operations; otherwise durable hold and critical alert.
5. Detect protection gaps, orphan ownership, competing external orders, disconnected
   feeds and stale account state. Reconcile before any resumption. Persist alert
   deduplication and delivery outcomes; inability to deliver critical alerts blocks
   unattended acceptance. Reuse existing notifications; do not add new providers
   without need. Tests use stubs, never real recipients.

**Acceptance:** normal entry/protection/exit/flat observation completes without
manual HTTP polling. No reverse/oversell, duplicate close or entry during a reserved
close; shutdown never drops protective orders. Test SL/TP fills racing with close,
cancel ack loss, close rejects, unfilled LMT, broker reconnect/order-ID changes,
DB outage and crashes around every durable transition. A blocked uncertain close
remains reserved and visible, not marked complete. Quantity1 limits stay explicit.

**Operational response targets for PP7:** lifecycle polling no slower than5s,
critical local alert generated within15s of observed protection/unknown-state fault,
notification delivery/acknowledgement status observable within60s where transport
is available. No guarantee of exchange fill latency. If independent broker evidence
is unavailable, entries stay paused and operator escalation is required.

## 10. PP6 — Headless diagnostics, deployment and recovery

**Status:** revised by owner on 2026-10-04; implementation remains planned. Custom
web UI development is deferred. Retain existing UI source and PP0 security fixes.
IBKR desktop is the owner's broker interface; bot-specific evidence and decisions
must be understandable without running our UI.

**Touchpoints:** existing service loggers, audit/read models, shared event types and
pure formatters where useful, small terminal/report tooling, readiness verifier,
PP5 controls/alerts, Compose/deployment and backup/restore docs. No new service,
web dashboard or required ELK/Grafana/cloud logging. Actual command names and storage
choices belong in the bounded PP6 implementation plan; the capabilities below are
requirements, not shipped commands.

**Order:** PP6-C establishes event/completeness/privacy and operational contracts;
PP6-A implements pure presentation and PP6-B instrumentation/read integration.
PP6-C then integrates and validates recovery. Reuse PP0–PP5 lifecycle/risk/audit and
notification mechanisms rather than implementing parallel ones.

### Readable events and diagnostic coverage

1. Versioned structured JSON events and a Polish human-readable view derive from
   the same fields. Include stable event ID/code, severity, service, UTC timestamp,
   plain message/reason, impact and safe next action where applicable. Human time
   includes an explicit timezone/offset; sorting and export retain UTC.
2. Include applicable instrument ID/conId/listing, algorithm/instance/revision,
   config hash, evaluation/trace, proposal, broker-order and lifecycle/close IDs.
   Correlation survives services/restarts; symbol alone is insufficient. Unavailable
   or inapplicable IDs are explicit, never fabricated. Mask account identifiers and
   retain a restricted authorized path to exact audit records.
3. Cover readiness, scheduled evaluation/no-signal, proposal/research, AI verdict/
   timeout, fresh risk, dispatch/unknown outcome, broker acknowledgement/fills,
   protection, close/reconciliation and fault/delivery status. Preserve broker codes
   with plain explanations. Submitted is not filled; an error is not no-signal.
4. Per-instrument status retains assigned strategy/config identity, quote entitlement/
   type/age, session/history readiness, research coverage/age, decision/risk reasons,
   broker legs/protection/close/holds and P&L currency/fee completeness. Distinguish
   process health, paused entries, closed market, missing/stale data, unknown state
   and faults. Unavailable accounting values are not zero.
5. Decision details reference stored research snapshots, source/document/publication
   identities and recorded AI verdict/rationale/riskFlags plus deterministic risk.
   Do not dump provider payloads, prompts or secrets into routine logs. Evidence
   lookup uses authenticated stored records, not new provider calls. Rendering must
   not invent missing facts or change decision/admission semantics.

Illustrative Polish presentation (synthetic IDs/reason names, not broker evidence):

```text
10:05:00 +02:00 | PKO/WSE | OCZEKIWANIE | Brak sygnału strategii. Kolejna ocena za 60 s.
10:06:00 +02:00 | PKO/WSE | WEJŚCIE ZABLOKOWANE | Wymagane dane badawcze są nieaktualne.
Powód: RESEARCH_REQUIRED_STALE | ocena: demo-42 | Działanie: sprawdź status źródła danych.
16:01:12 +02:00 | AAPL/NASDAQ | DECYZJA AI: ODRZUĆ | Uzasadnienie: zapisane przy propozycji demo-43.
```

### Easy analysis without a browser

Provide simple documented terminal entry points for these operations. Normal use
must not require custom SQL, jq scripts or bearer tokens in shell history. Default
operations are read-only; mutating controls are explicit and separately authenticated.
Reuse read endpoints/audit storage; add only missing query/projection capabilities.

| Operator need | Required result |
| --- | --- |
| Follow the bot | Readable live events with instrument, severity, reason and time filters; bounded output and explicit reconnect/gap status |
| Why is it not trading? | Current per-instrument reasons, source ages, coverage and permitted next steps; partial/unavailable evidence visibly limits the answer |
| Explain one evaluation/trade | Correlated signal/research/AI/risk/broker/close timeline and exact stored evidence references |
| Summarize a session | Evaluations/no-signals/blocks by reason, attempts, fills/exits, holds/alerts and currency-aware P&L completeness; timezone and interval coverage |
| Share diagnostics | Time-bounded, size-limited redacted text/JSON export with schema/config metadata and explicit omitted/truncated intervals |

Default INFO explains transitions/outcomes without tick spam. Aggregate repeated
noncritical states with count and first/last times while retaining underlying audit/
counters for interval accounting. Never sample away the first critical fault or its
resolution. Reuse PP5 episode dedup and delivery health; logging is not proof of
notification receipt, fault resolution or broker-flat state. Broker/audit evidence
remains authoritative; reports cannot grant permission to trade.

Define duplicate/out-of-order handling and completeness after restart, rotation,
reader disconnect and clock skew. Session totals come from persisted evidence and
coverage, not sampled console counts. Distinguish zero, not observed and unavailable
intervals. Specify bounded disk/age retention and rotation in the implementation
plan; diagnostic-copy expiry cannot erase required audit/research records. Escape
control characters/untrusted source/model text. Redact credentials, account IDs and
sensitive balances by default, including exports. A failed log sink stays visible;
never claim durable recording during storage outage or mark partial coverage healthy.

### Controls, manual IBKR intervention and recovery

Document terminal access to existing authenticated PP5 pause/resume, supervision
and supported audited close/reconciliation using the
[implemented permission contract](../../runbooks/PAPER_LIFECYCLE_SUPERVISION.md).
Entry pause leaves exit automation active. Master=false blocks full close but does
not cancel broker orders or undo a dispatched action. Resume retains all current
broker/research/risk/observer/alert gates; no report clears holds or resets budgets.

Manual purchases/sales are external broker events, not strategy entries. Do not
adopt arbitrary manual holdings or guess who submitted an order; unknown attribution
stays explicit. Before intervention in bot-owned exposure, the runbook must identify
active automatic close work and protective legs and specify a supported coordinated
takeover. Pausing entries alone is not such a protocol. If PP5 cannot prove quiescent
management for the intended intervention, document the limitation and require a
separately reviewed capability before claiming seamless manual takeover.

After intervention, verify fresh broker quantity, outstanding protective/close
orders, executions and ownership through supported reconciliation. No second sale,
blind cancel, hold deletion, budget reset or new request ID to escape uncertainty.
Unsupported quantity/ownership or unknown outcomes remain HOLD and visible; a missing
capability requires a bounded reviewed fix. Unrelated manual exposure participates
in account-wide risk without silent bot management. No automated IBKR UI or real
broker actions in tests. Manual incident recovery is not normal-flow PP7 proof.

Deployment starts required bot services with `apps/ui` stopped and records exact
image/code/config/migration identity. Document service selection or an optional UI
profile while retaining shared trading logic and secret/auth guards. Deployment
config changes require a clean Docker build. Rehearse backup/restore on disposable
state: ownership, attempts, config/research/AI evidence, close markers, entry-control
and fault/delivery records stay interpretable. Reconcile before writes; stale backup
cannot prove absence of orders since backup. Keep rollback compatible with ownership.

**Acceptance:** with UI stopped, a non-developer following the runbook can answer
"why no trade?", "what happened to this trade?" and "is action needed?" using the
operations above for PKO, AAPL and a configured fixture stock. Tests cover all lifecycle
states, source outage/expiry, mixed currencies/missing fees, duplicate/reordered/gapped
events, rotation/restart, redaction/hostile control characters, read-only behavior and
authenticated mutation boundaries. Isolated fixtures cover manual sale racing close,
changed quantity, unrelated exposure and orphan protection; unsupported cases show
HOLD rather than false success. Preserve PP5 timing/alert gates. A restore drill
proves no writes before ownership and broker state reconcile. Headless diagnostics
do not resolve PP4 coverage or certified broker-accounting blockers or prove PP7.

## 11. PP7 — Broker acceptance and automated Paper soak

The [acceptance runbook specification](../../runbooks/PRODUCTION_PAPER_ACCEPTANCE.md)
becomes executable only after PP0–PP6 are shipped and reviewed. Record explicit owner
Paper/provider scope; the documentation request itself does not activate trading.

### Gate A: disabled preflight

Verify exact code/image/config hashes across services, Paper account allowlist,
USD account evidence, both intended bindings, authenticated controls, current broker
coverage/holds, subscriptions, real-time BBO, six required native closed histories
where required by the resolved strategy/regime, research coverage and provider/model
availability. Readiness must distinguish off-session from source failure. No paid
call is implicit in infrastructure preflight. Stale/incomplete evidence is a stop.
Require PP6 readable logs/reports, current status/coverage and authenticated terminal
controls with `apps/ui` stopped; no web dashboard is a launch prerequisite.

### Gate B: supervised mechanics

At most one entry attempt/account/day initially, quantity1, long/LMT/bracket, one
active account-wide bot intent. Within separately authorized actual sessions, obtain
at least one real strategy-generated, AI-approved entry and completed exit for each
initial instrument (on separate days if necessary). Record costs and final flat
state with no remaining working orders for that instrument. Confirm actual broker
protection and lifecycle audit. Do not force signals, manufacture approvals or
reuse another instrument's result. No-signal/REJECT records a valid pending gate.

### Gate C: bounded automated operation

After PP5 and explicit activation of the PP3 repeated-entry policy, complete at
least **five consecutive scheduled trading sessions per initial instrument** with
both configured, quote/research monitoring and scheduler active during authorized
windows. Multi-market sessions are counted separately by the instrument calendar.
Require observed real normal-flow entry/exit for each instrument across GateB/C;
without such evidence the overall acceptance remains incomplete even if the soak
has only valid no-signal days. Additional trading days require extending authorized
scope, never removing limits or changing parameters to obtain a pass.

Initial soak caps: quantity1; one active bot intent/position account-wide; maximum
two entry attempts/account/day and one/instrument/day; no overnight; explicit finite
notional, stop-risk and daily-loss caps with currencies recorded in the launch
manifest. Account/day boundary uses one configured IANA timezone (initially
Europe/Warsaw); per-instrument session dates are separate. Changing timezone/run ID
must not reset a consumed budget. No configuration change during a counted soak.

Success requires zero duplicate submissions, zero oversells/reversals, zero unknown
states silently cleared, zero unowned bot fills and zero unresolved protection
incidents or overnight positions. Every attempted entry has complete attribution,
AI and fresh risk; every resulting position has proven protection and terminal
exit/accounting evidence. All expected evaluation intervals are accounted for as
evaluated or explicitly blocked; an unexplained gap longer than two configured loop
intervals invalidates that session. Measure provider latency/cost, decision outcomes,
slippage/fees and reconciliation latency; profit is not a mechanics pass criterion.

### Gate D: failure/restart evidence

Test broker disconnect, stale feed, missing research/provider timeout, DB/Redis
outage, lost submission/cancel ack and alert delivery failure using isolated adapters
and disposable state. Do not manufacture broker ambiguity with real orders.
Perform an authorized clean service restart during Paper acceptance and prove
ownership recovery and no duplicate entry. Restarts while flat can be live evidence;
open-position crash/race coverage may be isolated fault-injection evidence, clearly
labelled, without claiming a live broker crash drill occurred.

An observed critical incident pauses entries immediately, keeps supported exit/
reconcile management active and invalidates the affected counted session. Diagnose,
review/fix/test, redeploy and restart the five-session count after a material code,
config or safety-policy change. No automatic retry of the uncertain broker action.

## 12. Common implementation checks and rollout

Each PP package has a bounded plan and new independent implementation reviewer.
For code/config changes run lint, typecheck, unit tests, integration on isolated
PostgreSQL and build; relevant backtests for strategy/simulator changes; clean Docker
build for deployment changes. Follow the declared pnpm version. Tests assert real
failure invariants rather than merely reproducing implementation structure.

Do not use operational databases for fixtures. Standard integration uses only
TEST_POSTGRES_URL for its disposable DB. Frozen ES diagnostics require their own
source dataset/target and are not enabled by pointing TEST_RESEARCH_POSTGRES_URL at
an empty fixture. Preserve frozen data and unrelated local work.

Deploy with entries disabled, record private backup/migration evidence, compare
service versions and inspect current broker state. Enable only the authorized
bounded scope after gates. Any rollback must keep existing ownership interpretable;
where old code cannot manage new state, leave entries paused and use the supported
recovery version. No blanket deletion, hash rewriting or budget resets.

## 13. Final definition of done

PP0–PP7 acceptance evidence is linked from one current-state report; final exact
commit CI passes; configuration-only additional-instrument tests and independent
strategy-instance tests pass; research coverage for both issuers is real and
versioned; normal entry/exit is automated; five-session operational criteria and
failure drills pass. The owner can configure instances, assign them to instruments,
start a bounded Paper deployment with UI stopped and understand/recover its state
through readable logs/reports without manual run-once or close-reconcile requests
for normal operation. Live stays off.
