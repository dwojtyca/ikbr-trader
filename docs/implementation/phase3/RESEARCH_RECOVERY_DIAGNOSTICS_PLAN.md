# Research recovery: preserve actionable failure diagnostics

Date: 2026-10-27. Status: accepted by independent `wsh_diagnostics_plan_review`
(`gpt-6-astra`/`high`) after one clarification on mutation/readback diagnostics.
Implementation and independent hostile review are accepted; full validation and
publication evidence are tracked in the package report. Baseline:
`863abcad76c35fe86dedf78e3a6c9450b5a4e28b`.

## Outcome and evidence

The owner wants the existing continuous Paper bot running and the actual blockers
diagnosed. Follow the [roadmap](../ROADMAP.md), the existing
[recovery contract](PAPER_STARTUP_RESEARCH_RECOVERY_CONTRACT.md) and
[runbook](../../runbooks/PAPER_STARTUP_RESEARCH_RECOVERY.md). This package makes
recovery failures actionable without changing which recovery evidence is accepted.
It does not by itself establish research coverage or authorize trading.

On 2026-10-27 the WSH observer confirmed disappearance of the previous TWS process
and listener, then failed with a generic message after the owner relaunched TWS.
Its local challenge file contains no observation evidence or commit operation.
The host CLI and backend CLI both discard the underlying failure details.
At 16:28:31.825Z a separate read-only call to the unchanged production host
collector successfully identified the current TWS process, its start time and
expected executable hash. It performed no broker connection.

The historical failure cause is **unknown**. Replacement inspection, a transient
native-command failure, handshake/account readiness, socket cleanup, identity
revalidation and final evidence validation are distinct possible boundaries.
Neither a timeout nor premature handshake has been established as the cause.
The observer retries only the existing not-started/still-running conditions;
other errors terminate it. Reconnect evidence is returned in memory and becomes
durable only through the ordinary successful evidence save/commit. A generic
failure cannot establish that the handshake was never attempted or that it closed.

## Scope and immutable behavior

Change diagnostic capture, serialization, validation and presentation only.
Preserve all success results, command arguments, exit success/failure behavior,
request sizes, deadlines, timeouts, clock checks, retries and operation ordering.
Do not add another handshake, automatically repeat a restart or retry an unknown
mutation. Do not add readiness sleeps, extend observation/challenge expiry or
accept a process inspection race as success.

The following remain unchanged:

- Exact account/configuration/manifest/process identity and durable pause checks.
- Independent producer inventory, actual full process/listener absence and
  replacement, endpoint/client identity, account handshake and socket-close proof.
- Challenge hashes, nonce, predecessor set, receipt verification, operation IDs,
  transaction boundaries and exact readback after uncertain mutations.
- Database schema, migrations, saved challenge/evidence/receipt schemas and their
  canonical hashes. Diagnostic metadata is never recovery evidence or authority.
- Master writes disabled and durable entries paused during deployment/recovery;
  normal proposal, AI, risk, audit, budgets and guarded startup afterward.

No provider acquisition, paid API call, broker order, strategy change, UI feature,
accounting qualification change, direct database repair or unrelated research work
is part of this package. Preserve all pre-existing dirty files.

## Files and responsibilities

Allowed implementation files:

- `tools/paper-verify-stack/src/research-recovery-cli.ts` and its focused tests:
  host stages, subprocess failure decoding and terminal diagnostics.
- `apps/llm-agent/src/research-recovery-cli.ts` and its focused tests:
  backend stages and failure serialization.
- A narrowly scoped recovery diagnostic codec/helper and tests under
  `packages/shared/src/instrument-research/`, plus its existing export entry,
  only to share the same bounded wire contract between those two callers.
- `tools/paper-verify-stack/src/research-recovery-host.ts` and focused tests only
  if necessary to preserve the already captured native-command cause without
  changing inspection semantics or command execution.
- The startup recovery runbook, this plan and
  `RESEARCH_RECOVERY_DIAGNOSTICS_REPORT.md` in this directory.

Reuse existing diagnostic sanitizers and research-source error handling. Do not
broaden shared sanitization semantics or introduce a general logging framework.
Transport/store production behavior stays out of scope. If actionable original
information has already been destroyed there, report it as unavailable and return
the precise limitation to the lead before expanding scope.

## Diagnostic contract

Keep backend success JSON unchanged. Failure retains `ok: false` and the existing
generic top-level `reason`, with an additive bounded `diagnostic` object:

```text
version: 1
stage: one fixed stage from the applicable allowlist below
reason: recognized internal recovery code, otherwise RESEARCH_RECOVERY_FAILED_OR_UNKNOWN
original: { name: string|null, code: string|safe-integer|null, message: string|null }
```

Exact keys only. Limit names and string codes to 100 characters, messages to
1000 characters, internal reason to 100 characters, and the serialized diagnostic
to 4096 bytes. Reject invalid types, extra keys, unknown versions/stages,
oversize/control-bearing wire fields and nonfinite numbers. A malformed or
unavailable diagnostic produces a fixed generic failure with unavailable original
details; it never changes the command outcome or makes raw output printable.
The existing total subprocess response bound remains authoritative.

Host stage allowlist: `profile`, `challenge-read`, `producer-inventory`,
`gateway-before`, `gateway-stop`, `gateway-replacement`, `profile-recheck`,
`reconnect`, `producer-recheck`, `host-identity`, `evidence-parse`, `state-load`,
`state-save`, `prepare`, `supersede`, `commit`, `commit-readback`, `status`,
`subprocess` and `arguments`.
Backend stage allowlist: `request`, `configuration`, `preflight`, `challenge`,
`prepare`, `supersede`, `read`, `receipt`, `commit`, `reconnect-connect`,
`reconnect-close`, `reconnect-validate` and `reconnect-postflight`.
Stage assignment describes the operation actually failing; it must not claim an
operation completed. Backend diagnostics retain their backend stage when decoded
by the host. Local subprocess failure uses `subprocess`; missing child detail
remains unavailable. A host failure after successful reconnect uses the actual
later stage, not a fabricated reconnect failure.

Capture the original sanitized name/code/message from existing `sourceError`,
the original `Error` or an existing captured `cause` record as applicable. Keep
internal reason separate: an internal `RESEARCH_*` message is not invented
provider evidence. Preserve unavailable fields as null and present them in Polish
as unavailable. Use bounded cycle-safe cause traversal; do not stringify unknown
objects or invoke untrusted getters/toString. Do not lose an original connection
failure when cleanup also fails; keep the primary failure and its stage. A
cleanup-only failure must be identified as cleanup. This is error reporting,
not a change to the existing finally/cleanup control flow.

Sanitize before serialization and defensively again before terminal presentation.
Use configured account IDs explicitly, including nonnumeric IDs, and configured
secret values available to each boundary. Cover raw and percent-encoded forms,
Bearer values, database/credential URLs and provider tokens; redact whole URLs
where necessary. Do not read or print environment/configuration dumps to construct
diagnostics. No raw stderr/stdout, stack, request body, provider payload, secret,
account log or account identity may appear in diagnostic output. Preserve
subprocess exit/timeout information only as bounded original facts when available.

The host terminal retains its Polish hold/unknown-outcome guidance and adds the
sanitized stage, internal reason and available original tuple. Mutation failures
that are resolved by exact successful readback remain successes. If readback
cannot prove success, the unknown-outcome classification remains authoritative;
a diagnostic must not turn it into a safely retryable operation. Existing generic
child failures without an additive diagnostic remain understandable and fail
closed for compatibility; no raw fallback is allowed.

For prepare, supersede and commit followed by unsuccessful exact readback, retain
the first mutation failure diagnostic preferentially, including its actual stage,
internal reason and original tuple. Use the later readback diagnostic only when
no earlier failure diagnostic exists. This applies both when readback throws and
when it returns null or a mismatched result. The top-level outcome remains
`RESEARCH_RECOVERY_FAILED_OR_UNKNOWN` with the existing unknown/hold/no-retry
guidance. Do not add secondary diagnostic wire fields or treat the first failure
as proof that no mutation occurred.

## Acceptance and hostile tests

1. Inject failures at the distinct host and backend phases. Verify actual stage,
   internal reason and sanitized original fields survive backend serialization,
   host validation and final presentation, not merely a pure helper unit test.
2. Exercise existing `sourceError`, native Error, captured plain cause record,
   nested/cyclic causes and absent details. Unknown objects/getters are not
   evaluated; missing originals remain unavailable. Primary connection failure
   survives a secondary cleanup failure; cleanup-only failure has its own stage.
3. Test configured nonnumeric account IDs, secrets in every tuple field, encoded
   secret variants, Bearer data, credential URLs, control characters, long strings
   and hostile raw provider payloads. Assert no sensitive value or raw stack/output
   leaks. Verify privacy context at the real caller boundaries.
4. Reject malformed, oversized, extra-key, unknown-version/stage and wrong-type
   child failure diagnostics. Child nonzero exit, spawn error, timeout, missing
   JSON and truncated JSON produce bounded failures without raw output. Valid old
   generic failure output remains supported; success output is unchanged.
5. Assert unchanged action sequences and counts: read/status never handshake;
   failed reconnect is attempted at most once; unknown cleanup retains the hold;
   replacement still requires independently observed absence; no saved successful
   evidence after failure; no extra restart, acquisition, commit or resume.
6. Retain hostile identity/account/configuration/manifest/pause/process fencing,
   producer replacement and clock/expiry tests. Lost commit acknowledgement still
   uses exact readback, and unresolved outcomes never repeat the mutation.
   Exercise first mutation failure followed by throwing, null and mismatched
   readback: retain that first diagnostic and preserve unknown outcome. Successful
   exact readback remains success and does not surface a terminal failure.
7. Tests use fixtures and isolated PostgreSQL only, with no operational broker or
   paid provider calls. Existing integration tests establish unchanged recovery
   persistence/hold behavior; no destructive fixtures on the operational database.

## Delivery, review and validation

This is critical recovery/privacy integration. Use `gpt-6-astra` with `high`
reasoning for semantics/integration and independent plan review. A different
independent `gpt-6-astra`/`high` agent performs the final hostile implementation
review; neither reviewer approves its own authored changes. Implementation starts
only after accepted plan review. Any guard, retry, timeout, persistence or privacy
scope change returns to the lead for revised plan and independent acceptance.

Run focused tests during development. Final required checks are `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration` against isolated PostgreSQL,
`pnpm build`, and a clean Docker build of the reviewed source. No backtest is
required because strategy/simulator behavior is unchanged. Validate documentation
links and the exact staged diff. Report commands, exit codes, review findings,
requested/actual model and effort, repairs/escalations, elapsed time and available
token usage; unavailable telemetry is unavailable, not zero.

Commit/push only reviewed scope on `main` and verify successful GitHub CI for that
exact commit. Preserve unrelated research work. Passing diagnostics tests or CI
does not mean the historical WSH failure is explained or the bot is ready.

## Operational continuation after publication

Use the authorized disabled-write deployment protocol and a verified backup.
Signal the verified execution application Node process directly rather than the
pnpm wrapper, and verify durable accounting-owner retirement before recreation;
follow the preceding [identity package](RESEARCH_RECOVERY_PROCESS_IDENTITY_PLAN.md).
Pin the reviewed image and refresh/validate the private deployment proof.

Read the existing recovery state before choosing the next action. The failed
observer has no durable reconnect receipt or saved successful observation, so
neither commit nor fabricated/reconstructed evidence is justified. Supported
`supersede` can replace a PREPARED challenge with current authority and fresh
producer-quiescence evidence while preserving the hold and historical rows.
Execution deployment also changes the bound process identity, requiring a fresh
challenge through that protocol.

After supersession, a new observation must witness a new full TWS process/listener
disappearance and replacement before its single handshake. This fresh recovery
does not reuse the uncertain handshake or erase its uncertainty. Do not
automatically restart or repeat it on failure: capture the new precise diagnostic
and resolve that specific limitation first. A successful recovery still requires
ordinary fresh research, accounting qualification/clock/capture gates and normal
guarded startup. Keep operational outcomes separate from code-package completion.
