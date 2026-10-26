# Accounting recovery native inventory snapshot repair

Date: 2026-10-26. Status: ACCEPTED by independent `zero_start_final_review` (Astra/high)
before implementation. Baseline: deployed `4c46a70`; preserve unrelated research
work in the dirty main checkout.

## Problem and evidence

The authorized owner recovery prepared an operation, then its observer printed
the active-observation message and exited with
`ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE` before the operator restarted
TWS. Read-only status showed PREPARED, active maintenance and no handshake
dispatch. The lead reproduced the collector failure after three successful
read-only samples. Its stack resolves to
`accounting-owner-recovery-host.ts:278`: a process from the first global `ps`
snapshot was absent from the second argv snapshot and was not the exact first
inspection helper. Ordinary host process churn therefore breaks the global join.
The reproduced failure is not evidence of a competing broker client.

The current real-native tests filter actual output to collector/helper or owned
Compose processes. They establish helper identity behavior but omit unrelated
process churn and do not establish full-host inventory reliability.

Read the [owner recovery contract](PAPER_ACCOUNTING_OWNER_RECOVERY_CONTRACT.md),
[source runbook](../../runbooks/PAPER_ACCOUNTING_SOURCE.md),
[zero-start plan](PAPER_ACCOUNTING_ZERO_START_DEPLOYMENT_PLAN.md) and
[routing guide](MODEL_ROUTING_GUIDE.md). This is a bounded host witness repair;
it does not restart another roadmap phase or authorize trading.

## Accepted implementation boundary

Replace the two global process-list commands with one bounded macOS `/bin/ps`
invocation containing PID, PPID, start time, command and complete final argv.
Every returned row is still classified; no arbitrary PID, process name or
unmatched row may be ignored. Do not retry an inconsistent inventory until a
passing sample is found. Keep native endpoint socket checks, repeated inventory
checks, Docker event continuity, exact one-shot ancestry/argv/hashes, observer
deadlines and cancellation behavior unchanged.

macOS non-final `comm` defaults to a truncated 16-character field even with
`-ww`. Therefore an ordinary named header and whitespace splitting are not an
acceptable repair. Use the following single command contract:

- `/bin/ps -ww -axo` with format
  `pid=PID,ppid=PPID,lstart=START,comm=<1024 ASCII C characters>,args=ARGS`.
- Retain the existing clean C locale, UTC, 5-second command deadline and 2 MiB
  combined output cap. Do not use `-E`, which exposes environment values.
- Require the exact expected header shape. Derive the command and argv byte
  boundaries from the exact command header and final `ARGS` marker, requiring
  a 1024-byte command field and a single field separator. Parse the metadata
  prefix strictly as PID/PPID/start; do not split either command or argv on
  whitespace. Validate layout rather than assuming locally observed offsets.
- Reject absent/malformed/duplicated headers, missing rows, duplicate/nonpositive
  PIDs, invalid PPIDs/dates, short rows, separator misalignment, control-character
  or byte-boundary ambiguity, missing collector, empty command/argv, saturated
  command fields and any output/inspection failure. Errors remain fail closed.
- Strip only command-field padding. Preserve interior spaces and the full final
  argv, including its trailing content; argv candidate classification must see
  every byte that the existing full-argv view exposed. Do not truncate argv to
  fit a parser or log it during errors.
- Preserve the existing assurance of `ps comm`: it is the displayed command,
  not new kernel executable attestation. Apple obtains it from argv[0]. A padded
  field is not a proof against an adversarial oversized argv[0] ending in spaces.
  Complete final argv remains mandatory and unchanged candidate classification
  examines it. A protected Docker/Compose exemption still requires exact full
  expected argv, command, ancestry, start identity and executable hash; padding
  must never grant an exemption. The existing bounded trusted-operator topology
  assumption remains explicit; do not claim atomic kernel inventory or detection
  of hidden native clients between samples.
- Remove only the obsolete two-snapshot helper-disappearance accommodation.
  Ordinary inspection children remain subject to existing exact helper rules;
  a sibling process using a helper name or recovery argument is not exempt.

The framing was verified by a read-only live probe on this host: 871 unfiltered
rows, 1,082,566 output bytes, command offset 41 and argv offset 1066, no saturated
command fields. A controlled temporary `/bin/sleep` symlink with a 169-character
path containing spaces retained its exact path and arguments. Only counts and
booleans were printed; no raw process arguments were persisted. The fixture was
terminated and removed. These observations qualify the proposed layout, not
recovery readiness or arbitrary macOS versions.

Primary implementation evidence: Apple's
[ps printing implementation](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c)
and [field sizing](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/ps.c)
show fixed-width non-final fields and unlimited final output with `-ww`; the
[keyword definitions](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/keyword.c)
define the default command width. Installed behavior was checked separately.

## File scope and task packets

Critical implementation: `gpt-6-astra`, high. Allowed code changes are
`tools/paper-verify-stack/src/accounting-owner-recovery-host.ts` and the adjacent
host, CLI and Docker tests. Update relevant wording in the owner recovery
contract/source runbook and zero-start deployment plan/report only as needed to
document this framing and the deployment amendment below. Add the package report
in this phase3 directory. No shared schema, backend/store/migration, broker
transport, strategy, environment settings or research changes.

The worker must inspect current source/tests and this accepted plan before work.
Return changed files, targeted command results and unresolved risks. Escalate
before expanding file scope, changing accepted inventory/identity semantics or
weakening a denial to pass an operational sample. No broker calls, recovery
mutations, application starts or operational DB writes belong to implementation.

Use a separate `gpt-6-astra` high agent for plan review and a different independent
`gpt-6-astra` high agent for final hostile review. Neither reviewer may review its
own implementation. A mechanical `gpt-5.6-luna` low worker may run specified
checks and reviewed publication; it may not change source to fix failures.

## Acceptance and validation

1. Unit fixtures use exactly one global ps invocation, with strict command/header
   assertions. Spaced/long paths and arguments survive exactly. All native
   candidate patterns and unexpected API socket PIDs still reject.
2. Malformed/header/width/boundary/control/output-limit fixtures reject. Include
   command saturation, fake marker strings in argv, oversized argv[0], trailing
   spaces, duplicate PIDs and missing owned identities. A large or ambiguous
   command never gains a Docker/Compose or helper exemption.
3. Existing one-shot hostile cases remain: sibling spoofs, unknown descendants,
   wrong parent, wrong argv, early/reused process identities and changed hashes.
   Docker lifecycle/watcher failure remains fatal.
4. An observer test injects inventory failure during the first stop poll after
   the active message. It must cancel the backend and watcher, issue no
   reset-proof/finalize/handshake and preserve the failed outcome. Do not silently
   restart observation after that failure.
5. A real macOS test parses unfiltered global process output and exercises a
   controlled unrelated short-lived process workload. No fixture may filter out
   unrelated rows. Keep raw argv in memory and report only sanitized counts and
   outcomes. Test spaced/long executable paths using temporary harmless fixtures.
   Existing real Compose test must still prove exact owned-process binding.
   Genuine unknown native candidates or unavailable evidence remain failures;
   the test cannot allowlist them just to pass.
6. Run focused host/CLI/Docker tests and existing research-host regressions, then
   `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` against
   isolated PostgreSQL and `pnpm build`. No strategy/backtest semantics change.
   Build the deployable image from a clean exact source commit and complete the
   required clean Docker build. Never use operational DB fixture destruction.
7. Final report records review findings/repairs, requested and actual models and
   effort, elapsed time, available token usage (otherwise unavailable), commands,
   exit codes, exact source SHA/image and exact-commit GitHub CI URL/conclusion.
   Stage only reviewed package files, commit/push main and verify CI before
   claiming implementation complete.

## Deployment amendment and retained pending operation

The prior operation remains PREPARED with maintenance active after its observer
has exited. Confirm this by read-only exact status and confirm no observer or
backend remains active before replacing the deployment. An inert pending record
is distinct from an ongoing live observation; it must not be deleted or cleared
to satisfy the earlier zero-start prerequisite wording.

After reviewed source, checks and exact CI, prepare the new pinned clean image
with all application containers stopped/never-started and master writes disabled.
Preserve the original owner, maintenance, durable pause and all safety counters.
Do not replace containers while a collector/backend is alive. Verify immutable
image/configuration identities and stopped inventory again after replacement.

The old operation is bound to its old profile and its local begin-observe record
prevents continued observation. Fresh operator evidence and the existing
supported `supersede` flow are required to create a replacement operation bound
to the new image/deployment. The current store permits this for the same account,
endpoint and exact owner while retaining maintenance; no store or wire change is
needed. Unknown supersession outcome requires exact status lookup, never retry.
Only the new live observer may witness a new full manual TWS stop/replacement
and its single handshake. No old reset evidence is reusable.

This amendment prepares the authorized recovery safely; it is not permission to
automate TWS, start trading, repeat a broker handshake or reset unrelated holds.
Operational supersession/observation remains subject to the owner's existing
explicit scope, fresh evidence and all runbook gates. If that evidence is absent,
leave maintenance active and report the exact remaining operator action.
