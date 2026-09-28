# Generic Paper stock policy (PP3)

This runbook describes source capability and read-only diagnosis. PP3 does not
activate trading: bundle entry still fails with `PP4_RESEARCH_UNAVAILABLE`.
`bounded_scheduled` fails with `PP5_LIFECYCLE_REQUIRED`. Follow the
[configuration runbook](TRADING_CONFIGURATION.md), [PP3 contract](../implementation/phase3/PP3_IMPLEMENTATION_PLAN.md)
and later reviewed launch procedure before operational use.

## Supported identity and order

| Route | Primary listing | Quote currency | Session timezone |
| --- | --- | --- | --- |
| WSE | WSE | PLN | Europe/Warsaw |
| SMART | NASDAQ, NYSE or AMEX | USD | America/New_York |

The configured asset class must be stock, with exact IBKR conId, symbol,
localSymbol and tradingClass. Current broker STK metadata, route-selected market
rule bands and exact session identity must agree. USD alone is never a market.
The initial entry is one whole share, long, LMT/DAY, regular hours, with TP/SL
bracket protection. The supported audited full close is one SELL LMT share.
ETF/FUT/options, shorts, fractional quantities and partial/trailing exits are not
supported. Metadata cannot fall back to a minimum tick when rule bands are missing.

Both initial instruments and further supported stocks use the same configured
path. Add an instrument and its strategy assignment through the PP1 bundle, retain
that bundle's canonical hash and run its preparation checks. No ticker-specific
execution branch is needed. The older PKO/AAPL adapters retain historical management
and reports; they do not grant new attributed entries.

## Run manifest

Execution reads `PAPER_RUN_POLICY_JSON` in addition to the PP1 bundle. Absence means
no generic entry. The following is a schema example, not an approved launch or
recommended financial limits. Replace all placeholders and obtain reviewed bounds;
the placeholder hash/account deliberately cannot be used as a real launch.

```json
{
  "version": 1,
  "runId": "supervised_example",
  "accountId": "DU_REPLACE_ME",
  "effectiveConfigHash": "REPLACE_WITH_EXACT_BUNDLE_HASH",
  "accountDayTimeZone": "Europe/Warsaw",
  "kind": "supervised_one_attempt",
  "maxAttemptsPerAccountDay": 1,
  "maxAttemptsPerInstrumentDay": 1,
  "windows": [
    { "instrumentId": "pko_wse", "conId": 35146360,
      "startsAt": "2026-09-28T14:00:00Z", "endsAt": "2026-09-28T14:30:00Z" },
    { "instrumentId": "aapl_nasdaq", "conId": 265598,
      "startsAt": "2026-09-28T14:00:00Z", "endsAt": "2026-09-28T14:30:00Z" }
  ],
  "currencyCaps": {
    "PLN": { "maxNotional": 1000, "maxStopRisk": 10, "feeReserve": 5, "maxDailyLoss": 20 },
    "USD": { "maxNotional": 1000, "maxStopRisk": 10, "feeReserve": 5, "maxDailyLoss": 20 }
  }
}
```

Windows are at most 60 minutes, within one Warsaw account date and one instrument
session date, and require verified RTH coverage through 15 minutes after the window
ends. Their conIds are unique and must match the loaded configuration. UTC offsets
must be explicit. Caps use quote-currency units; effective notional is the smaller
of the bundle and manifest caps. All used currencies require all four positive
finite caps. Unknown fields, foreign hashes, changed run contents, Live or simultaneous
legacy `GPW_RUN_*` / `AAPL_RUN_*` authority are rejected.

The account counter is one attempt per Europe/Warsaw date across instruments,
strategies, revisions and run IDs. The instrument counter uses stable broker/conId
and its verified session date. A proposal alone consumes nothing. The transaction
that persists its attempt and prepared broker links consumes the slot before send.
A crash before send, timeout or unknown result retains the attempt. Reconcile it;
never retry the submission or delete rows to regain a slot. A changed configuration,
new run ID or restart cannot replenish a day. One active bot intent/owned position
also blocks the account across day boundaries.

## Adoption, restart and rollback

Migration 19 adds generic immutable manifests, proposal bindings, attempts,
adoption markers, legacy date debts and migration holds. It imports consumed old
windows and attempted entry rows once per original proposal, preserving original
reports. A legacy charge on a different date is an additional conservative debt.
Missing or conflicting identity/timestamps create an account hold, or a global hold
when the account cannot be trusted. These are not auto-cleared.

First adoption requires `TRADING_ENABLED=false`. The execution startup transaction
imports any intervening old writer, records holds durably and pins the run manifest.
An already adopted account can restart with writes enabled only after the existing
adoption/hold/run identity checks; this does not authorize activation or remove PP4.
An incompatible run ID fails. Old writers cannot set an entry-attempt marker or
consume an old window after account adoption. Do not downgrade to an older image
assuming its old tables restore permission. Pause entries and verify original
ownership plus schema compatibility before any rollback.

Disabled or removed assignments retain management and quote monitoring from the
original verified configuration snapshot and proposal attribution. Conflicting or
missing original hashes fail closed. A logical instrument ID alone cannot choose
between differing retained policies; management resolves the original proposal.

A proven terminal unfilled attempt can cease blocking later-day active ownership
only when independent reconciliation proves flat, no working orders, no fills,
exact zero-fill terminal records for all three bracket legs and valid original
identity/window evidence. This is not a completed round trip and never refunds
its consumed attempt. Unknown or merely locally cancelled state keeps the hold.

## Economic and dispatch evidence

A generic entry additionally requires certified complete execution coverage from
Warsaw midnight through a fresh reconciliation point, exact matching persisted
fills and commission records, USD account evidence and currency-specific funds/FX.
The production adapter currently cannot certify this full Warsaw-day interval;
`paper_daily_loss_coverage_unavailable` therefore remains an operational blocker independent
of PP4. A requested history interval or an empty local table is not certification.

Daily loss conservatively debits `max(0, -broker realized P&L) + max(0, commission)`
per execution in its currency. Gains/rebates do not replenish the budget. The debit
must be strictly below every manifest daily cap; currencies are not netted through
FX. This can overstate loss if broker realized P&L already includes fees. Reports
calculate round-trip gross/net P&L separately. Missing, mixed, sentinel or corrected
accounting requires fresh evidence. Corrections cannot inherit stale known values.

Before reservation and send, the account lock and persisted accounting fingerprint
are rechecked. The final synchronous send fence also checks observed fill/commission
events, account/session/generations and finite deadlines. Close-risk expiry is
checked after awaited context work and again immediately before the broker call.
A consumed unknown remains auditable even when a deadline aborts the call.

## Read-only inspection

- `GET /execution/paper-window`: manifest/adoption/window/budget diagnostic for the
  current account; this does not reserve or establish entry readiness.
- `GET /execution/lifecycle/:id/round-trip`: existing JSON report with original
  attribution/hash, manifest/window/attempt dates, AI/risk evidence, broker legs,
  close references, typed fills, fees, currency and refusal reasons.
- Append `?format=markdown` for the same evaluator result in readable Markdown.
  Formatting neither declares completion nor changes state.

`COMPLETED` requires an exact one-share entry/exit, matching typed STK/currency
broker/local executions and independent final flat/no-working-order evidence.
Accounting may remain `PENDING_FEES` or `MIXED_CURRENCY`; unknown net P&L is not zero.
Other-contract exposure remains visible and account-wide risk/identity checks stay
mandatory. `TRADING_ENABLED=false` still blocks full close and does not cancel
protection; changing that behavior and automatic exit observation belong to PP5.
