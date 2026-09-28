# Paper production documentation reconciliation plan

Date: 2026-09-26. Status: accepted by independent plan reviewer on 2026-09-26.

## Owner outcome and scope

Reconcile all versioned documentation under `docs/` with the audited implementation
and provide an actionable delivery plan for production-style operation on IBKR
Paper. Initial configured instruments are PKO and AAPL. Strategy implementations,
parameterized strategy configurations and instrument definitions are separate:
each instrument selects one or more previously defined strategy configurations.
Adding a supported instrument or another configuration of an existing strategy
must not require ticker-specific source edits. New asset classes still require
verified entry, risk, accounting, research and exit capabilities.

This change is documentation only. It does not implement the proposed configuration
format, enable Paper/Live, deploy, call paid providers or send broker orders.
The full Paper target includes automated lifecycle supervision, recovery,
observability and an operational soak; one supervised round trip is an intermediate
gate, not completion of the owner's goal.

## Baseline and preservation

- Audited HEAD: `6cbd2c7ee9d4b9d15537441ffd9ffc714f1d306f`.
- Inventory every versioned Markdown/JSON document under `docs/` and classify it
  as current reference, historical evidence, frozen research artifact or local draft.
- Preserve the text of historical implementation plans/reports and frozen JSON
  artifacts. Add a dated historical-status notice and links to current authority;
  do not rewrite old observations as present facts or alter original verdicts.
- Rewrite current navigation/runtime guidance where obsolete claims affect use.
  Retained original architecture specifications must be explicitly identified as
  historical after the current production-wiring section.
- Pre-existing tracked docs edits within the requested documentation scope are
  reviewed as part of the final diff. Preserve their historical research content.
  Pre-existing untracked ES/operator drafts remain unchanged and unpublished;
  list them as local/unverified in the inventory, not as shipped dependencies.
- Preserve all files outside `docs/`, including dirty `AGENTS.md`, application
  sources and `.env`. Baseline hashes are stored outside the repository.

## Deliverables

1. `docs/README.md`: navigation, authority order, implementation versus operational
   evidence, and an inventory covering every document in scope.
2. `docs/implementation/CURRENT_STATE.md`: code-backed capability/gap matrix,
   service ownership, audit/CI evidence and dated deployment observations. Include
   configuration, strategy selection, AI coverage, entry/close restrictions,
   completed-order recovery limits, UI/control-plane security and ES deferral.
3. Updated `docs/implementation/ROADMAP.md`: the owner's new delivery priority,
   dependency-ordered bounded work packages and final production-Paper acceptance;
   retain the long-term phase map without restarting unrelated ES work.
4. Detailed `phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md`: separately reviewable
   implementation stages with code touchpoints, dependencies, migrations,
   failure cases, acceptance, validation, rollback and broker/provider gates.
5. `docs/architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md`: proposed versioned
   configuration contract with separate strategy instances and instrument
   references, parameter validation, explicit selection/conflict rules,
   configuration hashes, rollout compatibility and position ownership across
   changes. Clearly label examples as not currently loadable.
6. `docs/architecture/INSTRUMENT_RESEARCH_CONTEXT.md`: source identity, company
   reports/earnings and asset-specific ETF context, cached immutable snapshots,
   point-in-time evidence, required/optional coverage, AI audit and time budgets.
7. Current architecture and phase2 operational references: describe actual bound
   flow, mandatory persisted AI, execution risk recheck, session readiness and
   lifecycle. Historical specs retain detail with explicit temporal scope.
8. Runbooks: distinguish current single-profile supervised commands from the
   planned automated configurable bot. Mark the old entry-only procedure as
   historical; avoid runnable examples for unimplemented endpoints/settings.
   Add a production-Paper acceptance/runbook specification with gate/checklist,
   escalation, shutdown and recovery criteria, without implying current support.
9. `phase3/PAPER_PRODUCTION_DOCUMENTATION_REPORT.md`: review outcomes, local
   documentation checks, preservation evidence and exact delivery/CI evidence.

## Required design decisions in the delivery plan

- Start with two stock definitions and one configured existing long strategy;
  support reusable named parameter sets and per-instrument references from day one.
  Define enabled versus assigned state, no implicit evaluation of unrelated
  strategies, deterministic conflict resolution and separate runtime state per
  instrument/strategy instance, retaining account-wide safety limits.
- Preserve initial whole-share and account-wide entry restrictions until an
  explicit reviewed stage introduces quantity/partial-fill support and a bounded
  repeated-entry policy. Production-style Paper must not stop at one lifetime
  entry attempt or require manual run-once/close reconciliation for normal operation.
- Retain service boundaries, proposal identity/idempotency, deterministic risk,
  AI adjudication and unknown-submission holds. Generic broker session/market-rule
  handling cannot infer venue from currency. No new production strategy.
- Research must be prepared outside the AI claim deadline, bound to exact issuer/
  listing and persisted with publication, report-period and observation times.
  No source availability or provider entitlement is assumed. Missing mandatory
  evidence blocks new entries without blocking supported risk-reducing exits.
- Authenticate operational mutations and UI proxy delegation; default host
  exposure to loopback; retain documented master-write semantics until changed.
- Automated protection/exit supervision, crash/reconnect recovery, durable
  ownership, alerts, isolated tests and real Paper evidence precede unattended
  acceptance. Paper/Live share business logic; Live readiness stays separate.

## Acceptance and validation

- Every tracked document appears in the inventory; every historical report has
  a visible dated scope notice. Frozen JSON files are byte-for-byte unchanged.
- Current guidance contains no claim that AI is unintegrated, consumers have not
  migrated, completed orders are universally absent, or generic instruments/ETF
  fundamentals/automatic close supervision already work.
- Current status links directly to source and dated implementation evidence.
  Local audit results are distinguished from historical exact-commit CI and from
  operational readiness. No secrets/account identifiers enter docs.
- Examples enforce referential integrity between strategy instances and
  instruments. A new supported ticker absent from production source is an explicit
  future acceptance test; unsupported classes fail validation before runtime.
- Detailed stages provide observable completion/failure gates, including a
  proposed bounded multi-session unattended Paper soak and no fabricated signals.
- Independent plan review must accept before substantive document edits. A
  different independent reviewer checks the final documentation and staged scope;
  findings are corrected until accepted.
- Validate local Markdown targets/anchors and inventory, parse JSON examples,
  run `git diff --check`, inspect the staged diff and compare preservation hashes.
  No runtime test rerun is required solely for prose. Commit/push reviewed docs on
  `main`; verify GitHub CI for the exact commit. Never blanket-stage the dirty tree.

## Out of scope

Runtime implementation, new strategies, ES replay/tuning, broker/UI automation,
changing operational settings, unapproved research calls, trading activation or
Live readiness certification. Future implementation stages require their own
bounded plan/review/check/report cycle under `AGENTS.md`.
