# IBKR API access policy clarification report

Date: 2026-10-27. Status: documentation and independent final review accepted; local validation
passed. Publication/exact-commit CI pending.

The owner's clarification is recorded in [AGENTS.md](../../../AGENTS.md): defer
building an additional operator interface, retain the existing IBKR interface,
and require bot access to all IBKR API capabilities available for its account,
permissions/subscriptions and API version. Both blanket UI-automation prohibitions
were removed. Existing-interface automation remains within task authorization;
broker writes retain their proposal/AI/risk, audited order-management/close and
idempotency controls. Paper/Live restrictions and service boundaries remain.

Fresh complete account-scoped API evidence is preferred over manual transcription.
Missing adapters or coverage are implementation gaps, not API-access policy bans.
The document does not claim all APIs are implemented or that existing recovery
protocols can be bypassed. No runtime/configuration, broker, UI, deployment or
operational-state changes are included. The bot-start task remains unresolved.

Scope: AGENTS.md, the [plan](IBKR_API_ACCESS_POLICY_PLAN.md) and this report only.
Unrelated dirty work is excluded. Local validation passed: exact diff, relative links, removal of obsolete
prohibitions and retention of existing write guards.
No runtime suites or Docker builds are needed for this prose-only change.
Publication is on main; exact-commit CI must be verified separately.

Plan author/editor: lead. Independent plan reviewer `api_policy_plan_review`,
requested `gpt-6-astra`/high, ACCEPT without findings, zero repair/escalation rounds.
Different final reviewer `api_policy_final_review`, requested Astra/high, accepted
without findings, repairs or escalations; links/anchors and scoped diff passed.
Actual model/effort telemetry, elapsed
attribution and token usage are unavailable. Mechanical publication/checks are
lead-owned; the legacy gpt-5.6-luna route is not available in this session.
