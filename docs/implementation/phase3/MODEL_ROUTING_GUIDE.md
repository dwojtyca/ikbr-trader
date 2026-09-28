# Coding-agent model routing

Date: 2026-09-28. Status: delivery workflow policy; runtime PP implementation remains
planned. [AGENTS.md](../../../AGENTS.md) owns repository rules; the
[delivery matrix](PAPER_PRODUCTION_DELIVERY_PLAN.md#31-model-assignments) assigns
concrete work. These settings select agents writing/reviewing the repository. They
do not select the llm-agent's trading-decision model or alter any trading gate.

## Models and roles

| Route | Exact model | Reasoning | Responsibility |
| --- | --- | --- | --- |
| M | `gpt-5.6-luna` | `low` | Run specified checks; publish reviewed scope; monitor exact CI |
| L | `gpt-6-luna` | `medium` | Implement bounded pure components under accepted semantics |
| S | `gpt-6-sol` | `medium` | Integrate known contracts; ordinary noncritical debugging |
| A | `gpt-6-astra` | `high` | Architecture, critical semantics/integration and failure diagnosis |
| RS | `gpt-6-sol` | `high` | Independent review of a noncritical bounded delivery |
| RA | `gpt-6-astra` | `high` | Independent critical/mixed plan and hostile implementation review |

M preserves the owner's existing mechanical-worker preference. L expands delegation
to real implementation. Low reasoning is not the default for new code. A model
and its reasoning effort are independent settings; "Astra Light" is not a model
identifier available in this session. Record exact IDs instead of ambiguous names.

This is a project policy to evaluate, not a measured guarantee of performance or
savings. Official guidance describes Luna low for small scoped changes and Luna
medium for work from clear briefs, and recommends testing the lightest setting that
meets the quality bar. [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection)
(consulted 2026-09-28). Availability in the active tool/model selector, not API
documentation alone, determines what can actually be dispatched.

## Eligibility and critical boundaries

Choose L only when all are true:

- One bounded component or coherent set of edits has a reviewed contract and named
  file ownership. Necessary repository context is identified and can be inspected.
- Inputs, outputs, units, errors and default values are decided. The worker does
  not need to invent cross-service behavior or decide which missing facts permit entry.
- Acceptance includes externally meaningful behavior and applicable invalid cases;
  tests can run without operational DBs, broker writes or paid provider calls.
- Implementation does not decide security, risk, ownership, persistent identity,
  money/quantity semantics or recovery from unknown external outcomes.
- Any helper on a critical path has A-authored semantics, rejection rules and test
  obligations, with RA review at integration. Pure schema code is not automatically
  harmless: changing units/defaults/references or accepting an unsupported capability
  crosses this boundary.

S can wire accepted contracts across modules, implement noncritical persistence and
read models, diagnose ordinary failures and integrate fixtures. It must promote
new semantics or a critical invariant to A. File count is only a scope signal;
one line can affect authorization or allow duplicate orders.

A owns auth/secret trust boundaries, fresh entry/close risk, eligibility, broker
identity/session/grid rules, submission/idempotency, atomic attempt budgets,
ownership/close/reconciliation, canonical hashes and compatibility migrations.
A also owns research identity/time/unit eligibility, fail-closed required coverage,
AI claim/deadline and decision binding, and operational go/no-go. Pure extraction,
formatting and transport may be split out only behind those accepted contracts.
No route may change strategy thresholds to produce a trade or AI approval.

## Task packet and evidence

The lead fills this compact packet in the bounded implementation plan or delegation
message; link documents instead of copying the whole delivery plan into every task.

```text
Task ID / parent PP / baseline commit and relevant dirty files:
Goal / explicit non-goals:
Implementation route + exact model/effort / reviewer route:
Accepted plan + contract sections / prerequisite task evidence:
Owned files / other files allowed for read-only context:
Inputs, outputs, units, defaults, errors / invariants that must hold:
Acceptance cases + validation commands / isolated test prerequisites:
Permitted actions (code/tests only unless explicitly authorized otherwise):
Stop/escalation conditions / permitted repair limit:
Return: diff summary, commands/results, open issues, model/effort and usage if exposed.
```

The worker must inspect relevant callers and existing helpers. Missing context
means fetch the cited source or report the gap, never guess from an abbreviated
prompt. Do not pass secrets, broad raw logs, unrelated audits or full chat history.
Use fresh agents with targeted context for model overrides. Independent reviewers
receive the plan, full relevant diff, source access and test evidence, not just an
implementer's summary. Reuse a bounded worker for related repairs to avoid repeatedly
loading context; use a different agent for review.

Implementation and review agents may author tests within scope. M only runs supplied
commands; its failure output goes to the lead. Report focused errors and log paths,
not complete successful suite output. Never print credentials from environment files.

## Review and escalation

1. Lead classifies/splits the scope and chooses the route before delegation. The
   independent plan reviewer is RS for a wholly noncritical task, RA otherwise.
2. After accepted plan review, the implementation worker performs the bounded task
   and targeted checks. The lead integrates disjoint work in dependency order.
3. A different independent implementation reviewer checks the actual integrated
   change against acceptance and hostile cases. Neither reviewer may approve its
   own edits; if a reviewer becomes an implementer, replace it for final acceptance.
4. The final review can cover multiple helper tasks once, at the highest route
   required by the combined change. This satisfies task-level review obligations;
   it does not require an additional agent per table row. Separate delivery commits
   each keep the repository's required review/check/report gates.
5. Full repository checks, relevant backtests/Docker builds and exact-commit CI
   remain required for code/config delivery. Targeted checks during development
   save repeated work; they do not substitute for those final checks. No new local
   runtime suites solely for documentation, as already specified by AGENTS.md.

Escalate immediately for ambiguous or changing contracts, any newly discovered
critical invariant, unexpected migration/concurrency/identity effect, or a proposal
to relax a guard/test. Stop the affected task, preserve the diff and report the
smallest reproduction plus missing decision. A updates the plan and obtains a
new independent review for material scope changes before implementation continues.

For an ordinary noncritical failure, allow one focused repair attempt after the
initial failure, with a stated cause and targeted check. If that attempt fails for
the same problem, L returns to the lead for S; S returns for A. Do not restart the
repair allowance by renaming the task, restarting an agent or changing the model's
prompt. A diagnoses the cause; further work requires a concrete correction plan,
not endless retries. No route gains permission to retry an unknown broker write,
change acceptance, spend on providers or activate trading through promotion.

If the preferred model is unavailable, report requested versus actual model and
effort. M can use an available Luna at low effort, then S/lead; L can use S or A;
S can use A. RA requires an available capable Astra reviewer (raise effort within
that model if needed). If that is unavailable, keep critical acceptance pending
and state the limitation; do not substitute a weaker self-review. These are
conservative fallback choices, not claims of a strict universal model ranking.

## Token discipline and measurement

Delegate when parallel progress or a substantial bounded implementation offsets
handoff overhead. Batch related tiny tasks; do not split every function into an
agent. Keep shared contract edits sequential, assign disjoint writers, and avoid
multiple agents independently re-auditing all services. Respect dependency gates
even when spare agent slots are available. Do not create tasks merely to consume
those slots or leave the lead idle beside a mechanical worker.

Add a compact record to each package implementation report:

| Task | Requested / actual model and effort | Acceptance | Repair / promotion count | Review findings | Tokens and elapsed time |
| --- | --- | --- | --- | --- | --- |
| Example only | L / actual ID and setting from dispatch | PASS / pending with evidence | Actual counts | Severity + resolved/open | Measured, or unavailable |

Include implementer, lead integration, reviewers and rework in totals when telemetry
supports attribution. Distinguish wall time from summed agent time and input/output/
cached/reasoning tokens when available. Never infer per-task tokens from account
rate-limit percentages, missing telemetry or a model's name. Record unavailable
fields explicitly; do not build a telemetry service or buy API benchmarks for this.
Compare work of similar scope; a smaller token count is not an improvement if
acceptance fails or review/rework grows. No target percentage or quota of Luna tasks.

## First implementation pilot

Use PP1-B (pure configuration schema/diagnostics) as the first L implementation,
after PP1-A supplies reviewed field/default/unit/reference and rejection semantics.
This requires its own bounded accepted implementation plan; this policy does not
start it. Complete PP0 before operational use as the roadmap requires. Use fixtures
only, disabled entries, no broker/provider calls, and include a third fixture stock
absent from production source. Do not add rollout/identity migrations to the pilot.

RA reviews the integrated PP1 critical path; RS suffices only if PP1-B is delivered
as an isolated noncritical artifact under the already accepted contract. Existing
full code-delivery checks still apply. Continue L for similar tasks only after
acceptance. A critical finding, repeated repair/escalation or excessive context
reconstruction raises the next comparable task to S/A and tightens its contract.
Do not drop testing/review to make the pilot appear economical. Report observed
results before claiming a saving; reassess routing at the end of each PP package.
