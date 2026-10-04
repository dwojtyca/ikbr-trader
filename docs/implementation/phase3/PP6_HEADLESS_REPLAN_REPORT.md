# PP6 headless scope revision report

Date: 2026-10-04. Documentation/instructions only; PP6 runtime remains unimplemented.
Baseline: `1269446b36e1c08ace572b985a0be535ae0ba0e6`.
[Accepted change plan](PP6_HEADLESS_REPLAN_PLAN.md).

## Scope and rationale

The owner deferred a custom UI on condition that bot logs be readable and easy to
analyze. PP6 now requires Polish readable output from structured events, stable
correlation, simple filtered live follow/status/timelines/session summaries and
redacted export. Existing diagnostic requirements remain: configuration/strategy,
quote entitlement/type/age, research/AI/risk evidence, broker legs/protection/close,
holds and currency/fee completeness. Critical events and coverage gaps stay visible.

PP6-A routes pure presentation to Luna medium, PP6-B instrumentation/read integration
to Sol medium, and PP6-C safety/privacy/control/recovery contracts and integrated
acceptance to Astra high. Contracts precede helpers. Separate independent review and
all code-delivery checks still apply to later implementation.

PP6/PP7 no longer require running the existing UI service. Its source and PP0
security fixes are retained. Headless operations reuse PP5 alerts/controls and keep
deployment identity, bounded retention, backup/restore and broker reconciliation.
Owner-operated IBKR trades remain external; pausing entries is not a takeover of
automatic exits. Unsupported recovery/quantity/ownership remains a visible hold.

The source spot check found existing service loggers (including llm-agent JSON and
Fastify logging), PP5 supervision/control endpoints and current manual-intervention
guidance. This is a reusable baseline, not proof of the new unified user-facing
log/report contract. PP4 real-source and certified broker-accounting blockers remain.

## Review, preservation and validation

Independent Astra/high plan review accepted on 2026-10-04. A different independent
Astra/high document reviewer accepted the final scope with no blocking findings.
It verified retained diagnostic coverage, planned-versus-shipped distinctions,
model routing, PP5 semantics, manual intervention and unchanged prior acceptance.
The preservation baseline covers 791 files outside the explicit eight-file scope.
Existing application edits, unpublished drafts and all PP0–PP5 reports are excluded.

Local validation passed: eight scoped files, 263 local file/anchor links, 22 model
task rows and zero issues. All 791 preservation hashes match. PP0–PP5 requirement
text is byte-identical; PP7/common-check text is unchanged except its explicit
UI-off diagnostic preflight addition. AGENTS.md changes only the operator-interface
scope and pure-presentation routing wording. Whitespace and credential-pattern
checks passed. Final publication rechecks the exact eight-file staged scope.

Both reviewers were explicitly dispatched as `gpt-6-astra` / `high`; mechanical
validation/publication uses `gpt-5.6-luna` / `low`. Lead authorship inherited the
session model. No review-driven repair or model escalation was needed. Per-agent
token/time totals are unavailable; no token savings are claimed.

No runtime/config/Compose changes, UI deletion, new dependency, operational deployment,
broker operation, paid provider call or real notification occurred. Examples are
synthetic proposed presentation, not shipped commands or observed trading evidence.
No unchanged local runtime suites are run for prose; exact-commit CI is checked
after scoped publication and recorded in the final delivery message.
