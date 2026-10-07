# AI Trading Platform roadmap

Owner correction 2026-10-07: calendar events inform AI adjudication of existing technical proposals; no automatic event-proximity blackout or new signal logic. The [WSH context package](phase3/PP7_WSH_CONTEXT_IMPLEMENTATION_REPORT.md) records implementation and validation separately from deployment and Paper trade evidence.

Updated: 2026-10-06 (PP7 reviewed source published with successful CI; operational Gates A–D remain unaccepted).
Current code/evidence: [CURRENT_STATE.md](CURRENT_STATE.md).
Detailed execution sequence: [Production-style Paper delivery](phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md).

## Owner-selected outcome

Run the existing platform as a production-style automated bot on **IBKR Paper**.
Initially configure PKO and AAPL and one parameterized existing strategy. Maintain
separate catalogues for strategy configurations and instruments; each instrument
selects previously defined strategy configurations. Support further instruments
within verified capabilities through configuration, without ticker branches.

The completed product must evaluate scheduled signals, obtain source-backed AI
entry adjudication, enforce deterministic risk, submit and protect orders, manage
exits, recover safely after failures and explain its state to the operator.
One supervised round trip is a prerequisite, not the finish line. Live activation,
new strategy development and ES research are outside this delivery track.

The owner has deferred the custom web UI. PP6 provides understandable Polish
logs, easy read-only terminal reports and existing alerts. IBKR desktop is the
owner's account/manual-trading interface; bot decisions, data gaps and holds remain
visible through our diagnostics. Existing UI code/security fixes are retained;
running that service is not a PP6/PP7 requirement.

## Reuse the delivered work

Bound contracts, strategy attribution, durable proposal identity, mandatory AI
reviews, submission/reconciliation, ownership, one-share full-close and generic
session/native-candle readiness are implemented. Do not restart those subsystems.
Configuration, research source contracts and headless operator diagnostics are delivered;
real research coverage and broker-backed automated operation remain gated. PP0 supplies the reviewed operator security baseline;
see the evidence matrix in CURRENT_STATE.

## Current sequence

PP0 is implemented, reviewed and published with successful CI; see the
[PP0 report](phase3/PP0_IMPLEMENTATION_REPORT.md). PP1 source now implements the
[normative configuration contract](phase3/PP1_CONFIGURATION_CONTRACT.md): strict
startup JSON, canonical identity, snapshots/service observations, denied bundle
entry and retained monitoring/management. Independent hostile review, required local checks, publication and exact-commit
CI passed; evidence is in the
[PP1 report](phase3/PP1_IMPLEMENTATION_REPORT.md). PP2 adds parameterized factories,
assignment-only evaluation, stable safety state and immutable attribution; see the
[PP2 report](phase3/PP2_IMPLEMENTATION_REPORT.md) for accepted review, required local
checks, publication and successful exact-source-commit CI.
PP3 implements generic stock execution, immutable attempts and lifecycle evidence;
independent review, required checks, publication and exact-source-commit CI passed.
See the [PP3 report](phase3/PP3_IMPLEMENTATION_REPORT.md). PP4 implementation is reviewed; real-source acceptance remains **blocked**. See the
[PP4 report](phase3/PP4_IMPLEMENTATION_REPORT.md). PP5-A/B is delivered; independent review, required local checks and exact-source CI passed; see the
[PP5 report](phase3/PP5_IMPLEMENTATION_REPORT.md). PP6 is delivered with independent review, required local checks, isolated recovery and successful exact-source CI; evidence is in the
[PP6 report](phase3/PP6_IMPLEMENTATION_REPORT.md). PP7 source now connects the
configured scheduler to durable proposals, preserves selected strategy evidence,
and adds bounded scheduled policy authority and durable budgets. Calendar evidence
and broker request windows are tightened. Integrated verification and publication
are recorded separately in the [PP7 report](phase3/PP7_IMPLEMENTATION_REPORT.md).
Real mandatory research/model coverage and certified Warsaw account-day accounting
remain blocked by the [documented source/capability gaps](phase3/PP7_EF_EVIDENCE.md).
Gate B and Gate C have no real broker acceptance evidence. Scheduled activation
still requires supervised Gate B and explicit bounded authorization.
No operational deployment or trading activation is included.
Each package receives its own bounded plan, independent plan review, implementation,
independent hostile review, checks, report, scoped commit/push and exact CI.

| Package | Result | Depends on |
| --- | --- | --- |
| PP0 | Secure operator/API surface; dependency remediation and accurate UI entry point | Current baseline |
| PP1 | Delivered: versioned configuration, validation, rollout identity and monitoring; checks/review/CI passed | Current baseline; PP0 before operational use |
| PP2 | Delivered: parameterized factories, assignment-only runtime and durable instance attribution; checks/review/CI passed | PP1 |
| PP3 | Delivered: generic stock capability/windows/budgets/audit for PKO, AAPL and configured fixtures | PP1, PP2 |
| PP4 | Implemented/reviewed cached research and AI audit; full real-source acceptance blocked — see report | PP1; integrate with PP2/PP3 before entries |
| PP5 | Delivered automatic lifecycle, durable pause and alert delivery; review/checks/CI passed | PP3 |
| PP6 | Delivered headless Polish logs/JSON, terminal reports, existing controls and recovery; review/checks/exact-source CI passed | PP0–PP5 |
| PP7 | Reviewed/published source: D handoff, E calendar coverage, F request bounds, G scheduled authority; E/F real-source blockers and Gates A–D remain — see report | Reuse PP0–PP6; D/E/F before Gate A/B; G plus Gate B before Gate C activation |

PP4 research implementation may proceed independently after the identity contract
is fixed. Final integration and broker activation remain sequential and gated.
Do not fund broad external-data subscriptions before checking coverage for both
initial issuers. A missing provider contract is an explicit delivery blocker.

## Implementation models

An optional [supervised LOCAL pilot](phase3/MODEL_ROUTING_GUIDE.md#local--supervised-edit-proposals)
now allows individually bounded noncritical edit proposals from an installed LLM,
with Astra/Sol controlling context, patch application, tests and escalation.
See [setup](../runbooks/LOCAL_LLM_CODING.md) and
[probe evidence](phase3/LOCAL_LLM_WORKFLOW_REPORT.md). This does not change the
delivery queue or authorize local handling of critical PP packages.

The [task-level model matrix](phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md#31-model-assignments)
assigns Luna medium to bounded implementation, Sol medium to noncritical integration
and Astra high to critical semantics and integration. Mechanical duties retain
GPT-5.6 Luna low. Full PP packages require independent Astra plan and implementation
reviews; separately bounded noncritical deliveries may use Sol high reviewers.
Quality, acceptance and required checks take priority over token savings.

Use the [routing guide](phase3/MODEL_ROUTING_GUIDE.md) for task packets, promotion,
review independence and usage reporting. The first Luna implementation pilot is
PP1-B after the PP1-A contract is accepted, with no trading activation. This does
not reorder delivery dependencies or change the bot's trading-decision model.

For revised PP6, Astra establishes event/privacy/control/recovery contracts first
(PP6-C), Luna implements pure human-readable formatting/filtering (PP6-A), and Sol
integrates events/reports and existing APIs (PP6-B). Astra then owns integrated
safety acceptance; a different Astra performs the final independent review.

PP7-D/F/G and critical PP7-E research semantics use Astra high; E may delegate pure
accepted mappings to Luna medium and known-contract wiring to Sol medium. PP7-A
owns integration and operational gate decisions, B specified mechanical evidence,
and C the isolated failure harness. Independent Astra plan/final reviewers remain
different agents. See the PP7 plan for exact scope and invariants.

## Completion criteria

- PKO and AAPL coexist in one validated configuration; only assigned enabled
  strategy instances run. Reusing an implementation with different parameters
  preserves separate identity, state and audit.
- A supported additional instrument is accepted in fixtures using only config;
  an unsupported asset/policy combination fails before any order/provider call.
- All entries use persisted proposal, immutable configuration/research identity,
  mandatory AI and fresh deterministic execution risk. Rejections remain visible.
- Normal exits and close reconciliation are automated, with bounded uncertainty
  escalation and no duplicate submissions or accidental reversal.
- The operator can pause new entries without losing supported protective/exit
  supervision. Current master-switch behavior is not reinterpreted retroactively.
- With the UI service stopped, the operator can follow readable events, explain
  non-trading, inspect one decision and reconstruct its full lifecycle using simple
  terminal reports. Missing/stale evidence and manual broker changes stay explicit;
  only supported reconciliation can establish safe resumption.
- PP7 documents real entry/exit evidence for both initial instruments and the
  specified automated soak/restart/failure criteria. No-signal periods do not prove
  trading mechanics; signals or approvals are never fabricated to obtain a pass.
- Paper operation uses the business lifecycle intended for production. Live stays
  disabled and requires separate readiness review and owner authorization.

## Long-term capability map

The original phase numbers remain classification labels, not an instruction to
finish every earlier research task before this track.

| Phase | Capability | Current disposition |
| --- | --- | --- |
| 0 | Architecture baseline | Historical audit; current map maintained in docs |
| 1 | Execution security | Implemented baseline; PP0 closes newly identified control-plane gaps |
| 2 | Reliability | Durable bound entry/reconciliation implemented; real Paper proof pending |
| 3 | Order lifecycle | Ownership/full close implemented narrowly; PP3/PP5 generalize and automate |
| 4 | Instrument registry | Foundation implemented; PP1/PP2 deliver operator configuration |
| 5 | Decision layer | Shared deterministic rules and separate AI gate implemented; PP4 enriches evidence |
| 6 | Market context | Price/technical evidence exists; PP4 adds issuer research; broad macro/flows later |
| 7 | Operator diagnostics / future dashboard | PP6 delivers logs/reports/terminal operation; custom web UI deferred by owner |
| 8 | Autonomous Paper | Target of PP7 after lifecycle/recovery gates |
| 9 | Live readiness | Deferred; this track never authorizes Live |

## Deferred work and historical records

Custom UI development is outside the current Paper delivery track. Reconsider it
only if the owner later needs it; do not replace it with another web dashboard or
require a hosted logging stack. [PP6 scope change](phase3/PP6_HEADLESS_REPLAN_PLAN.md)
records the decision; runtime logs/reports are now delivered in PP6.

ES PR15.5D.3 remains REJECTED_FOR_ES. PR15.5F local diagnostics are unfinished and
off the critical path; preserve source, frozen data and verdicts. Futures roll,
options, shorts, fractional quantities, leverage and complex partial/trailing
exits require explicit capability stages, not permissive flags. ETF entry/exit
support is a separately bounded extension using the same contracts.

[Phase2 history](phase2/PHASE_2_ROADMAP.md) and earlier instrument plans retain
historical evidence. The current owner direction supersedes their next-step order.
[Documentation reconciliation plan](phase3/PAPER_PRODUCTION_DOCUMENTATION_PLAN.md)
records the original delivery-direction reconciliation. PP0/PP1 implementation
evidence is linked above; PP2 implementation evidence is also linked. PP3 implementation evidence is linked above; PP4 implementation/report is linked above; required real-source acceptance remains blocked. PP5 validation is recorded in its report; PP6 is delivered with accepted review, required checks, recovery drills and exact-source CI; see its report. PP7 implementation/evidence status is tracked in its report; operational acceptance remains blocked.
