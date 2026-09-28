# Strategy and instrument configuration contract

Status updated 2026-09-28: **PP1 and PP2 published; exact-source-commit CI verified**.
The normative implemented format is the [PP1 contract](../implementation/phase3/PP1_CONFIGURATION_CONTRACT.md)
and additive [PP2 runtime contract](../implementation/phase3/PP2_RUNTIME_CONTRACT.md),
with [disabled JSON example](../../config/trading/paper.v1.json) and
[configuration runbook](../runbooks/TRADING_CONFIGURATION.md). Independent review, local checks, publication
and exact-commit CI passed; see the [PP1 report](../implementation/phase3/PP1_IMPLEMENTATION_REPORT.md).
PP2 delivery evidence is in the [PP2 report](../implementation/phase3/PP2_IMPLEMENTATION_REPORT.md).
The illustrative shape below is not accepted by the PP1/PP2 parser. There is no YAML
loader. Do not paste this example into `INSTRUMENT_BINDINGS_JSON` or the bundle.
See [current state](../implementation/CURRENT_STATE.md) and
[delivery stages](../implementation/phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md).

## Three separate identities

| Entity | Identity | Ownership |
| --- | --- | --- |
| Strategy implementation | Existing ID such as momentum_breakout_long_v1 plus code version | Source-controlled algorithm and parameter schema |
| Strategy instance | Operator-defined stable ID plus immutable parameter revision/hash | Reusable named configuration of one implementation |
| Instrument | Stable instrument ID plus broker-verified contract identity | Listing, currency, sessions, risk/execution policy, research mapping and strategy-instance references |

An instrument references instances; it does not duplicate their parameter values.
Two parameter sets of the same algorithm are distinct instances. Two instruments
may reference the same instance without sharing mutable evaluation/cooldown state.
Adding a configured instance of an existing implementation is not a new strategy.
Adding a new algorithm requires source implementation and its own reviewed scope.

## Proposed input shape

This is a **design example**, not operational configuration or permission to trade.
Its inline policy objects differ from PP1's separate referenced catalogues, and
its contract fields are incomplete for PP1. The implemented parser exposes three
existing momentum thresholds with versioned defaults. PP2 applies them through
fresh factories with default-signal and full replay parity tests. PP1 records
resolved parameters in the hash. The versioned production example
contains disabled entries and a disabled instance.

```json
{
  "schemaVersion": 1,
  "strategyInstances": [
    {
      "id": "momentum_default",
      "implementationId": "momentum_breakout_long_v1",
      "revision": 1,
      "enabled": true,
      "parameters": {
        "dailyReturn20MinPct": 8,
        "h1Return4MinPct": 1,
        "return60MinPct": 0.2
      }
    },
    {
      "id": "momentum_alternative",
      "implementationId": "momentum_breakout_long_v1",
      "revision": 1,
      "enabled": false,
      "parameters": {
        "dailyReturn20MinPct": 5,
        "h1Return4MinPct": 0.5,
        "return60MinPct": 0.15
      }
    }
  ],
  "instruments": [
    {
      "id": "pko_wse",
      "assetClass": "stock",
      "contract": { "broker": "ibkr", "symbol": "PKO", "conId": 35146360, "exchange": "WSE", "currency": "PLN" },
      "session": { "useRTH": true, "timeZone": "Europe/Warsaw" },
      "monitoringEnabled": true,
      "entryEnabled": false,
      "strategySelection": { "mode": "single", "instanceIds": ["momentum_default"] },
      "execution": { "direction": "LONG", "quantity": 1, "quantityUnit": "shares", "orderType": "LMT", "timeInForce": "DAY", "outsideRth": false, "protection": "bracket" },
      "risk": { "maxPositionQuantity": 1, "maxEntryNotional": { "amount": 500, "currency": "PLN" }, "allowOvernight": false },
      "research": { "policyId": "stock_required_v1", "issuerMappingId": "pko_issuer" }
    },
    {
      "id": "aapl_nasdaq",
      "assetClass": "stock",
      "contract": { "broker": "ibkr", "symbol": "AAPL", "conId": 265598, "exchange": "SMART", "primaryExchange": "NASDAQ", "currency": "USD" },
      "session": { "useRTH": true, "timeZone": "America/New_York" },
      "monitoringEnabled": true,
      "entryEnabled": false,
      "strategySelection": { "mode": "single", "instanceIds": ["momentum_default"] },
      "execution": { "direction": "LONG", "quantity": 1, "quantityUnit": "shares", "orderType": "LMT", "timeInForce": "DAY", "outsideRth": false, "protection": "bracket" },
      "risk": { "maxPositionQuantity": 1, "maxEntryNotional": { "amount": 500, "currency": "USD" }, "allowOvernight": false },
      "research": { "policyId": "stock_required_v1", "issuerMappingId": "aapl_issuer" }
    }
  ]
}
```

Contract details not included here (localSymbol, tradingClass, supported exchange,
market-rule IDs/tick bands and session coverage) are broker-resolved and verified
before entry readiness. Operator identity expectations cannot be silently replaced
by first-match lookup. SMART routing and the primary listing are separate fields.
Research mapping IDs refer to a separately validated issuer/provider catalogue;
they are not automatically verified by a plausible name. Example notional caps
are illustrative, not approved account risk limits. Account policy, secrets,
provider credentials and activation windows remain separate deployment inputs.

## Validation and effective configuration

PP1 now supplies one shared strict parser and loader consumed at startup by
ingestion, signal-engine, execution-engine and llm-agent. `TRADING_CONFIG_MODE=bundle`
selects a versioned read-only JSON file through `TRADING_CONFIG_PATH`, with an exact
`TRADING_CONFIG_EXPECTED_HASH`. Configured-file failures stop startup without legacy
fallback. The bundle is immutable until restart; hot reload remains deferred.
Shared snapshots and service observations record identity/drift and retain legacy
management evidence. PP2 adds configured diagnostic/scheduled evaluation and
independent binding replays. Every bundle entry stays denied because PP3 execution
policy is unavailable; PP4 research remains unavailable too.

Validation rejects unknown fields/versions, duplicate IDs or broker identities,
missing instance references, empty assignment for entry-enabled instruments,
invalid finite/range/unit values, unsupported strategies/directions/order types,
missing required risk/research policy and contradictory venue/currency/session.
`mode=single` requires exactly one instance reference for an entry-enabled instrument. A disabled instance may be
referenced but makes entry readiness disabled with a reason; it never silently
selects a different instance. Monitoring-only instruments need not have a strategy.

Execution capability is a shared explicit intersection of broker adapter, market
rules, risk/accounting, research policy and lifecycle support. Type unions alone
are not capabilities. A stock quoted outside the supported currency/venue range,
ETF, future, option or fractional policy must fail execution validation until its
complete capability is implemented; monitoring can remain separately supported.

All consumers report the same effective config hash and schema version. Any
cross-service mismatch blocks new proposals/dispatch before provider/broker writes.
The normalized hash includes resolved defaults, strategy revisions, assignment,
execution/risk/research policy and contract identity. Never include secrets in it.
Provider entitlement and fresh broker observations are readiness evidence rather
than static promises in configuration.

## Selection and parameter isolation (PP2)

- Evaluate only enabled instances assigned to that instrument, intersected with
  implementation capabilities and persisted runtime restrictions.
- Initial production policy is `single`. PP2 also defines/test-validates explicit
  `priority` selection for multiple assigned instances: reject opposite-direction
  candidates and select the eligible candidate with the highest explicit unique
  integer priority. Ties reject; there is no confidence or lexical fallback.
  PP2 evaluation does not submit broker entries.
- No implicit instrument-level parameter overrides. To customize PKO versus AAPL,
  create two named parameter sets and assign them separately.
- Object key: account + instrument + strategy-instance identity/revision. Each
  binding gets isolated mutable strategy objects and rejection state. Durable
  safety state uses account + broker + conId + implementation, surviving renamed
  instances, logical instruments and revisions; parameters may be shared immutably.
- Account-level exposure, entry reservations, loss limits and daily attempt budgets
  remain authoritative across all instances/instruments. Stable binding safety counters
  cannot reset or bypass account restrictions.
- Required history is derived from selected strategies and regime requirements;
  unassigned strategies must not impose extra timeframes or block evaluation.

## Durable attribution and compatibility (PP2)

Preserve existing algorithm `strategyId` semantics; add separate instance ID,
instance revision/hash and effective configuration hash to proposal/AI/risk/audit
and order ownership. Propagate them through wire schemas and hash canonicalization
using an additive versioned migration. Do not reinterpret existing hashes or
recompute historical proposals using new defaults. Old submitted/unknown proposals
and owned positions remain readable and manageable under their original policy.

The durable trigger fence identifies account + broker + conId + direction +
trusted evaluation bucket, excluding instance/revision/configuration names. It
prevents duplicate entry when the instance revision changes mid-trigger.
A new revision is not permission for a second order. Old pending unattempted
proposals are drained or explicitly invalidated by a reviewed transition; an
unknown attempt is never invalidated into retry permission.

Changing/retiring an instance or removing an instrument blocks its new entries,
but cannot discard the original ownership/exit configuration of open positions.
Never require a newly enabled entry strategy or new AI approval to reduce a
position. Protect/reconcile existing broker state before considering a config rollback.

## Migration and acceptance

PP1 provides disabled PKO/AAPL definitions and explicit legacy preparation/conversion,
with snapshots and a durable bundle entry hold. It rejects simultaneous old/new
authority and publishes legacy deprecation diagnostics. Retained original management
bindings preserve the supported close flow and mandatory ingestion monitoring;
conversion never resets attempted/unknown state or budgets. See the normative
contract and runbook for the exact migration and rollback rules.

PP2 factories receive validated parameters and preserve current default behavior
through parity tests and relevant backtests. The current profile restrictions
and seven registered algorithms are not automatically relaxed or all activated.
General schema design covers different algorithms; their configurable parameters
are exposed only with implementation-specific schemas and behavior validation.

Acceptance includes two instances of the same algorithm with different parameters,
different algorithms with incompatible parameters rejected, PKO/AAPL referencing
one shared immutable parameter set, and a fixture-only new supported symbol absent
from production source traversing all consumers without ticker branches. It also
includes conflicting assignments, config drift, restart, open-position removal,
duplicate trigger across a revision change and no leakage of cooldowns/state.
