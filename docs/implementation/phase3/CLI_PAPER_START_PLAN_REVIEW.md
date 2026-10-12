# Explicit continuous Paper start — independent plan review

Date: 2026-10-12. Verdict: **ACCEPT** for the revised
[plan](CLI_PAPER_START_PLAN.md). This is design acceptance, not implementation,
deployment, provider-access or broker-readiness evidence.

Reviewer: independent `cli_start_plan_review` agent, requested/dispatched route
`gpt-6-astra` / `high`. Separate runtime model telemetry and token usage are
unavailable. One review cycle with bounded revisions; no escalation. Review
completed at 19:50 UTC; exact elapsed-time telemetry is unavailable.

## Evidence and resolved findings

Read AGENTS.md, ROADMAP, the continuous Paper runbook, routing guide, entry-control
store/routes, execution startup and resume/preparation wiring, research repair
store, ingestion bootstrap/control code, operator client and base Compose file.
No operational services, databases, broker endpoints or providers were contacted.
No secrets were read or emitted.

- **Existing producers during recovery:** the original unavailable-execution
  branch only prohibited starting producers. Durable control can already be
  resumed, and execution startup preserves its existing state. The revised plan
  stops and verifies signal-engine/llm-agent before bringing execution back, then
  positively verifies the new durable pause before restarting producers.
- **Exit supervision dependencies:** execution's session-deadline close obtains
  its quote from ingestion `/watchlist`. The revised stop contract retains both
  execution and ingestion when exposure is present or unknown.
- **Private configuration proof:** a benign shell environment does not prove the
  effective Compose configuration. The revised contract pins the full rendered
  configuration, image identity and mounted file contents; independently checks
  approved Paper/account/configuration flags and commands; rejects drift before
  startup; and never regenerates approval evidence in the CLI. Fixture rejection
  cases and secret-safe output handling are specified.
- **Stop availability during configuration drift:** proof validation applies to
  startup. Authenticated exact-account pause remains available after profile,
  image or file drift, with only fixed signal/LLM stop targets and no start/build/
  pull action on that degraded path.
- **Explicit preparation authority:** preparation requires the locked current
  paused revision and matching `paper-start:<UUID>` audit event; an ordinary
  pause alone is insufficient.

## Feasibility and implementation obligations

The existing account advisory/row locks and append-only control events support
CAS without a new intent framework. `ResearchStore.prepareRepair(identity, db)`
accepts the caller's transaction and preserves queue rollback, repair identities,
budgets and HOLD classifications. The existing resume gate already composes
configuration, research, lifecycle and accounting checks; it must remain intact.
The new preparation path must not reuse the entry permit that causes the paused
startup deadlock.

The specified hostile cases cover newer-pause precedence, concurrent starts,
unknown mutation outcomes, strict authorization/body validation and rollback.
Final implementation review must verify current connection/account identity
throughout preparation, exact readback reconciliation and no mutation retries
after ambiguous responses. Ingestion `/bootstrap` currently waits for backfill;
transport bounds/read-only progress resolution must accommodate that behavior
without treating an ordinary short HTTP timeout as completion.

Closed-market waits remain distinct from per-instrument entry eligibility. No
synthetic signals, source-rights renewals, accounting certificate changes or
provider-identity resets are authorized. Required tests, isolated integration
checks, clean Docker build, different independent implementation reviewer,
scoped publication and exact-commit CI remain delivery conditions.

## Narrow critical repair addendum review

Date: 2026-10-12. Verdict: **ACCEPT** for the plan's CLI critical repair
addendum. Same independent plan reviewer and requested route; the different
implementation reviewer remains responsible for final acceptance. Token usage
and exact elapsed-time telemetry remain unavailable. No additional plan revision
was required during this addendum review.

Reviewed only the identified startup/stop races, actual ingestion control and
progress response shapes, account-readiness ordering, transport bounds and the
associated proof-validation corrections. The three-file Compose packaging is
compatible with the existing full rendered-config/file proof contract.

The ignored generation marker is local cancellation intent and cannot establish
broker pause. An authenticated unconditional pause is the correct final fence:
when it wins the account lock first, pending resume fails its old revision; when
resume wins first, the later pause restores paused state. A delayed unknown
resume therefore requires that new pause even after a currently paused read.
The contract retains explicit uncertainty when that fence cannot be verified;
it does not retry an ambiguous mutation or claim that stopped producers prove
broker flatness. No new database intent framework is required.

The marker precedes stop's account/API work and is checked throughout cold start,
covering cancellation before broker account availability. Implementation must
exercise marker invalid/IO failures, cancellation after awaited reads and both
lock orderings, using distinct runtime instances rather than a shared in-memory
abort flag. The specified real ingestion origin, bounded long bootstrap request
and full health/progress validation match the existing ingestion interface.
Unknown mutation outcomes remain distinct from definitive gate denials.

The finite subprocess/error-body bounds, positive stopped-state parsing,
research-hash comparison and accounting-path proof checks are bounded repairs
to the accepted contract. No services, provider calls or broker operations were
performed for this review. Final hostile implementation review and the original
delivery checks remain mandatory.

## Narrow isolated integration fixture review

Date: 2026-10-12. Verdict: **ACCEPT** for the plan's isolated integration
fixture correction. Scope is only the named recurring-session test and its
failure diagnostics; production code, clocks, guards and skips remain unchanged.

Inspected `paper-recurring.pg-integration.test.ts`, `stockMetadataFixture` and
recurring budget session binding. The saved fixture interval runs from one hour
before fixture time to one hour after it. Binding with an end 15 minutes before
the saved end preserves the existing greater-than-one-hour assertion after the
exit margin. Shortening another 15 minutes genuinely tightens the cutoff;
restoring the saved end genuinely extends beyond the initially bound end, so the
unchanged-original-cutoff assertion still tests its intended protection.

All three revisions stay within the fixture's original interval. This removes
the unnecessary `Date.now()+2h` extension that the reported failure showed
crossing the Warsaw account day. It does not claim to redesign the shared
real-time fixture or remove all possible clock-boundary behavior from the suite.
The reported diagnostic reason is evidence supplied by the core implementer;
this plan review did not run a database or alter the fixture. Targeted and full
isolated integration reruns plus independent review of the actual test diff
remain required. No additional plan revision was needed.
