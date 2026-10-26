# Accounting recovery restart inventory repair

Date: 2026-10-26. Status: ACCEPTED by independent `restart_inventory_plan_review`
(Astra/high), zero initial repair rounds. The same independent reviewer accepted the
option-order amendment below before implementation (one escalated amendment). Baseline: published/deployed `125f473`.
Preserve unrelated research work in the dirty main checkout.

## Problem, evidence and limits

The current recovery observer confirmed that the owner had fully stopped TWS,
then exited with `ACCOUNTING_OWNER_RECOVERY_PRODUCERS_NOT_QUIESCENT` while the
owner reopened it, before printing `afterReset`. Exact read-only status retained
PREPARED and its preparation event, without handshake dispatch. Private incident
records retain identifiers; no account or operation identifiers belong here.
No original failure stack or branch-specific diagnostic was retained. A later
read-only preflight passed. Therefore the precise incident cause is unconfirmed;
neither a passing later sample nor the error alone proves absence/presence of a
competing client at the failure time.

Source inspection identifies a reproducible failure mechanism. The host's
`inspectProducers` and `inspectNative` pass a PID from a listener-only `lsof` to
`inspectAccountingNative`. That function runs process and hash inspection, then
a second endpoint-wide `lsof`. If the first sample is empty and TWS starts
listening before the second, every positive socket PID differs from the captured
null and is rejected. The lead's pure injected fixture reproduced refusal for
null and success for PID 202 against the same legitimate TWS socket. This proves
the source defect, not retrospective attribution of the real incident.

CLI polling checks inventory before replacement observation and outside the
catch for `GATEWAY_NOT_STARTED`; the failure terminates the witness correctly.
The repair removes the inconsistent comparison, not that fail-closed behavior.

Read [AGENTS.md](../../../AGENTS.md), [roadmap](../ROADMAP.md),
[owner recovery contract](PAPER_ACCOUNTING_OWNER_RECOVERY_CONTRACT.md),
[source runbook](../../runbooks/PAPER_ACCOUNTING_SOURCE.md),
[native inventory repair](PAPER_ACCOUNTING_NATIVE_INVENTORY_REPAIR_PLAN.md),
[event watcher repair](PAPER_ACCOUNTING_EVENT_WATCHER_REPAIR_PLAN.md), and
[model routing](MODEL_ROUTING_GUIDE.md). This is a bounded repair to the current
accounting recovery delivery, not a new trading phase.

## Selected design and invariant boundary

Use one complete endpoint socket sample per native inventory invocation to
derive both its listener identity and all endpoint-connected process identities.
Do not compare endpoint owners against a PID obtained by an earlier independent
listener command. Do not retry conflicting samples or catch a quiescence failure
as a pending gateway state.

1. At the start of native inspection collect one bounded macOS command:
   `/usr/sbin/lsof -nP -iTCP:<configured-port> -FpfnT -Ts`. No LISTEN filter:
   established, connecting and other endpoint sockets must remain visible.
   Existing clean environment, 5-second deadline, 2 MiB combined output bound,
   stderr rejection and nonzero-exit handling remain. Only exit 1 with exactly
   empty stdout/stderr represents no sockets. An empty successful response is
   not silently substituted for that outcome.
2. Parse strict process/file sets from that response: positive safe PID, numeric
   descriptor, exactly one nonempty address `n` and exactly one `TST=<state>` per
   file. Permit either order of name/state within a file; reject duplicate,
   missing, unrecognized, malformed or truncated fields and incomplete sets.
   Reject duplicate process/file identities, empty process groups, controls and
   missing final newline. Non-LISTEN state names must be bounded uppercase
   letters/digits/underscore, never ignored because unfamiliar. Missing state is
   unavailable evidence. The installed macOS `lsof` manual documents `-Ts` and
   `TST=`; validate actual output using isolated harmless sockets before accepting
   the implementation. If actual framing differs, return to plan review rather
   than permissively swallowing fields.
3. A listener is a file whose state is exactly LISTEN, with address exactly one
   of `*:<port>`, `127.0.0.1:<port>` or `[::1]:<port>`. Preserve the current single
   listener-file requirement, including rejection of two listeners owned by one
   PID. Unsupported listener address, multiple listener files/PIDs or ambiguous
   listener shape keeps `ACCOUNTING_OWNER_RECOVERY_LISTENER_AMBIGUOUS`. A complete
   empty endpoint view has no listener. Nonempty endpoint sockets with no listener
   deny quiescence; they do not permit the observer to wait past an unknown client.
4. Every endpoint socket must belong to that same unique listener PID. Any other
   positive PID denies with the existing `PRODUCERS_NOT_QUIESCENT` public code,
   including collector, own Compose helper, unknown client, client with innocent
   argv, connecting client, or a short-lived client present in this sample.
   No name, ancestry or launch exception exempts an endpoint-connected process.
   Same-TWS non-listener sockets retain the existing PID ownership behavior;
   do not change the supported topology or infer broker authorization from it.
5. Collect the existing complete single `ps` view after the endpoint view. Keep
   its strict framing, full argv classification, process start identities,
   executable/argv hashes, collector and exact Compose launch checks. The
   derived listener PID must exist in this view and have the same TWS-specific
   executable path shape already required by `observeProcess`, including path
   traversal rejection. Reuse/factor that predicate locally rather than creating
   a different product allowlist. A non-TWS listener is `RESET_UNPROVEN`; absent
   required process/hash evidence remains `INVENTORY_UNAVAILABLE`. Only that
   validated TWS PID receives the existing native-candidate exemption. No new
   executable/name/PID exemption is allowed.
6. Remove the stale `twsPid` input from the local native-inspection API and update
   its callers/tests. Preserve its returned shared inventory shape. The collector
   and TWS identities are still hashes of the current inspected process view.
   A socket absent in the sample but present later is considered by the existing
   subsequent reset/inventory checks; this does not certify its later absence.
   A sampled listener missing from later process evidence denies without retry.
7. Keep reset-phase listener commands and full old/stop/new process checks. These
   separate observations serve reset evidence, not classification of the socket
   sample. Preserve old-process absence, distinct/newer PID/start, start after
   observed stop, executable digest, repeated listener identity checks and
   afterReset binding. No evidence or pending operation becomes reusable.

One `lsof` invocation is a complete bounded view, not an atomic kernel snapshot.
The existing trusted-operator no-other-client/no-launch attestation and repeated
snapshots remain essential. This change does not prove detection of hidden
native clients between samples or authorize continuing through an observed
unknown client. Docker event continuity remains unchanged.

### Installed lsof option-order amendment

The first controlled nonbroker fixture found that `-Ts -FpfnT` on this installed
macOS lsof emits `TST=LISTEN`, `TQR=0` and `TQS=0`: selecting the field set after
state-only reporting enables additional TCP fields. The strict parser correctly
refused this output. A second temporary, owned loopback-listener probe using
`-FpfnT -Ts` emitted only PID, descriptor, address and `TST=LISTEN`, with exit 0
and empty stderr. Neither probe contacted the broker or inspected its endpoint.

Adopt only that option ordering correction. Keep rejection of extra/unrecognized
fields, including queue fields; no parser relaxation, repeat-until-success or
producer exemption is permitted. Amend fixture exact-argument assertions too.
This is one escalated plan amendment, accepted by independent
`restart_inventory_plan_review` before changing runtime command order. The incident's actual cause remains unconfirmed.

## Diagnostic contract

Preserve existing public failure codes and add fixed, sanitized local reasons
for the relevant inventory branches. Use the existing error-with-cause mechanism,
with namespace `AccountingNativeInventory:<phase>` and a finite reason allowlist
covering socket command/shape, no listener with sockets, unexpected endpoint
owner, ambiguous listener, non-TWS listener, missing listener process and native
producer candidate. Phases are fixed `socket`, `process` or `identity`, never
derived from external text. Tests pin each emitted reason.

CLI formatting may recognize this namespace alongside the existing watcher
diagnostic without changing wire schemas or public codes. Preserve first failure
through cancellation/cleanup. If wrapping an external error, preserve its
sanitized original name/code/message as diagnostic cause; unavailable fields
stay null. Fixed local reasons must not fabricate original external details or
replace a known cause. Reuse `safeDiagnosticText` at that boundary. Do not emit
raw argv, command output, process path, endpoint addresses, account data, tokens,
evidence or event JSON. No raw stack dump is required.

## Bounded task packets and permitted files

Plan/critical implementation route: `gpt-6-astra`, high. Independent plan review:
another `gpt-6-astra`, high. Final hostile implementation review: a different
independent `gpt-6-astra`, high, who did not implement the change or review its own
work. Specified mechanical checks/publication use `gpt-5.6-luna`, low if available;
otherwise disclose an available equal-or-stronger fallback. No local coding model
handles these critical semantics.

Implementation may change only:

- `tools/paper-verify-stack/src/accounting-owner-recovery-host.ts`;
- `tools/paper-verify-stack/src/accounting-owner-recovery-cli.ts` for diagnostics;
- adjacent `accounting-owner-recovery-host.test.ts`,
  `accounting-owner-recovery-cli.test.ts`, and
  `accounting-owner-recovery-docker.test.ts`;
- this plan, `PAPER_ACCOUNTING_RESTART_INVENTORY_REPAIR_REPORT.md`, and directly
  relevant wording in `PAPER_ACCOUNTING_OWNER_RECOVERY_CONTRACT.md` and
  `docs/runbooks/PAPER_ACCOUNTING_SOURCE.md`.

No shared schema, backend/store/migration, broker transport, settings, dependency,
application startup, strategy, research or watcher-semantics changes. Workers
read current source/contracts, implement only after plan acceptance, and return
changed files, commands/exit codes, acceptance evidence and unresolved risks.
Stop and escalate any need to change these semantics, accept unsupported output,
widen scope, weaken a denial or contact a broker. Development uses synthetic
identities/fake commands and disposable local test infrastructure only. Do not
run an observer, supersede an operation, start application containers, alter an
operational DB or automate TWS as a test.

## Acceptance and validation

1. Turn the lead's null-versus-202 reproduction into maintained host integration
   fixtures using actual `createAccountingRecoveryHost` inventory methods. A
   completed stop followed by legitimate TWS startup succeeds with one endpoint
   socket command per inventory invocation and no stale listener call. Test
   empty view then startup before ps, and listener present at socket sampling.
   Neither case may dispatch a handshake before full replacement/operator proof.
2. Inject unrelated clients alongside TWS and without TWS; include innocent argv,
   matching collector/Compose PIDs, different PID with same executable name,
   client appearing after a previously empty inventory, connecting/closing
   sockets and a client represented in the sample but absent from later ps.
   Every sampled unexpected endpoint owner must deny, never be omitted because
   the later process disappeared. Assert no retry of failed inventory.
3. Reject two listeners/same-PID duplicate listeners, malformed/missing/duplicate
   state/address/file/PID fields, unexpected fields, unsupported binding, partial
   final record, control bytes, oversized output, stderr, command failure, missing
   listener process, non-TWS product and failed hash inspection. Positive fixtures
   include supported IPv4/IPv6/wildcard listener addresses and both field orders.
4. Retain existing reset/PID reuse/old process survival/executable-change tests;
   exact Compose identity/argv/ancestry and all native producer pattern tests;
   watcher loss and Docker start-stop rejection; clock/deadline/freshness checks.
   The coherent socket view alone cannot satisfy reset or eligibility evidence.
5. CLI fault injection during the replacement wait must cancel backend/watcher,
   preserve the original bounded diagnostic, print no afterReset, send no
   reset-proof/finalize and keep the outcome failed. Existing durable operation
   tests retain maintenance/owner/entry pause. Safe diagnostics tests include
   secret-like external text and verify no raw output or token leakage.
6. On macOS, validate the selected command's real unfiltered output with a
   disposable nonbroker loopback listener and connecting client on an OS-assigned
   port. Assert parser identifies its listener and all endpoint owners, then
   rejects an unexpected owner. Use temporary owned processes; never the broker
   endpoint, and always clean up in finally. This parser test is not permission
   to accept the non-TWS fixture as recovery evidence. Existing complete global
   process and exact Compose integration tests remain required.
7. Focused command: `pnpm --filter @ikbr/paper-verify-stack exec node --import tsx
   --test src/accounting-owner-recovery-host.test.ts
   src/accounting-owner-recovery-cli.test.ts
   src/accounting-owner-recovery-docker.test.ts src/research-recovery-host.test.ts`.
   Confirm required platform/Docker fixture gates actually run; report skips.
   Then run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`
   against isolated PostgreSQL, and `pnpm build`. Never destructive fixtures on
   operational PostgreSQL. No strategy/simulator change means no new backtest
   acceptance requirement. A clean deployable Docker image build is required.
8. Independent final review accepts completeness and hostile cases before scoped
   publication. Review the staged diff, commit/push only this package on main,
   verify GitHub CI for the exact source commit, and record the image digest.
   Report requested/actual models/effort, repair/escalation count, review findings,
   elapsed time, available tokens (otherwise unavailable), commands/exit codes,
   commit/image, and exact CI URL/conclusion. Source completion is not operational
   recovery success.

## Deployment and pending recovery

Do not retry the interrupted observer. Preserve maintenance, stranded owner,
pause, counters and evidence. Confirm exact status and observer/backend absence
before any authorized replacement deployment. Keep apps stopped/never-started
and master writes disabled, build/deploy a reviewed clean pinned image, and
recheck all deployment identities and stopped inventory. Never replace containers
during live observation.

A changed profile requires fresh actual operator evidence and the supported
`supersede` flow for the same exact owner/endpoint. Unknown supersession outcome
requires exact request readback, never retry. A new authorized observation must
witness a new full manual stop/replacement; old reset evidence cannot be resumed.
Owner actions and broker handshake remain separate operational steps under the
existing authorization and all runbook gates. No live activation, application
restart, automatic UI operation or clearing unrelated holds is included here.
