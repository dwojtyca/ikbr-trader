# Authenticated operator access (PP0)

This runbook describes the PP0 control surface. Its implementation and validation
evidence is in the [PP0 report](../implementation/phase3/PP0_IMPLEMENTATION_REPORT.md).
It does not authorize deployment, provider calls or trading. Use the instrument's
existing acceptance runbook and explicit owner scope before operational actions.

## Local configuration

Keep secrets in the private root `.env`. Configure two different credentials:

- `EXECUTION_API_TOKEN`: the existing shared internal Bearer credential, at least
  32 non-space printable ASCII characters for UI delegation, without commas.
  All four HTTP services consume the same value.
- `UI_OPERATOR_PASSWORD`: a separate operator password, at least 32 printable
  non-space ASCII characters, without a colon. Generate each independently, for example
  using `openssl rand -hex 32`. Never use a `VITE_` variable for either credential.

Set `UI_PUBLIC_ORIGIN=http://127.0.0.1:5173` and open exactly that URL. The browser
asks for username `operator` and the operator password through its native HTTP
Basic authentication dialog. The frontend does not read or store either password
or backend token. The browser may cache Basic credentials until the browser session
ends; this release does not promise a logout button or immediate revocation without
server-side credential rotation. Rotation requires an authorized service restart.

Keep `IBKR_ENVIRONMENT=paper`, `TRADING_ENABLED=false`,
`EXECUTION_RUNTIME_ENABLED=false` and `TRADING_LOOP_ENABLED=false` for a disabled
installation. Disable `LLM_AGENT_ENABLED` when provider use has not been authorized.
Adding credentials does not authorize turning on any of these controls.

The secured UI server refuses missing or invalid credentials; builds require no
real credentials. Development and preview use the same authentication boundary.
Hot module reload and WebSocket forwarding are disabled. Standalone static hosting
of `apps/ui/dist` does not implement this authenticated API proxy.

## Network boundary

Compose publishes all seven host ports on `127.0.0.1` by default: UI 5173,
ingestion 3101, signal 3102, execution 3103, backtest 3104, Postgres 5432 and Redis 6379.
Services still communicate over their internal Docker names and listeners.
`UI_HOST` controls the container listener; it does not set the browser origin or
host-published interface.

For native application processes, `INGESTION_BIND_HOST`, `SIGNAL_BIND_HOST` and
`BACKTEST_BIND_HOST` default to `127.0.0.1`, as does the existing execution bind
setting. Compose explicitly sets the application listeners to `0.0.0.0` inside
its network while keeping published host ports on loopback. A non-loopback native
listener also requires an explicit configuration change.

`HOST_BIND_ADDRESS` explicitly changes host publication. Changing it affects the
database and Redis as well as HTTP services. HTTP authentication does not secure
Postgres or Redis; broad publication requires separate firewall and database/cache
access controls. An SSH tunnel to loopback is the simplest remote operator path.

For non-loopback browser access, terminate TLS at a separately managed trusted
proxy, configure the exact HTTPS `UI_PUBLIC_ORIGIN`, preserve that Host and restrict
direct access to the UI listener. Do not send Basic credentials over plaintext LAN.
The application does not trust client `Forwarded` or `X-Forwarded-*` headers to
choose its origin or grant access. Configuring an HTTPS origin alone does not
install a certificate or encrypt a published HTTP port.

## API use and failures

The UI proxy authenticates every page and API request. Its exact method/path
allowlist exposes only the current dashboard controls. Browser API calls also send
`X-Operator-Request: 1`; writes require the exact configured Origin. This marker is
not a secret. CORS, foreign/null Origin, unsupported paths/methods, path aliases and
API upgrades do not grant delegation. The proxy replaces incoming credentials with
the internal Bearer only after these checks and never follows upstream redirects.

Direct ingestion, signal and backtest mutations require
`Authorization: Bearer $EXECUTION_API_TOKEN`. Signal's GET/HEAD report, strategies
and outcome-summary routes require it too because they synchronize database state.
Execution retains its existing authentication, audit, account, write, AI and risk
guards, including its explicit cancel/reconciliation exemptions. Authentication
does not bypass a disabled write gate. Public direct health/readiness endpoints
retain their existing behavior; they do not establish permission to trade.

For an already authorized ingestion bootstrap, with the private token available
in the operator's shell:

```sh
curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
  http://127.0.0.1:3101/bootstrap
```

Do not paste credentials into URLs, screenshots, reports or shell tracing output.
Direct API clients supply the Bearer; the browser supplies only operator auth.
An empty server token denies mutations even while trading is disabled.

The UI's **Evaluate configured instruments** action calls the bound trading loop
for its server-configured scope. The table's symbol filter does not select the
evaluation scope. Existing proposal, AI and risk checks still apply; an entry may
follow if the deployment has separately been enabled. The retired
`/signals/run-once` and `/signals/on-candle` remain unavailable.

Read the returned cycle and each instrument outcome. `AWAITING_AI`, `PENDING`,
`SKIPPED`, `NOT_SUBMITTED`, `CONFLICT` and `UNKNOWN` are not fills. An empty report
means no instruments were evaluated. A 401 indicates authentication failure; a 403
can indicate a rejected origin/request; a 404/503 can mean runtime unavailable or
a downstream guard. Check the reported reason and current readiness, not a fallback
endpoint. A proxy timeout or lost response leaves a mutation's outcome uncertain;
inspect persisted state and reconciliation before another action. The UI does not
automatically retry a failed mutation.

## Disabled rollout and rollback

PP0 introduces no database migration. For a separately authorized rollout, record
the exact reviewed commit/image, preserve private configuration/backups, apply the
new credentials and loopback publication with entry flags disabled, and verify
authentication and existing downstream gates before considering later packages.
Do not use real orders, alerts or paid calls as security test fixtures.

Rollback must retain the authenticated surface and loopback policy. If the previous
image predates these protections, leave its UI unpublished/stopped and use supported
authenticated direct execution controls until a compatible secure version is
available. Never restore an unauthenticated credential-injecting proxy to regain
convenience. Preserve database ownership and broker protective orders; disabling
entries or reverting an image does not cancel or close them.
