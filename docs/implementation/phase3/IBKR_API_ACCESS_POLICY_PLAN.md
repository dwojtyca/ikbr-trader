# IBKR API access and operator interface policy clarification

Date: 2026-10-27. Status: accepted documentation-only plan. Independent `api_policy_plan_review`
(Astra/high requested) accepted with no findings or repair rounds.

## Owner decision and scope

The owner clarified that the deferred work is creating an additional operator
interface because IBKR already provides one. This is not a blanket prohibition
on using or automating the existing IBKR interface. The bot should have access
to the capabilities IBKR exposes through its APIs.

Edit only `AGENTS.md`, this plan and `IBKR_API_ACCESS_POLICY_REPORT.md`. Read the
roadmap and current PP6 interface scope; preserve unrelated dirty research work.
No runtime, broker operation, settings, credentials, deployment or UI changes.

## Intended edits

- Date the clarification in Operator interface scope. Retain deferred custom UI,
  existing UI/security preservation and headless diagnostics.
- Remove the blanket IBKR UI automation prohibition in both interface text and
  Safety Rules. Prefer API access for bot integration; existing-interface use
  remains subject to the action's authorization and existing broker-write guards.
- Explicitly require access to all IBKR API capabilities available for the account,
  permissions/subscriptions and API/version in use. Name account/positions/orders,
  executions, market/history/contract data and order lifecycle as examples, not
  a restrictive allowlist. Access is an architectural requirement, not a false
  claim that every method is already implemented or entitled.
- Prefer fresh complete API evidence for facts it can establish instead of asking
  the owner to transcribe them. Missing adapters/coverage are implementation gaps,
  not policy bans; request operator evidence only where actually needed and explain
  the specific missing capability. Do not pretend a documentation edit supplies
  missing runtime evidence or changes a deployed recovery protocol.
- Preserve proposal/AI/risk/audit, permissions, Paper/Live separation, existing
  authorization, unknown-outcome holds, idempotency and service responsibilities.
  API access does not itself authorize an order or bypass those checks.

## Acceptance and validation

Independent critical plan review before editing AGENTS, then a different
independent critical document reviewer. Verify exact diff, local links and absence
of both obsolete blanket UI prohibitions; check API entitlement/support distinction
and unchanged broker-write guards. No local runtime suites or Docker build for
prose-only changes. Publish only these three files on main and verify exact-commit
CI. Report requested/actual reviewer routing and findings; unavailable telemetry
remains unavailable. Existing bot-start work and operational holds remain pending.
