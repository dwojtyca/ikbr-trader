# Versioned trading configuration (PP1–PP7)

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
instrument. PP1 represents these choices; PP2 applies parameters through fresh
strategy objects. See [strategy instances](STRATEGY_INSTANCES.md) for evaluation,
priority, account scope, immutable attribution and the additional conversion gates.

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

PP7 connects configured scheduling to the guarded proposal, AI and execution flow.
An entry-enabled declaration alone does not authorize an order: runtime/master
switches, durable pause, peer identity, entry windows, budgets, broker coverage,
research and risk checks must all pass. Diagnostic evaluation remains read-only.
Issuer mapping is not verified research. Real-source and operational acceptance
are tracked in the [PP7 report](../implementation/phase3/PP7_IMPLEMENTATION_REPORT.md)
and [closure plan](../implementation/phase3/PP7_CLOSURE_PLAN.md); source implementation
does not prove Gate A/B readiness.
`TRADING_ENABLED` keeps its existing meaning, including the requirement for an
authorized full close. Configuration admission never exempts close from its
existing account, authentication, ownership, quote, risk or quantity checks.

## Disabled conversion and retained positions

The following PP1 authority procedure remains necessary. A PP2 image additionally
requires its disabled-write cutoff/state-inheritance conversion; unresolved attempts,
close work or live AI leases block it. Follow the [PP2 runbook](STRATEGY_INSTANCES.md)
and do not treat a PP1 retained-management snapshot alone as PP2 evaluation readiness.

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

## Retained history after proposal retention

A database can have no proposals or broker-order links and still be historical.
`broker_execution_fills` intentionally survives proposal retention, together with
legacy strategy safety state. Inspect both before selecting the fresh-install path.
A missing management source must block first bundle adoption while legacy preparation
is still possible. Do not delete retained fills, reconstruct counters from incomplete
commissions, or treat unlabelled fills as manual transactions to satisfy a gate.

The narrow repair for an installation already latched without that source is defined
in the [retained-state recovery plan](../implementation/phase3/PP7_RETAINED_STATE_RECOVERY_PLAN.md).
It requires an explicit reviewed inspection and recovery, disabled writes, matching
bundle peers and no owned/reserved proposal state. It captures the existing global
safety rows unchanged and retains the original rollout audit. It does not reconstruct
historical ownership or authorize an order. A normal failed conversion never invokes
this repair automatically. Consult the package implementation report for release and
operational validation before using the recovery command.

### Explicit retained-state inspection and recovery

Use the reviewed image and apply migration29 through the normal backed-up migration
procedure first. Stop all producers; all four service observations must still match
the original first bundle. Set explicit Paper/account allowlist, `TRADING_ENABLED=false`,
`EXECUTION_ENTRIES_PAUSED=true`, `TRADING_LOOP_ENABLED=false`, `LLM_AGENT_ENABLED=false`.
The command uses the configured PostgreSQL database and makes no broker/provider call.
Do not point tests or fixture commands at that database.

Prepare a private directory with mode 0700 and files with mode 0600. The bundle, legacy evidence and
inspection paths must be absolute, canonical regular files (no symlinks). Legacy
input is `{ "schemaVersion":1, "sourceHash":"…", "canonical":"…" }`, produced
from the actual retained old authority with existing `createLegacyManagementSnapshot`.
The shared decoder checks its canonical identity; a newly fabricated old policy is
not acceptable evidence. Extra provenance can describe the retained private backup,
but must never include raw environment text, account credentials or API keys.

From an environment configured with that private bundle and the operational database:

```sh
node apps/execution-engine/dist/retained-state-recovery-cli.js inspect \
  --legacy-evidence /absolute/private/legacy-authority.json \
  --out /absolute/private/inspection.json
```

Inspect returns eligibility, fixed refusal reasons and state/history digests/counts.
It locks for a consistent read then rolls back; it writes no database attestation.
An ineligible receipt is a refusal, regardless of the process exit status. Review
an eligible receipt and the preserved-state scope before executing:

```sh
node apps/execution-engine/dist/retained-state-recovery-cli.js recover \
  --legacy-evidence /absolute/private/legacy-authority.json \
  --inspection /absolute/private/inspection.json \
  --out /absolute/private/recovery.json
```

Recovery verifies every reviewed digest again under locks. A changed fill/state,
foreign account, changed first bundle, nonempty ownership/reservation, unknown source
outcome or stale/mixed peers refuses. Do not edit the inspection or remove rows to
pass. It preserves all existing Paper attempt budgets/debts and migration holds.
It copies all existing global strategy safety rows, never neutral defaults. The
legacy file is archival evidence only: old/current minTick or policy parity is not
required with zero ownership, and it validates no current broker metadata.

The receipt records present-state inheritance, not reconstructed historical trade
ownership. The SQL boundary checks source identity, authority envelope/hash, state
and history evidence; the shared parser checks complete canonical instrument/binding
semantics. Direct manual SQL insertion is not an operator recovery interface.

Output uses create-only files. If commit succeeded but output delivery failed, keep
the original reviewed inspection and retry the same operation to a new output path;
the immutable receipt is returned without recapturing state or moving the cutoff.
A different inspection does not reset the conversion. After success, wait for the
recorded future-minute cutoff and use read-only strategy evaluation. Recheck the
ordinary broker, accounting, research, risk and lifecycle gates before activation.
