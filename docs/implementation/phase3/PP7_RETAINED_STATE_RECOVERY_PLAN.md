# PP7 retained-state recovery before supervised AAPL

Date: 2026-10-07. Status: accepted by independent Astra/high plan review.
Reviewed proposal SHA256: eeb442a49323f28fec91ad30d7509fab80398c2505e1e831bc523b03b7d65483.
Reviewer: wsh_source_resolution; two findings repaired (lock order/writer barrier and
attestation source identity/preservation of budgets). Implementation review remains separate.
Baseline: ddeef84199b20fd694a5dfcd5a6f27a3420df25f, main.
Owner scope: finish the existing Paper delivery and try one AAPL share. No strategy
formula changes, forced signals, Live activation or safety-counter resets.

## Observed problem and responsibility

During the authorized disabled deployment, the lead selected the fresh-bundle path
after confirming zero proposals, links and close operations. This was insufficient:
the operational database retains 171 broker fills and 36 legacy strategy-state rows.
All retained fills have null proposal IDs, a legitimate retention outcome supported
by migration 2. Some economic fields are incomplete and some strategy labels unknown.
They cannot be reclassified as manual or used to reconstruct neutral loss counters.

The current bundle registration admits this database and latches the bundle, while
PP2 inheritance rejects it as LEGACY_STATE_SOURCE_UNPROVEN. Legacy preparation then
refuses an already-latched installation. A read-only strategy evaluation exposes
only STRATEGY_RUNTIME_UNAVAILABLE. The lead should have checked retained fills before
adoption. No broker orders were submitted and the refusal must remain effective
until a supported recovery has passed review and validation.

## Bounded contract

Add an explicit recovery operation for an already-latched, source-null bundle
installation with retained unlinked history and no PP2 conversion. It must never
run automatically after ordinary conversion failure. Preserve the latch, original
configuration/transition audit and every original fill and strategy row.

The recovery source is an immutable attestation of present persisted legacy state,
with the original disabled legacy authority supplied as private evidence. It is not
reconstruction of historical order ownership or proof of original trade policy.
All legacy global safety rows are copied exactly as PP2 intended, including disabled
and permanently-disabled flags, loss streaks, cooldown counts/dates and watermarks.
Missing state is a refusal, never an invitation to synthesize defaults.

Preconditions, checked again inside one transaction:

- Caller has explicit Paper environment, TRADING_ENABLED=false, entries paused,
  trading loop and AI worker disabled; loaded bundle identity is the rollout's
  first identity and has no legacySourceHash.
- Fresh matching observations from all four services, no active legacy or mixed
  bundle peers. Existing disabled conversion ownership/drain invariants remain.
- Nonempty retained fill history, all fills unlinked, with complete account,
  contract and finite execution-time identity. Unknown strategy labels and incomplete
  economics remain unchanged; they do not supply reconstructed counters.
- Zero proposals/reviews/order links/order-reference ownership/close operations,
  trigger reservations, binding state/outcomes, prior inheritance and conversion.
  Inventory actual schema during implementation; do not silently omit a relevant
  reservation table. Any ownership or unresolved outcome refuses this narrow path.
- Existing legacy runtime table and every configured implementation's state row;
  all state rows have valid booleans, finite dates and nonnegative integer counters.
- Supplied original legacy authority has a valid canonical hash and decodes using
  the existing management-snapshot parser. Evidence is a private, explicitly selected
  file; no secrets or raw environment content enter logs, DB audit or committed files.
  This evidence is archived provenance, not retained management authority. Under the
  zero-ownership checks, old policy/minTick metadata need not equal the current bundle;
  no old value validates current broker metadata or grants management permission.
  Independent reviewer accepted this clarification on 2026-10-07. Test the observed
  unowned PKO minTick0.0001 versus disabled bundle0.01 difference and paired rejection
  when any retained ownership exists.

Use one lock order for recovery and normal conversion: the existing configuration
advisory lock, history/ownership tables in the order already used by conversion,
inheritance advisory lock 1820018, then legacy runtime-state table. The worker must
name the additional reservation/binding/audit tables in a consistent order before
implementation; never lock legacy state before advisory 1820018 because the existing
capture routine takes them in the opposite order. First-adoption historical checks
retain writer-excluding history/ownership locks through latch commit. This excludes
concurrent fill/history/state/proposal writers while rechecking and capturing.
Persist an immutable attestation containing configuration identity, legacy authority
canonical identity, exact state capture and digest, retained history count/digest,
timestamp and capture semantics. The recovery inheritance source is explicitly the
rollout first_effective_hash; SQL attestation validity requires that same existing
source-null rollout/configuration and exact captured state/history. All existing
Paper attempt budgets, account/day debts and migration holds remain unchanged.
An additive migration makes that attestation a
narrow additional source proof for inheritance; existing unknown-source/history
rejections remain unchanged in its absence. In the same transaction invoke the normal
inheritance capture and publish the ordinary future-minute conversion cutoff.
Do not rewrite rollout.legacy_source_hash or manufacture a management snapshot.
Repeat of the same successful recovery returns its immutable receipt without
reimporting newer state or extending the cutoff; conflicting inputs refuse.

Before recovery, provide a read-only inspect/dry-run result with hashes and rejection
reasons. The explicit recovery command verifies those reviewed digests under locks;
changed evidence requires inspection again. Private CLI input/output must be regular
nonsymlink files, parent0700/file0600; output excludes secrets and account identifiers.
Prefer existing shared modules and CLI conventions; no service merge or new daemon.

Prevent recurrence: on FIRST source-null bundle adoption, check retained historical
execution evidence consistently with inheritance before committing the latch.
Historical installations fail early and can still use disabled legacy preparation.
Existing latched management/close paths must remain available. Surface the specific
retained-source refusal through configured strategy diagnostics without raw SQL/error
content. Do not weaken account, risk, research, AI, reconciliation or broker guards.

## File scope and delegation

Expected scope: a new additive migration; shared trading-configuration store,
conversion/recovery modules and exports; a small operator CLI using existing pg and
configuration dependencies; focused unit and isolated PG integration tests; strategy
diagnostic reason allowlist; this plan/report and relevant configuration runbook.
Choose final CLI location to reuse an existing service dependency (no new dependency).
Do not edit unrelated dirty ES/backtest work or apps/signal-engine/src/signal-engine.ts.
If an additional semantic or ownership capability is needed, return to plan review.

Routing: root coordinates (Astra/high); independent plan reviewer Astra/high;
critical recovery implementation Astra/high; a different independent final reviewer
Astra/high, with no authorship in this package. Mechanical validation/publication can
use the smallest available approved route. Record actual route, rework, timing and
available usage in the report; unavailable telemetry remains unavailable.

## Acceptance and hostile validation

1. Reproduce the operational shape using disposable PG: retained unlinked fills,
   unknown labels/incomplete economics, multiple legacy strategies including disabled
   states and nonzero counters; no proposals. New first adoption refuses before latch.
2. Construct the previously-latched shape in fixture setup. Inspect and explicit
   recovery preserve all original rows byte-for-byte/semantically, copy every legacy
   state field, and atomically create attestation/inheritance/future cutoff.
3. Reject enabled writes, wrong environment/account/config identity, missing/invalid
   legacy evidence, stale/missing/mixed peers, absent configured state, invalid
   dates/counters, linked history or any owned/ambiguous/reserved state.
4. Concurrent history/state writers serialize; mismatched inspection digests refuse.
   Injected failure rolls back attestation, inheritance and cutoff together. Repeated
   recovery is idempotent, conflicting repeats reject, audit update/delete/truncate
   and unauthorized proof reuse fail.
5. Existing fresh-empty and properly-prepared legacy conversions still pass.
   No counter reset via config rename/revision, restart, duplicate CLI or new hash.
6. Operational use only after independent hostile acceptance, required local checks,
   clean Docker image, scoped commit/push and successful exact-commit CI. Back up the
   current DB again; use inspect/recover through the reviewed command while writes
   remain disabled. Verify preserved data and real diagnostic strategy evaluation.

Required checks: pnpm lint, pnpm typecheck, pnpm test, pnpm test:integration against
isolated PostgreSQL, pnpm build and clean Docker build. No strategy/backtest behavior
changes, so no new strategy performance backtest. Preserve the existing 25 unrelated
dirty paths. No destructive fixture may touch the operational database.

## Operational continuation

The AAPL configuration and market/history subscriptions are running with all writes
and producer/AI switches disabled. Research calls remain unused from the newly
approved 20-call Marketaux allocation. TWS ledger-prefix compatibility and accounting
qualification are independent pending operator steps. After recovery, reassess all
ordinary entry gates and select a fresh bounded session window. A normal no-signal
or AI rejection remains valid; mechanical recovery does not prove a Paper trade.
