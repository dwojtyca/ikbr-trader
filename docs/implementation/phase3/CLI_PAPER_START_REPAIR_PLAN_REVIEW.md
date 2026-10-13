# Continuous Paper startup repair — independent plan review

Date: 2026-10-13. Verdict: **ACCEPT**.

Reviewed [the repair plan](CLI_PAPER_START_REPAIR_PLAN.md), repository instructions,
roadmap/routing policy, CLI validation and startup flow, shared configuration
loader/admission, signal bootstrap and execution configuration diagnostics.

The defect is confirmed in source: CLI validation requires a nonblank
`TRADING_LOOP_INSTRUMENT_IDS`; the shared bundle loader rejects that variable.
The existing test fixture uses an invalid `{}` bundle and invented hash, so it
cannot establish compatibility with the services. Loading the proof-covered
bundle through the existing loader for every rendered service and deriving scope
from `entryEnabled` corrects the authority mismatch without weakening admission.

The plan adequately bounds the repair. Final review must verify:

- Private strategy reads use only the validated fixed mapping and existing
  proof/path protections; loader errors cannot disclose file contents or secrets.
- The old conflicting profile fails before service/HTTP mutations, the corrected
  profile passes actual built service config imports, and canonical hash mismatch,
  every service's conflicting authority, disabled rows and empty scope are covered.
- The diagnostic addition allows only local `GET /execution/configuration`, emits
  fixed known codes with bounded output, and cannot authorize preparation/resume.
  Malformed/unavailable diagnostics retain generic waiting and cancellation checks.
- Startup pause/revision ownership, stop supersession, unknown-outcome handling
  and supported resume gates remain intact. Private rollout preserves authorized
  strategy, research, accounting, risk, budget and expiry contents.

No broker/provider operations or implementation edits were performed in this
review. Full checks, clean Docker build, separate hostile implementation review,
scoped publication and exact-commit CI remain required as planned. Operational
success must be reported separately from test success.

Requested/actual reviewer route: `gpt-6-astra`, high. Blocking findings: none.
Repair/escalation count: 0. Token telemetry unavailable; elapsed approximately
3 minutes.

## Validation amendment review — 08:40Z

Verdict: **ACCEPT**. The current `listenOnDefaultPorts` uses `Promise.all`, so a
single rejected bind discards references to successful listeners and the caller's
empty fallback cannot close them. Awaiting every outcome, closing every fulfilled
listener before rethrowing a bind failure, and retaining the existing successful
return and test assertions is a bounded test-resource repair. It changes neither
production behavior nor host-port compatibility assertions.

Verify partial occupancy terminates naturally with no leaked test-owned listener,
and full host tests complete. Do not close pre-existing listeners or stop services.
The updated clean build and separate final implementation review remain required;
unchanged production integration evidence remains applicable. No blocking finding.
Same reviewer route; amendment review approximately 1 minute, token data unavailable.
