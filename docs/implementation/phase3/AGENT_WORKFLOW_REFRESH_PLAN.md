# Agent instructions refresh

Documentation-only scope, requested by the owner after the PKO preflight.

Update AGENTS.md to reflect the owner's main/commit/push/CI workflow, independent
plan approval then a different implementation reviewer, bounded delivery scope,
and preserving unrelated work. Replace stale Phase1 guidance with current checks.
Document the PKO supervised-paper scope and the distinction between implemented
code and broker-verified readiness. Link the runbook and current preflight report.

Clarify that existing authorization covers scoped operational work without repeated
permission requests; distinguish read-only preparation, explicit trading activation,
and operator-requested closes. A close need not have a new strategy entry signal,
but must use a supported audited close workflow with deterministic risk checks.
Unsupported legacy positions remain a capability gap, not a reason to bypass guards
or claim that editing instructions alone implements closing them. Keep no unknown
retries, no reversal, no live orders and no IBKR UI automation. Owner will close SMR
manually; this change does not authorize or perform its close.

Correct stale architecture labels and avoid duplicated strategy activation lists;
the registry/profile/configuration files remain authoritative. Do not edit runtime
code, .env, unrelated research files or trading state.

Validation: independent plan and document reviews, local diff/link checks, explicit
documentation-only diff verification, commit/push on main and full GitHub CI. No
new tests or repeated runtime tests are warranted by prose-only changes.
