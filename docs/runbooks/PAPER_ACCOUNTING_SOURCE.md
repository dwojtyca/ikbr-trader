# Paper account-day accounting source

Status: F1 implementation accepted by hostile review; full release validation is
pending. This document is not evidence that an
operator's broker host is qualified. The
[source contract](../implementation/phase3/PP7_ACCOUNTING_SOURCE_CONTRACT.md)
defines the supported capability and evidence boundary. Continue to use the
[Paper lifecycle runbook](PAPER_LIFECYCLE_SUPERVISION.md) for position management.

## Supported host and controls

The positive route uses TWS with seven-day Trade Log retrieval and Master Client
ID 0. A dedicated read-only accounting socket uses client ID 0; the existing
execution socket keeps its own nonzero ID and remains the order writer. The
accounting endpoint must match the configured execution host/port exactly. Other
configured clients must not occupy ID 0. IB Gateway's current-day retrieval is
not qualified as complete coverage of a Warsaw account day by this implementation.

Qualification records operator-observed settings that the API cannot attest. The
API handshake supplies protocol and account evidence; it does not prove the TWS
product build or Trade Log setting. Do not claim otherwise in an evidence record.

Keep `IBKR_ENVIRONMENT=paper`, `TRADING_ENABLED=false`, entries paused and the
trading loop disabled while preparing or qualifying the source. The allowlisted
Paper account, explicit `EXECUTION_BROKER_TIME_ZONE` (`UTC` or `Europe/Warsaw`)
and authenticated execution API must already be configured. Do not infer the
environment from the socket port. Qualifying the source does not enable trading.

## Private configuration and qualification

Create an operator-controlled directory with mode `0700`. Files read by the CLI
or service must be regular, nonsymlink files with mode `0600`; their containing
directory must have mode `0700`. Use absolute, canonical paths. Do not commit
account IDs, captures or host-setting evidence.

The source settings file is strict JSON with these fields:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `1` |
| `sourceKind` | `ibkr-tws-seven-day-v1` |
| `environment` | `paper` |
| `accountId` | Actual allowlisted Paper account |
| `endpoint` | Object containing the actual execution `host` and integer `port` |
| `sourceClientId` | `0` |
| `executionTimeZone` | Actual broker execution timestamp timezone, matching execution configuration |

Set `EXECUTION_ACCOUNTING_SOURCE_PATH` to this file and
`EXECUTION_ACCOUNTING_SOURCE_SHA256` to the SHA-256 of its exact bytes. A Docker
deployment needs an explicit read-only bind mount for the private directory, with
the path expressed inside the container. Do not bake this directory into an image
or loosen its permissions to bypass validation. Adopt migration
`000027_broker_accounting_source.sql` through the existing reviewed migration and
backup procedure before starting the disabled service.

With a valid API token in the process environment, the operator commands are:

```sh
pnpm --filter @ikbr/execution-engine accounting:source status
pnpm --filter @ikbr/execution-engine accounting:source inspect --out /absolute/private/inspection.json
pnpm --filter @ikbr/execution-engine accounting:source qualify --input /absolute/private/qualification.json --evidence-dir /absolute/private
pnpm --filter @ikbr/execution-engine accounting:source invalidate --reason "TWS settings changed"
```

The CLI defaults to `http://127.0.0.1:3103`. Set
`EXECUTION_ACCOUNTING_API_URL` for another endpoint; nonloopback endpoints require
HTTPS. It refuses redirects. `inspect` writes a new private file and does not
overwrite an existing receipt. All commands use the service's accounting socket;
the CLI must not open a competing client-0 connection.

Prepare the qualification JSON from actual host evidence and the latest
inspection ID. The strict fields are defined by `qualificationSchema` in
`apps/execution-engine/src/accounting/config.ts`. Record the actual operator,
observation time, TWS product version/build, seven-day retrieval, Master 0,
execution timezone and the exact settings-file digest. The four evidence kinds
are `tws-product-build`, `tws-trade-log-seven-days`, `tws-master-client-zero` and
`execution-timezone`. Each references a relative PNG, JPEG or UTF-8 text path,
its exact SHA-256 and observation time. Each file is bounded at 5 MiB, total
20 MiB. The CLI validates local bytes; the server receives metadata and digests,
not arbitrary filesystem paths to read.

Observe the settings and submit qualification within 30 minutes. Confirmations
must reflect the real endpoint/account and current host session, unchanged
settings, and the operator's commitment to pause and requalify before settings
changes. Do not create a positive record from this runbook or sample values.
Historical executions are useful corroboration; an empty account needs no test
trade to fabricate that evidence. Qualification requires entries to be paused.

## Freshness and recovery

A settings qualification expires after seven days. Revoke it immediately on any
account, host, build, Master ID, retrieval-window or execution-timezone change.
Revocation is available while the bot runs and immediately prevents further
entries. It does not cancel protection or close positions.

Every entry independently requires a fresh complete replay, broker-clock anchor,
execution/account identity and finite matching commissions and realized P&L.
Settings qualification is not a seven-day trading-data cache. Reconnect, restart
or day rollover requires fresh full replay and a new capture; an unexpired
unchanged settings qualification can be reused. Missing fees and IBKR unset
sentinels are never treated as zero.

New execution or fee callbacks prevent admission before their persistence has
completed. Exact persisted replay duplicates do not change economic state.
Corrections, contradictory records, buffer overflow and failed persistence retain
holds. Neither restarting nor deleting local rows resolves a durable accounting
contradiction. Keep source observations and qualification history for audit.

For a durable `ACCOUNTING_CLOCK_INVALID` alone, use the authenticated recovery
command with `TRADING_ENABLED=false` and effective entries paused:

```sh
pnpm --filter @ikbr/execution-engine accounting:source -- recover-clock --out /absolute/private/clock-recovery.json
```

The output directory must have mode 0700; the command creates a new mode-0600
file and refuses existing files or symlink paths. It never changes trading switches.
Recovery retires the accounting socket, verifies a fresh connection and clock, and
completes the existing execution/commission replay. It atomically records the
recovery receipt and clears only the clock hold. Qualification identity and expiry
remain unchanged; a missing qualification remains missing. The source retains its
gap and needs a subsequent joined reconciliation capture before entry admission.

Recovery refuses non-clock holds, persistence problems, missing costs and retained
contradictions, including failures that an older clock update may have overwritten.
Restart or a good clock callback alone cannot clear the hold. A failed recovery
retires its attempted connection; another explicit attempt needs fresh evidence.
Rejected clock diagnostics are retained without inventing missing values from
older failures. Fix settings and obtain fresh operator qualification evidence if
settings changed. This command does not resolve execution corrections or retry orders.

`status` reports the current hold, qualification expiry, pending persistence and
capture identity. A qualified source can still be held by stale broker evidence,
incomplete reconciliation or other entry requirements. Healthy source status does
not establish research coverage, an AI approval, a strategy signal or permission
to trade. The supervised entry and exit still follow the selected
[AAPL](AAPL_PAPER_ROUND_TRIP.md) or [GPW](GPW_PAPER_ROUND_TRIP.md) runbook and current PP7 gates.
