# Model routing documentation change plan

Date: 2026-09-28. Status: accepted by independent plan reviewer on 2026-09-28.

## Objective and scope

Assign implementation models and reasoning levels to the existing PP0–PP7 plan.
Reduce avoidable token use while making code quality, working mechanisms and all
existing acceptance gates mandatory. Expand Luna beyond mechanical work to bounded
implementation tasks. This change updates instructions and documentation only;
it does not start PP implementation, change runtime models or authorize trading.

Baseline: `61f492c6dc55e61f662050c6e1dc41c62104e11f`. Work on main. The only
pre-existing AGENTS.md diff is the owner's routine-delegation section, directly in
this requested scope; incorporate its mechanical-worker preference into the revised
policy. Preserve all unrelated application edits and unpublished ES/operator drafts.
Record outside-scope file hashes and the pre-edit AGENTS.md outside the repository.

## Deliverables

1. Replace AGENTS.md's mechanical-only delegation policy with risk-based routing:
   `gpt-5.6-luna` low for existing mechanical duties, `gpt-6-luna` medium for bounded
   implementation, `gpt-6-sol` medium for coordinated noncritical integration, and
   `gpt-6-astra` high for critical semantics, architecture and hostile safety review.
   State exact IDs, independent review and escalation requirements. Keep existing
   implementation/check/publication/operational-authorization rules unchanged.
2. Add MODEL_ROUTING_GUIDE.md: eligibility checklist, concise task packet, model
   selection/fallback, promotion criteria, review independence, context budgeting,
   small-task batching and measurable pilot evaluation. Never promise numerical
   savings or use missing usage telemetry as zero. Models here are coding agents,
   not the bot's trading-decision model.
3. Add a normative task-to-model matrix inside PAPER_PRODUCTION_DELIVERY_PLAN.md,
   splitting every PP package into bounded parts. Assign implementation and review
   roles, reasoning effort, dependency/contract gates and critical exclusions.
   Do not allocate whole packages to Luna solely because a plan exists. Risk,
   authorization, identity/hash/migration, broker uncertainty, ownership and
   concurrent reservations remain with Astra; Luna can implement isolated pure
   mapping/display/schema details after reviewed semantic contracts exist.
4. Link routing from ROADMAP.md and docs/README.md; update the inventory for these
   three new model-routing documents. Do not rewrite historical reports.
5. Add MODEL_ROUTING_REPORT.md documenting independent reviews, local verification,
   preservation and publication evidence; exact final commit/CI may be reported in
   the delivery message to avoid a self-referential commit.

## Quality and token controls to specify

- One bounded task per work unit, with explicit files/ownership, permitted actions,
  accepted contract, failure invariants, acceptance tests and stop conditions.
- Promote immediately on newly discovered safety semantics or unclear contracts.
  Cap unsuccessful repair cycles; no extended low-model guessing or weakening tests.
- Independent plan and implementation reviewers are different agents; the final
  reviewer did not author the implementation. Critical changes always receive Astra
  review. A different agent with the same model is independent; a new prompt in the
  implementing agent is not. Batch a small coherent package review when appropriate.
- Keep full repository checks at existing required delivery boundaries; targeted
  development checks do not replace them. Never save tokens by dropping validation.
- Use minimal task context with required AGENTS/plan/contracts, source pointers and
  focused failure output. Avoid duplicated full audits, full-history forks and
  overlapping writers; independent review still inspects code and dependencies.
- Pilot bounded Luna implementation on PP1 schema work after contract acceptance,
  respecting PP0 before operational use. Evaluate accepted output including rework,
  review effort, tokens if available and elapsed time; retain or raise the route.
- No runtime automation/router, paid benchmarking, new provider, operational
  activation, model availability guarantee or arbitrary cost percentage.

## Acceptance and validation

An independent reviewer accepts this plan before substantive edits. A different
reviewer accepts the final documents, checks matrix coverage, unsafe assignments,
policy contradictions, escalation, preserved safety gates and the diff. All PP0–PP7
requirements remain intact and receive a model route, including integration/tests
and broker acceptance judgment. Required reviews cannot be self-approved.

Validate local links/anchors, inventory inclusion, exact model IDs, task IDs and
matrix references; compare outside-scope hashes and retained PP acceptance text;
run git diff --check and inspect only the explicit seven-file staged scope. No
runtime suites rerun locally for prose. Commit/push the reviewed scope on main and
verify GitHub CI for that exact commit, reporting any access limitation accurately.
