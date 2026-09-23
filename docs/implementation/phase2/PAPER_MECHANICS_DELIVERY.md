# One-instrument Paper mechanics — delivery direction

Date: 2026-09-23

Status: owner-confirmed priority; code-path audit complete. This document
defines the milestone and PR boundaries, not an accepted implementation plan
or permission to start a broker window.

## Milestone

Prove a single supported instrument's complete flow:

`IBKR data → existing strategy → durable proposal → AI adjudication → fresh`
`deterministic risk/execution validation → IBKR order/fill → broker position →`
`protective exit or controlled full close → flat broker position → reconciliation`.

The proof must include AI decision/input evidence, order and fill identifiers,
commissions and realized P&L, no orphan executable children, no accidental
reverse position, and matching local/broker terminal state. A loss does not
invalidate mechanically correct execution; a profit cannot excuse a lifecycle
failure. Strategy tuning and profitability validation follow this milestone.

## Integration gap at the PR15.6 base

Independent read-only audit found two separate paths:

- `apps/signal-engine/src/runtime/execution/submitter.ts` posts to
  `/execution/execute-ticket`, which submits through the common service
  immediately. Its `decision_source='user'` rows are deliberately excluded
  from the existing LLM claim query.
- Legacy `SignalRepository.insertProposedOrder` creates `signal` proposals
  without `client_order_id`, `client_order_hash` or `instrument_id`.
  `llm-agent` adjudicates these, but current `executeProposed` refuses missing
  submission identity. Enabling the worker is not sufficient to execute them.

Reuse the bound runtime and common three-phase submission service. Do not
introduce a third submission path or relax idempotency to revive legacy rows.

## Next PR boundary — mandatory AI gate for bound proposals

The accepted [PR15.6 plan](PR15_6_AI_PROPOSAL_GATE_PLAN.md) specifies a proposal-only entry path with
explicit persisted AI-required/pending state, immutable proposal/hash binding,
expiry, and an `AWAITING_AI` runtime result. Persisting a proposal must never
dispatch a broker order. Reuse the existing LLM worker and technical, account,
and market-news context; record source timestamps and missing context honestly.
Financial statements and broader research enrichment are subsequent work.

The plan must settle schema/migration, state transitions, claim fencing,
approval ownership, expiration and numerical-risk revalidation after the AI
delay before implementation. The common dispatch boundary must require the
actual persisted, unexpired approval for this exact proposal and enforce risk
status plus fresh broker exposure/reconciliation. Caller-provided actor or
`aiDecision` metadata cannot authorize execution. Direct/manual entry routes
must not bypass the selected instrument's required AI policy.

Preserve broker SL/TP and authorized risk-reducing exits independently of AI
availability. Prevent the legacy producer and bound loop from competing for
the selected instrument. Preserve the audit on cooldown; never convert an
ambiguous submission timeout into rejection/cancellation or an automatic retry.

Minimum acceptance tests through production components and disposable Postgres:

- pending, rejected, expired, missing/mismatched approval and risk failure:
  zero broker dispatches;
- correct approved proposal: exactly one dispatch through the existing
  prepared-plan/idempotency path;
- duplicate polling, stale worker, restart and concurrent execution: no
  duplicate order or mutable approval identity;
- unknown execution outcome: reconciliation-owned recovery, no automatic
  rejection or resubmission;
- direct entry bypass rejected; protective exits remain independent.

This PR alone is not full Paper readiness. Do not activate any registry seed,
deploy the stack, make paid AI/news requests or call IBKR as part of local tests.

## Following PR boundaries

1. **One-instrument lifecycle and evidence.** Reuse existing bracket, fill and
   reconciliation code; test full close, pending-parent/child cancellation,
   partial fills, duplicate close and restart against actual production
   components with a fake broker first. A broker “not found” or timeout is
   not proof of cancellation. Prove fresh account/conId ownership and
   quantity bounds before close, and prove final flat state/no orphan children.
   Add the minimum monitoring/alerts and read-only acceptance collector here.
2. **Controlled Paper window.** Select one supported instrument and resolve
   its exact current IBKR contract, account allowlist, tick/session rules,
   quantity and notional/loss limits. Validate startup/abort/cleanup runbooks,
   dependencies, data freshness and operator-visible progress. Obtain separate
   owner launch authorization, run the bounded window and archive broker proof.
   Start with one whole-share long position for a supported stock if approved;
   the exact symbol/contract is not selected by this document. No ES activation.
3. **Strategy evaluation and tuning.** Only after mechanics pass, collect a
   preregistered sample and assess results including costs and drawdown. Broaden
   AI research or instrument coverage in separately scoped PRs.

For fixture tests, deterministic strategy/AI/broker adapters may exercise
EXECUTE and REJECT. They are not broker evidence and must not be wired into
the normal production registry. The actual Paper run uses the real AI gate.
If the strategy emits no signal or AI rejects every entry, the round-trip
criterion remains unproven. Do not silently weaken the strategy or force AI
approval; any explicitly seeded mechanical Paper proposal requires its own
reviewed, bounded plan and owner authorization and still passes AI and risk.

## Engineering workflow and stop boundaries

For each bounded implementation PR: write the detailed plan; obtain independent
agent acceptance after corrections; implement; use a new independent reviewer
to verify the complete plan and code; fix until accepted; run all local gates
and relevant integration tests; commit/push only that scope; verify GitHub CI.
Changed code after a failed gate returns to review. The owner's standing
authorization covers this engineering cycle, not automatic broker activation.

Preserve unfinished PR15.5F work separately and keep the terminal ES experiment
immutable. Its diagnostics and tuning are not on this milestone's critical path.

## GPW scope decision — 2026-09-23

The owner selected GPW rather than AAPL for the first supervised Paper test.
PKO BP was resolved through the Paper Gateway (WSE/PLN, conId 35146360).
The current account reports its main risk metrics in USD. Therefore the next
bounded implementation is [GPW1 currency risk](../phase3/GPW1_CURRENCY_RISK_PLAN.md),
followed by authoritative GPW price/session rules and PLN lifecycle, then
strategy-price propagation and controlled-window readiness. This sequence does
not enable a stock or replace the minimum monitoring/abort acceptance gates.
No signal/AI decision is forced to meet a proposed test date.
