# Accounting recovery restart inventory repair report

Date: 2026-10-26. Status: implementation and independent hostile review accepted;
full local validation passed. Publication, exact-commit CI and deployment remain
pending. Baseline `125f473`. Follow the
[accepted plan](PAPER_ACCOUNTING_RESTART_INVENTORY_REPAIR_PLAN.md).

## Result and evidence limits

Native inventory now derives its listener PID and all endpoint owners from one
complete socket view, eliminating the comparison against an earlier null
listener result during TWS startup. A strict process/file/address/TCP-state parser
rejects incomplete or ambiguous evidence. Nonempty sockets without a listener,
multiple listeners, extra endpoint owners and non-TWS listener identities remain
denied. Existing complete process inventory, exact Compose binding, observed
old/stop/new TWS replacement, Docker continuity and operation fences remain.

Fixed local diagnostic phase/reason values distinguish socket, process and
identity failures while preserving public codes and sanitized external cause
details. CLI output contains only the fixed local diagnostic, without raw argv,
socket addresses, account data or evidence.

The original operational refusal was before afterReset/handshake and retained
PREPARED/maintenance. The pure fixture established the stale-null source defect;
there was no retained original stack identifying its branch, and later read-only
preflight passed. The actual cause of that operational incident remains
unconfirmed. This implementation is not evidence of successful recovery.

## Review and bounded amendment

Independent `restart_inventory_plan_review` (requested Astra/high) accepted the
original plan without repairs. During implementation, the controlled nonbroker
fixture found the installed lsof emitted queue fields when `-Ts` preceded
`-FpfnT`. Implementation stopped for the prescribed escalation. An owned
ephemeral listener/client probe proved `-FpfnT -Ts` produces state-only fields;
the same independent reviewer accepted that option-order amendment before its
implementation. Strict rejection of queue/unrecognized fields was preserved.

Different independent final reviewer `native_inventory_final_review` (requested
Astra/high) accepted the five source/test files with no blocking findings; its
focused run passed 65 tests with five explicit opt-in skips. Documentation scope
and links were accepted, with a request to fill in final validation results before
publication. No code repair was requested by this reviewer.

## Targeted validation performed by implementer

| Command or evidence | Result |
| --- | --- |
| `pnpm --filter @ikbr/paper-verify-stack typecheck` | Exit 0 |
| `pnpm --filter @ikbr/paper-verify-stack exec node --import tsx --test src/accounting-owner-recovery-host.test.ts src/accounting-owner-recovery-cli.test.ts src/accounting-owner-recovery-docker.test.ts src/accounting-owner-recovery-watcher.test.ts src/research-recovery-host.test.ts` | Exit 0; 70 tests, 65 pass, 5 opt-in skips |
| `OWNER_RECOVERY_NATIVE_TEST=1 node --import tsx --test tools/paper-verify-stack/src/accounting-owner-recovery-host.test.ts` | Exit 0; 24 pass, zero skips; about 3.04 seconds |
| Controlled state-only option-order probes, owned OS-assigned loopback port | Exit 0, empty stderr; listener and established client/server file records validated; all fixture sockets closed |

The direct native run includes both the existing complete global process churn
fixture with a spaced executable path and the new separate-process listener/client
fixture. The latter verifies all endpoint-owner PIDs, then proves the parent
client is denied as an unexpected owner before any process exemption. No broker
endpoint is inspected by these fixtures. The global process fixture now verifies
the harmless sleep path/argv directly in its complete ps view; it no longer
injects a sleep PID into the removed caller-supplied TWS parameter.

The first native invocation in the sandbox failed because native inspection and
socket creation were unavailable. An approved unrestricted invocation exposed
the option-order issue above. Its pnpm wrapper also matched the existing native
producer classifier; running the documented direct Node fixture succeeded with
no classifier exemption. These failed checks were not counted as passes.

Maintained synthetic cases cover both sides of the startup window through the
actual host API, one socket command per inventory, extra clients including absent
later processes, no-listener TCP states, both address/state orders, supported
bindings, duplicate listeners/FDs/PIDs, malformed/missing fields, byte bounds,
unknown products, missing identity, hash failure and sanitized diagnostics.
CLI replacement-wait refusal cancels the backend/watcher, emits no afterReset,
sends no reset-proof/finalize, preserves maintenance and refuses observer reuse.

## Lead validation and operational boundary

A clean archive of baseline `125f473` plus only the nine reviewed files, Node
24.4.1 and frozen pnpm 9.5.0, passed full `pnpm lint`, `pnpm typecheck`, `pnpm test`
and `pnpm build` (exit 0). Full tests used workspace concurrency 1 without changing
assertions/timeouts. The initial sandbox run was denied loopback listen permission;
the approved run passed. Dependency installation likewise required approved network
access after the sandbox could not resolve the registry.

All three real isolated Docker/Compose fixtures passed (zero skips, exit 0,
6.408 seconds) with the existing `OWNER_RECOVERY_TEST_IMAGE=ikbr-owner-recovery:125f473`
override. The first attempt found the default Node image unavailable and did not
start fixtures. The override changed no source or fixture assertions; owned
fixtures were cleaned up. The clean no-cache candidate Docker build passed with
image `sha256:25d21f4d9aaff741c714cee351474a693b15bc69a7e27cb288bcae235a23036b`.

The compiled candidate's read-only native inventory and TWS process/listener
preflight passed against the current host; it opened no broker socket. A private
operational backup passed pg_restore list validation. Full `pnpm test:integration` exited 0 against the dedicated isolated PostgreSQL
container and `ikbr_trader_ci` database; operational data was not used for fixtures.
Publication, exact-commit CI and actual deployment remain pending. No strategy/simulator behavior changed, so no
new backtest acceptance is required. Unrelated dirty research work was preserved
and is outside the publication scope.

No operational mutation, broker/provider call, observer retry, supersession,
TWS UI action or application-container start was performed by this implementation
worker. Pending maintenance, owner, entry pause, counters and evidence remain
untouched. Deployment/continuation follows the plan and existing runbook gates;
the interrupted observer cannot be resumed.

## Routing and effort

- Plan author/critical implementer requested: `gpt-6-astra`, high; actual runtime
  model/effort telemetry unavailable.
- Independent plan reviewer requested: `gpt-6-astra`, high; actual telemetry
  unavailable. Original acceptance plus one accepted option-order amendment.
- Independent final reviewer requested: `gpt-6-astra`, high; actual model/effort
  telemetry unavailable. Code accepted without repairs; final report evidence
  update requested. Lead owns mechanical validation/publication.
- Implementation repair/escalation count: one contract amendment for observed
  lsof behavior; no guard relaxation. Native sandbox/wrapper failures are listed
  separately above.
- End-to-end elapsed time and token usage: unavailable; targeted command timings
  are reported only where emitted by the runner. No savings estimate is claimed.
