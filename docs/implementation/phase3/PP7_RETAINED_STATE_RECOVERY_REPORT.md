# PP7 retained-state recovery report

Date: 2026-10-07. Status: independent review and local release validation passed; publication/CI pending.
Baseline: ddeef84199b20fd694a5dfcd5a6f27a3420df25f. Plan:
[retained-state recovery](PP7_RETAINED_STATE_RECOVERY_PLAN.md).

## Problem and result

The disabled AAPL deployment exposed a mismatch between configuration adoption and
strategy-state inheritance. First bundle adoption accepted zero proposal ownership,
but the database retained 171 unlinked historical fills and 36 global strategy-state
rows. Inheritance correctly refused an unproven historical source after the bundle
had already been latched. The lead had checked proposals/links/closes without checking
retained fills and should not have selected the fresh-install path. No trade was sent.

First source-null adoption now detects retained execution history before latching.
A narrow explicit recovery command supports the already-latched case: it verifies
private legacy evidence, fresh matching peers, disabled Paper settings, zero ownership
and unchanged reviewed state/history. One transaction records an immutable present-state
attestation, copies every existing global safety row and establishes the ordinary
future-minute conversion cutoff. It never resets or reconstructs counters, rewrites
the rollout source, removes fills/audit, refunds budgets or enables trading.

The two-step inspect/recover interface is documented in the
[configuration runbook](../../runbooks/TRADING_CONFIGURATION.md#explicit-retained-state-inspection-and-recovery).
The legacy authority remains provenance, not management authority or proof of current
broker contract/tick. SQL validates the authority envelope/hash and locked evidence;
the shared decoder validates full canonical instrument/binding semantics. Manual SQL
insertion is not a supported recovery procedure.

## Reviews and repair evidence

Independent plan reviewer `wsh_source_resolution` (requested Astra/high) accepted
reviewed proposal SHA256 eeb442a49323f28fec91ad30d7509fab80398c2505e1e831bc523b03b7d65483
with explicit lock order/first-latch writer barriers and immutable source/debt preservation.
The reviewer subsequently accepted the unowned historical/current metadata distinction.

Implementation: `aapl_broker_readiness`, requested/selected Astra/high. Independent
final reviewer: `retained_state_final_review`, requested/selected Astra/high; no
implementation authorship. Five coherent repair batches addressed canonical-envelope
lookup, falsy CLI inspection inputs, SQL evidence/time/NULL validation, stronger hostile tests, and preserved precedence for the existing ownership-specific
configuration refusal. No test weakening or broader ownership capability was introduced.

Independent implementation and document review were accepted. After the final
error-precedence repair, the reviewer independently passed the shared build and
28 focused tests (configuration store, recovery, conversion and CLI), zero skipped.
The final hostile matrix adds foreign-account fills, stale/mixed peers, negative
counters and a changed first configuration. Other cases exercise preservation,
concurrent writers, atomic rollback, immutable/idempotent recovery, malformed proof,
unknown source outcomes and the actual archived PKO tick discrepancy.

Mechanical checks use the fresh archive of baseline plus only this package's files.
Requested GPT-5.6 Luna/low was unavailable; the selected available fallback is GPT-6
Luna/low. Dependency installation completed with frozen lockfile after network access
was available. PostgreSQL tests use the disposable loopback 55479 instance, never the
operational database. All 25 unrelated dirty-file hashes are tracked separately.
Actual model telemetry/token usage is unavailable; no savings claim is made. Wall-clock
preparation/implementation/review timestamps are retained in private check receipts.

## Release validation

All required local checks passed on the clean baseline archive plus the exact ten
runtime/test files: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`,
`pnpm build`, and the clean Docker build. Unit command: 3,081 passed, 157 database-gated
skipped, zero failed; the explicit integration command then passed 2,481 tests with
zero skipped. The first integration attempt found two existing error-precedence
assertions; runtime ordering was repaired without changing those tests and the full
sequence was rerun successfully. The successful full sequence took 262.448 seconds
(lint 4.306, typecheck 8.973, unit 58.426, integration 126.383, build 7.418, Docker
56.942). Independent final review passed 28 focused tests.

Reviewed image: `sha256:4947977d700c16a468b12ef7273a630cc4ae9594d3ca73f724356655c0f042cf`.
A final whitespace-only EOF correction received a fresh full no-cache image build; no runtime semantics changed.
Private mechanical logs and hash receipts are retained under
`/private/tmp/pp7-retained-state-recovery/`. Publication and exact-commit CI are the
remaining release gates at this report revision. No operational recovery has yet
been executed.

## Paper operational state

The AAPL-only monitoring configuration is running with writes, scheduler and AI
worker disabled. Broker checks observed the allowlisted Paper account, CLEAN
reconciliation without positions/orders/holds, real-time AAPL data and native history
for all six required timeframes. These are dated observations, not a continuing
readiness guarantee. Normal quote-age checks can still reject a momentarily stale BBO.

An independent preflight found TWS returning `$LEDGER-CashBalance` while the current
account adapter reads `CashBalance`. The documented TWS compatibility checkbox change
was requested from the owner; no IBKR UI was automated. Accounting qualification is
prepared but unsubmitted pending the required operator declaration. A subsequent
read-only diagnosis also found a durable `ACCOUNTING_CLOCK_INVALID` hold despite
later valid clocks; the separate clock-recovery package must address that code
limitation without resetting the source history. New Marketaux
allowance of 20 calls is approved but unspent. Research is prepared and not yet refreshed.

A successful recovery would restore diagnostic strategy evaluation only. The ordinary
accounting, research, risk, protection and bounded-session gates still apply. No
Paper entry/exit, profitability or unattended operation is claimed by this report.
