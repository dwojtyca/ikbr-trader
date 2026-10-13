# WSH cancellation and original error diagnostics

Date: 2026-10-13. Status: ACCEPTED by independent `wsh_plan_review`
(requested gpt-6-astra/high). No blocking findings. Implementation must fence
startup initialization and bound-review handoff after shutdown, and await cleanup
from both acquisition failure and finally paths.

## Owner scope

Cancel owned WSH metadata/event requests when the bot stops, when acquisition
fails/times out, and during catchable process failure. Carry an AbortSignal from
process shutdown through acquisition. Preserve the provider error code and message
and display them underneath calendar failure in startup/status diagnostics.
Explain accounting clock validation; do not change accounting thresholds or risk.
This package does not activate trading, reset holds, retry broker/model submissions,
change research eligibility, or touch unrelated dirty ES/signal-engine work.

## Implementation contract

1. Use installed @stoqey/ib 1.6.10 `reqCancelWshMetaData` and
   `reqCancelWshEventData`. Track exact request IDs actually attempted by the owned
   transport. Cancel once per ID, events before metadata, before disconnect on
   success, error, timeout, explicit close or abort. Keep request ownership until
   cleanup, including after receiving the response. Do not cancel orders or other
   clients' requests. No cancellation is proof of broker acknowledgement.
2. SDK cancellation is queued. The production adapter must allow its queue/socket
   to send cancellation before disconnect, with a bounded cleanup deadline and
   test evidence using the actual installed SDK against a loopback fake server.
   Do not rely on immediate mock calls as proof of wire delivery. Cleanup failures
   cannot replace the original acquisition error or make data eligible. Cleanup
   is idempotent, handles synchronous callbacks/errors and ignores late responses.
3. Abort promptly stops current WSH work and fences subsequent acquisition after
   awaited locks/reservations. Scheduler stops accepting new work; shutdown aborts
   and drains in-flight refresh/repair before closing PostgreSQL, within a finite
   process deadline shorter than Docker's stop grace. SIGINT, SIGTERM and catchable
   fatal startup/unhandled failures use the same terminal path with nonzero fatal
   exit. Never continue trading work after an uncaught failure.
4. SIGKILL/power loss/network loss cannot guarantee cancellation delivery.
   Preserve existing durable abandoned-acquisition/UNKNOWN retirement and pacing;
   do not invent post-crash cancellation acknowledgement or retry unknown work.
   Document this limit and residual 10281 as an explicit error. No arbitrary new
   client IDs, global reset or unverified cross-session cancellation.
5. Add an optional structured WSH provider error to negative calendar coverage:
   `{ code: number | null, message: string }`, bounded to 1000 characters,
   restricted to WSH ERROR coverage. Existing snapshots without it remain valid
   with unchanged canonical bytes/hash. Stable reason codes and eligibility stay
   unchanged. Preserve provider wording except explicit account/secret redaction,
   terminal-control escaping and length bounds using existing privacy helpers.
   Do not store raw Error objects/stacks/payloads; do not stringify arbitrary objects.
6. Propagate the structured diagnostic through research inspection's source rows,
   authenticated startup preparation and the read-only status report. CLI prints
   instrument/source, numeric provider code and original sanitized text on a
   separate line below generic failure. Validate and sanitize again at rendering;
   legacy errors say original description unavailable rather than inventing one.
   Provider text never becomes a machine reason, instruction or readiness signal.

## Scope and routing

Lead owns shared coverage/parser/inspection contract, startup/status rendering,
integration, report and publication. After plan acceptance, Astra/high worker owns
llm-agent WSH transport/refresh/scheduler/shutdown and associated tests only. Shared
interfaces land first; no concurrent writes to shared files. A separate Astra/high
plan reviewer and different Astra/high final reviewer author no implementation.
Requested/actual model evidence, findings/repairs, elapsed time and available token
usage are recorded. Unavailable telemetry is labelled unavailable.

## Acceptance and verification

- Real SDK loopback verifies cancel frames with correct IDs precede socket closure.
- Metadata wait, event wait, successful response cleanup, timeout, provider error,
  abort before connection/during request, duplicate close, cancellation failure,
  disconnect and late callbacks never duplicate sends or revive usable receipts.
- Scheduler shutdown and process signals stop later instruments/repairs, await
  acquisition cleanup before DB close, and stay bounded during stuck work.
- Provider 10281/502 messages survive transport -> stored negative snapshot ->
  preparation/status -> Polish CLI; secret/account/control strings are sanitized;
  invalid/oversize structures fail parsing, legacy snapshots remain readable.
- No changes to research gates, ledger/pacing, immutable identity, clock threshold,
  broker order flow, model budget or unrelated working-tree files.
- Run focused unit/PostgreSQL cases, then pnpm lint, pnpm typecheck, pnpm test,
  pnpm test:integration against isolated PostgreSQL (never operational fixtures),
  and pnpm build. No strategy/simulator changes, so no new backtest required.
  Verify clean Docker build for shutdown/runtime integration from scoped source.
- Independent hostile review accepted, report written, scoped commit/push on main,
  verify CI for the exact published commit. Deployment/real WSH recovery remains
  separate from source acceptance; never claim 10281 impossible.

## Validation amendment

The first full unit run exposed the existing hanging-DNS test's real 25ms deadline
expiring before entry validation under parallel load. Independent plan reviewer
accepted replacing only that fixture's Date/setTimeout with Node mock timers;
the exact TIMEOUT and zero-HTTPS assertions remain. No production deadline or
fetch behavior changes. A different final reviewer accepted the fixture repair.
