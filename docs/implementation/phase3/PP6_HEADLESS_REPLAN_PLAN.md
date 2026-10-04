# PP6 headless operations — documentation change plan

Date: 2026-10-04. Status: accepted by independent Astra/high plan reviewer.
Baseline: `1269446b36e1c08ace572b985a0be535ae0ba0e6`, main.

## Owner decision and scope

Defer the custom web dashboard. The owner will use the IBKR desktop application
to inspect the account and perform discretionary manual broker operations. Bot
diagnostics must instead be readable and easy to analyze through logs/reports,
with existing alerts and authenticated non-browser controls. This change updates
the PP6/PP7 specification only; it does not implement PP6 or delete existing UI.

## Documents and changes

- AGENTS.md: record current headless delivery scope; keep existing service ownership,
  reviews, model tiers, required validation and operational guards intact.
- PAPER_PRODUCTION_DELIVERY_PLAN.md: replace PP6 UI work with concrete log/report,
  terminal operation and recovery requirements. Route PP6-A pure formatting/filtering
  to Luna medium, PP6-B instrumentation/read integration to Sol medium, and PP6-C
  event/privacy/safety/recovery contracts to Astra high. PP6-C contracts precede
  A/B; PP6-C integrated critical acceptance follows them. Keep the same stage IDs.
- ROADMAP.md and CURRENT_STATE.md: UI is deferred; readable headless diagnostics
  remain planned, not delivered. Preserve PP0–PP5 evidence and PP4 research plus
  broker-accounting readiness blockers.
- PRODUCTION_PAPER_ACCEPTANCE.md: replace any assumed dashboard dependency with
  log/report evidence and UI-off launch acceptance. Align pause guidance with the
  implemented PP5 runbook. Retain all supervised/soak/uncertainty gates.
- docs/README.md: navigation and inventory for this plan/report and revised PP6.
- PP6_HEADLESS_REPLAN_REPORT.md: review and local validation/publication evidence.

## Required headless acceptance to specify

1. Versioned structured events plus a Polish human-readable view derived from the
   same records. UTC timestamps with explicit local offsets in human output, stable
   event/reason codes, applicable instrument/instance/config/evaluation/proposal/
   lifecycle correlation, source age and masked account identity. Include clear
   reason, impact and safe next action without exposing secrets or raw prompts.
2. Observe the whole decision/order lifecycle, distinguish healthy/off-session/
   no-signal/rejected/paused/stale/unknown/error, and preserve gaps as unknown.
   Keep audit storage/broker facts authoritative; logs cannot authorize or prove
   flat state. Show research sources and decision evidence by recorded references.
3. Simple documented read-only terminal operations: live follow with filters,
   current per-instrument status, one-decision timeline, session summary and bounded
   redacted export. No bespoke SQL or mandatory jq, hosted logging service or new UI.
   Select actual command names in the later bounded implementation plan, never
   present future commands as shipped.
4. State transitions/critical faults must remain visible without tick-level noise.
   Summarize repeated noncritical states with counts/time ranges; preserve underlying
   audit and account for evaluation intervals. Specify bounded retention/rotation,
   restart/disconnection/truncation behavior, unavailable sinks and secret/control-
   character redaction. Reuse PP5 notifications and tested auth/control endpoints.
5. UI-off start/stop/runbook, supported pause/resume semantics, deployment identity,
   rollback and isolated restore drill remain required. No runtime/Compose edits
   in this documentation task; disabling UI in a deployed stack is future scope.
6. Manual IBKR intervention is an external event: entry pause does not stop PP5
   exit automation or cancel broker orders. Specify coordination/evidence before
   resuming, no adoption of arbitrary manual holdings, oversell, duplicate exit,
   forced hold clearing or retries of unknown writes. Unsupported reconciliation
   remains an explicit hold and separately scoped fix, never a fabricated pass.

## Review and validation

Obtain independent Astra/high plan acceptance, then a different independent
Astra/high final document review because scope includes operational safety contracts.
Validate local links/anchors and scope inventory, routing consistency, unchanged
PP0–PP5 requirements, preserved PP7 limits and outside-scope hashes. Inspect the
eight-file diff and staged scope; git diff --check must pass. No runtime suites
solely for prose. Delegate mechanical validation/publication to GPT-5.6 Luna low
when the lead has useful independent work. Commit/push only reviewed scope on main;
verify exact-commit CI and report it in final delivery. Do not mark PP6 implemented.

## Exclusions

No runtime changes, new strategy, UI deletion, dependency/Compose changes, broker
or notification calls, paid providers, manual trades, deployments or activation.
Preserve unrelated dirty ES/backtest/signal work, local drafts, secrets and historical
reports. The original PP0 UI security fixes stay delivered and are not undone.
