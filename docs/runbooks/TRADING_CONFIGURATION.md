# Versioned trading configuration (PP1)

PP1 adds a startup configuration bundle shared by ingestion, signal-engine,
execution-engine and llm-agent. The [field contract](../implementation/phase3/PP1_CONFIGURATION_CONTRACT.md)
defines the supported stock declarations, defaults, units and rejection rules.
The [implementation plan](../implementation/phase3/PP1_IMPLEMENTATION_PLAN.md)
sets the delivery boundary. This runbook describes a later authorized deployment;
the PP1 implementation itself performs no deployment or trading activation.

## Configure and inspect

[paper.v1.json](../../config/trading/paper.v1.json) contains disabled PKO and AAPL
definitions and one reusable existing momentum instance. Instruments refer to
strategy instances and separate account, entry, execution, risk and research
catalogues. To describe another supported stock, add its verified listing
expectations, issuer mapping and policy references. To describe different strategy
parameters, add a named instance and assign it; do not copy parameters into an
instrument. PP1 represents these choices; applying parameters to strategy objects
is PP2 work.

Build the shared package, then calculate the effective hash from the repository
root. This resolves versioned defaults before hashing and prints no credentials:

```sh
pnpm --filter @ikbr/shared build
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {parseTradingConfiguration,computeTradingConfigurationHash} from "./packages/shared/dist/trading-config.js"; const r=parseTradingConfiguration(readFileSync("config/trading/paper.v1.json","utf8")); if(!r.ok){console.error(r.issues);process.exit(1)} console.log(computeTradingConfigurationHash(r.configuration));'
```

Use the same settings in all four services:

| Setting | Meaning |
| --- | --- |
| `TRADING_CONFIG_MODE` | `legacy` or `bundle`; unspecified preserves legacy with a deprecation diagnostic |
| `TRADING_CONFIG_PATH` | Absolute bundle file path; in Compose `/app/config/trading/paper.v1.json` |
| `TRADING_CONFIG_EXPECTED_HASH` | Exact lower-case SHA-256 printed above; mandatory in bundle mode |
| `TRADING_CONFIG_MIGRATION_PREPARE` | Explicit legacy preparation mode; requires `TRADING_ENABLED=false` and blocks entry/proposal/provider work |
| `TRADING_CONFIG_LEGACY_SOURCE_HASH` | Previously persisted, disabled legacy management snapshot selected during conversion |
| `IB_CONFIG_METADATA_CLIENT_ID` | Dedicated execution metadata socket identity, default 155; must differ from other configured broker clients |

Compose mounts the configuration directory read-only. File changes take effect only
after restart, with a matching expected hash. A missing/invalid file, unknown schema,
wrong hash, unsupported capability or invalid reference fails startup. A configured
file never falls back to legacy settings. Bundle mode rejects conflicting watchlists,
binding JSON, enabled PKO/AAPL profile flags and legacy strategy overrides; clear
those authority settings during conversion. Credentials, account allowlists and
activation controls stay outside the bundle.

Even a valid entry-enabled declaration cannot trade through PP1 bundle mode.
Diagnostics retain `PP2_STRATEGY_RUNTIME_UNAVAILABLE` and
`PP3_EXECUTION_POLICY_UNAVAILABLE`; issuer mapping is not verified PP4 research.
`TRADING_ENABLED` keeps its existing meaning, including the requirement for an
authorized full close. Configuration admission never exempts close from its
existing account, authentication, ownership, quote, risk or quantity checks.

## Disabled conversion and retained positions

1. Preserve a private database backup and record the reviewed image/commit. Upgrade
   all four services to the PP1-capable image with the existing legacy authority,
   `TRADING_ENABLED=false` and `TRADING_CONFIG_MIGRATION_PREPARE=true`. Do not run
   an older image alongside conversion; it cannot enforce PP1's durable entry hold.
2. Wait until all four services report the same prepared source hash and preparation
   is complete. Preparation blocks both AI provider work and entry proposal work.
   The snapshot captures the validated legacy authority in the database; it is not
   raw environment JSON and contains no credentials. If ownership cannot resolve
   under that source, conversion is refused.
3. Configure the bundle path, expected hash and exact legacy source hash on all four
   services. Clear old authority settings and preparation mode. Keep writes disabled.
   The first conversion checks current preparation evidence and atomically records
   the bundle identity and durable entry hold. Expired preparation evidence requires
   renewed disabled preparation; it never grants a bypass.
4. Inspect each service's identity and peer observations. Missing, stale or different
   bundle peers remain blocked. On a genuinely fresh database without retained
   ownership, the legacy source may be omitted; this is checked against persisted
   submission/ownership state, not inferred from configuration or a UI position list.
5. Verify monitoring and existing ownership before considering any separately
   authorized operational activity. Removed or monitoring-disabled owned instruments
   retain management subscriptions and their source policy for the supported close
   flow. No rows, hashes, unknown attempts or consumed budgets are reset.

The legacy source preserves policy as captured during preparation. The old schema
did not persist every original entry policy value, so this is not a reconstruction
of previously unrecorded history. Legacy PKO/AAPL definitions also lack a primary
listing; that absence is treated as unknown, while any known conflicting listing
still rejects. New bundle metadata verification requires an exact returned primary
listing and never backfills the old snapshot. New expectations cannot overwrite the retained
close policy or manufacture ownership. Unsupported/unowned positions retain their
existing refusal behavior.

## Readiness and rollback

`GET /execution/configuration` requires the existing execution Bearer authentication.
It reports configuration identity, admission and peer evidence. Ingestion and signal
publish their local configuration diagnostics; llm-agent publishes its observation
to the shared store without introducing a new HTTP listener.

The authenticated read-only route
`GET /execution/configuration/instruments/:instrumentId/broker-evidence` explicitly
requests contract details and the routing venue's market rule, then combines them
with existing session and ingestion BBO evidence. Ordinary configuration status
reads use cached evidence and recompute its age; they never refresh timestamps.
An unrequested broker observation is unknown. Missing rules, delayed/frozen quotes,
identity mismatches and unavailable/stale schedules remain distinct from a valid
closed session. These reads create no orders or paid AI/provider requests.

Rollback retains additive snapshots, ownership and the durable bundle hold. Use a
compatible reviewed image and configuration with entries paused; changing the mode
back to legacy or waiting for leases to expire cannot reopen entries. Do not delete
audit tables or rewrite hashes to restore an older configuration. Existing supported
protection, reconciliation and close management use retained evidence. A separately
reviewed transition is required to remove the durable entry hold; PP1 supplies no
reset switch.
