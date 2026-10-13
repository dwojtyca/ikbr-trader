# Marketaux recovery and original diagnostics — implementation evidence

Date: 2026-10-13. Status: independently accepted implementation; all local checks pass; publication/CI pending.
Baseline: `3bbf8c756de717b20fd8832a98fd57f6f2a0a173`.
Contract: [accepted plan](MARKETAUX_RECOVERY_DIAGNOSTICS_PLAN.md).

## Problem and behavior

A failed news acquisition could lose the native error behind
`RESEARCH_MARKETAUX_ACQUISITION_FAILED`. Its negative snapshot then remained HOLD
indefinitely in on-demand mode. The observed historical request expired after
approximately ten seconds; its original message was not retained and cannot be
reconstructed from timing alone.

The HTTP acquisition boundary now preserves a separate bounded, sanitized original
name/code/message, HTTP status/status message and supported JSON provider error
code/message. Internal reasons remain machine-readable. Native deadline cancellation
is `RESEARCH_SOURCE_TIMEOUT` with the surfaced `AbortError / ABORT_ERR` retained.
A known HTTP status, including 401, survives timeout while reading its optional
error body. Bodies are bounded at 16 KiB and the existing request deadline;
unsupported bodies are not copied. Secrets, account identifiers, URLs and terminal
controls are sanitized before storage and again for operator display.

Strict optional `sourceError` diagnostics are carried by negative HTTP-backed
coverage, preparation responses and status/startup output. Existing WSH
`providerError`, absent legacy fields and canonical snapshot hashes are preserved.
WAITING reports include the original failure and next check time without repeating
unchanged details every five seconds. A lasting AGENTS rule applies the owner's
original-error requirement to future external error mapping.

Demanded transient Marketaux failures schedule a fresh natural news slot under
existing locks, immutable call identities and provider/account budgets. They do
not replay old UNKNOWN calls, refund costs, change historical snapshots or make
partial research eligible. Hard configuration, authorization, payload/identity and
permission failures remain holds. A tightly correlated legacy generic failure
can request fresh verification only with an original negative slot and an exact
matching UNKNOWN outcome recorded after its request deadline and before the
original snapshot publication; the old cause remains explicitly unavailable.

The change leaves strategy logic, evaluation cadence, WSH request policy,
proposal/AI/risk/execution gates and broker orders unchanged. Unrelated local
backtest work and signal-engine edits are excluded from publication and image.

## Independent review and routing

- Plan author/shared recovery implementation: `/root/session_design`, requested
  and actual `gpt-6-astra`, high reasoning.
- Independent plan reviewer: `/root/wsh_plan_review`, requested and actual
  `gpt-6-astra`, high reasoning. Accepted after one revision: strengthen legacy
  deadline/identity evidence and distinguish 10-second request from 120-second
  acquisition deadline. No escalation.
- Implementation repair-round count: unavailable (individual findings are listed
  below); model escalation count: 0.
- Lead implemented transport/operator display and coordinates validation/publication.
- Independent final reviewer: `/root/wsh_final_review`, requested and actual
  `gpt-6-astra`, high reasoning; final source ACCEPT after repairs. Repairs cover truthful
  HTTP-only originals, mixed-case encoded redaction, JSON excerpt omission,
  cross-slot pending/failed requests and durable failure supersession chronology.
- Mechanical checks run by capable lead; preferred `gpt-5.6-luna` is not available
  in the active agent tool. Per-agent tokens/elapsed telemetry: unavailable.

## Validation

Targeted transport tests use actual Node local HTTP sockets behind an injected
transport, never Marketaux or IBKR. They cover native cancellation, HTTP status
precedence, bounded envelopes, secret removal, truncated responses, DNS deadlines,
network/TLS distinctions, successful payloads and limits. Targeted startup/status
tests cover WAITING deduplication, original diagnostics and hard holds.

Targeted transport/Marketaux-wrapper/existing refresh: 26 passed; startup: 37
passed; status: 10 passed. Shared diagnostics/inspection: 10 passed; Marketaux
refresh: 20 passed. Isolated PostgreSQL recovery: 12 passed, including delayed restart, immutable
UNKNOWN and FAILED histories, pending deadline, exact legacy correlation, and
rejection of copied stale success. Final unit totals: 3474 tests, 3279 passed, 195 skipped (including isolated
PostgreSQL cases), zero failed. The initial full-suite attempt exposed a silent transport cancellation
regression; a queued abort fallback with explicit late-end fencing fixes it and
the actual Node and legacy dripper tests pass. Clean scoped Docker builds passed, including the final production source. The
final publication image will also include the completed evidence documents.

Full lint/typecheck passed with two pre-existing lint warnings. An unchanged
20 ms model-timeout test failed under concurrent Docker-build load and passed
16/16 in its focused suite; the full unit suite then passed without that load. Final integration: 2582 tests passed, zero failed or skipped, against isolated
PostgreSQL on port 55432. Final build passed. All five required commands exited 0.
Publication and exact-commit CI follow these local results.
No destructive fixtures run against the operational database.

## Publication and operational acceptance

At source-report publication: commit/push and exact-commit CI pending; runtime
deployment/recovery pending. These post-publication outcomes are recorded in the
final delivery and private deployment receipt without rewriting historical checks.
Current pre-change observation: broker reconciliation CLEAN, zero positions and
zero open orders; PKO repair rows HOLD from the generic news acquisition failure.
This is diagnostic evidence, not proof of current entry readiness or a trade.

Operational application uses the existing authorized continuous Paper scope and
supported `pnpm start` gates. No forced signal, manual audit repair, direct broker
submission, limit reset or bypassed resume is part of this package. Final exact
image/CI/deployment evidence will be recorded privately where it contains local
runtime details; no secrets or account IDs belong in this document.
