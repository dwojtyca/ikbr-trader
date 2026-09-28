# Production-style Paper acceptance and operations

Status: **planned runbook specification, not executable on the current baseline**.
Updated 2026-09-26. Requires [PP0–PP6](../implementation/phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md)
implementation and review. Current usable narrow procedures remain
[PKO](GPW_PAPER_ROUND_TRIP.md) and [AAPL](AAPL_PAPER_ROUND_TRIP.md); neither proves
unattended production-style readiness. No invented API routes/env commands appear here.

## Launch manifest

Record exact code SHA/image digest, migrations, schema/effective configuration hash,
Paper environment, verified allowlisted account (private record only), both contract
identities, strategy instance/revision/parameters, research policy/snapshot/provider
coverage, sessions/timezones and operator responsibility. Include explicit authorized
start/end times, quantity, notional/stop/daily-loss/attempt limits and paid provider
request/cost ceiling. Never commit account identifiers, tokens or financial balances.

GateB starts with one whole-share attempt/account/day. GateC permits at most two
attempts/account/day, one per instrument/day, with one active account-wide bot intent,
after that policy is implemented/reviewed/authorized. Initial account-day timezone
is Europe/Warsaw; instrument session dates remain exchange-local. Values cannot be
reset by changing run ID, config revision or process restart.

## Disabled preflight

- Confirm actual account/environment; port number is not identity.
- Require matching config hashes across ingestion/signal/execution/AI and compatible
  migrations. Fail on unknown instance references or unsupported capabilities.
- Verify broker-resolved listing, market rules, session coverage and real-time BBO
  for both configured instruments, at actual evaluation time.
- Inspect closed-bar readiness and research source/issuer/freshness coverage per
  instrument. Counts, /health or a disabled scheduler /ready alone are insufficient.
- Require fresh complete account/exposure/reconciliation evidence, no conflicting
  holds/ownership and finite currency-aware risk caps. Known unrelated external
  exposure is accounted for; it is neither silently managed nor simply ignored.
- Verify authenticated operator controls, supported entry pause, close/protection
  observer and alert delivery health. Check backup/recovery procedure.
- Provider/model diagnostics, if needed, run only inside the recorded authorized
  cost/request scope. A configured key is not coverage or availability evidence.

## Supervised acceptance

Use the shipped authenticated bound runtime, never retired legacy signal routes.
A valid no-signal or AI REJECT remains pending acceptance. For each initial
instrument collect one real entry, broker protection, real exit and fresh final
instrument-flat/no-working-order evidence with original proposal/instance/config/
research/AI/risk identity, commissions and P&L completeness. Do not fabricate
signals or alter thresholds during the window. Preserve unknown attempts and budget.

## Automated observation

After GateB, run five consecutive scheduled sessions per instrument under the
unchanged launch manifest and PP7 policy. The bot performs normal evaluation,
protection and exit observation; an operator monitors alerts rather than manually
polling close completion. Track every evaluation interval, reason for non-trading,
provider latency/cost, quote/history/research freshness, reconciliation lag,
protection, fills, costs and session-end state. See PP7 for exact reset/pass rules.

## Stop and incident handling

Pause new entries on stale/mismatched evidence, config drift, breached limits,
unknown dispatch/cancel state, protection gap or failed critical alert delivery.
Keep supported protection/reconciliation and risk-reducing exit management active.
This is the **target** pause behavior: current TRADING_ENABLED=false also blocks
full close and must not be represented as an implemented entry-only pause.

Never resubmit an unknown order with a new request ID. Never equate a timeout,
local row deletion or SUBMITTED response with cancellation/flat state. The broker
must establish remaining quantity and order outcomes before any bounded recovery
write. If the adapter cannot establish ownership or quantity, retain the hold and
escalate to the owner-operated IBKR procedure; no automated IBKR UI.

No-overnight policy needs an exit deadline before the actual broker close, including
early-close sessions. A limit order is not guaranteed to fill. Unresolved near-close
state is an incident, not permission for an ad hoc order bypassing risk/audit.

## Restart, shutdown and completion

A clean restart validates configuration, reconstructs durable ownership and compares
fresh broker state before admitting new entries. A database restore uses an isolated
verified backup procedure and requires reconciliation against broker events since
backup. Graceful shutdown pauses entries, records outstanding state and preserves
broker-side protection; it must not silently cancel it.

A successful acceptance report includes per-instrument session counts, real round
trips, fault-injection evidence labelled separately from broker observations,
restart results and exact image/config/CI identity. Any material fix/config change
restarts the soak count. Passing Paper acceptance does not enable Live.
