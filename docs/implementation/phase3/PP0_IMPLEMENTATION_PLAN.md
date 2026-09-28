# PP0 implementation plan — authenticated operator surface

Date: 2026-09-28. Baseline: `ff013988259ca4094d0fc7c7b557cdd7b25bf9cd`.
Status: independent Astra plan accepted 2026-09-28; implemented and verified.
Completion evidence: [PP0 report](PP0_IMPLEMENTATION_REPORT.md).
Parent: [Paper production delivery §4](PAPER_PRODUCTION_DELIVERY_PLAN.md#4-pp0--operational-security-and-usable-controls).
Sequencing: [ROADMAP](../ROADMAP.md); evidence baseline: [CURRENT_STATE](../CURRENT_STATE.md).

## Scope and invariants

Implement PP0 only: loopback host publishing, authenticated operator proxy,
authentication on presently unprotected mutation routes, accurate existing UI
runtime action, dependency remediation and delivery evidence. No PP1 configuration
authority, new strategy, broker/AI/risk/proposal semantics, schema migration,
provider call, trading activation or operational restart belongs to this package.
Fixture servers and disposable integration databases are permitted verification.
Work on main; preserve all pre-existing dirty ES/backtest and signal-engine work.

Execution's existing authentication, audit, environment/account/write guards,
AI/proposal checks, cancel exemptions, close and reconciliation authorization remain
authoritative. Browser authorization grants access to existing controls; it does
not grant an exception to any downstream safety gate. No automatic mutation retry.

## Observed route and exposure inventory

All seven published ports currently bind every host interface: Postgres5432,
Redis6379, ingestion3101, signal3102, execution3103, backtest3104 and UI5173.
Internal Docker listeners must remain reachable by sibling services. The UI runs
Vite dev in Compose; its prefix proxy injects execution credentials without caller
authentication. Preview must receive the same protection, not a separate unsafe path.

The following inventory describes backend paths, before the UI `/api/<service>`
prefix. Readiness/health reads remain direct public probes except execution's
existing exact public-path policy. UI API forwarding is separately restricted.

| Service | Method and paths | Existing effect / PP0 boundary |
| --- | --- | --- |
| ingestion | POST `/bootstrap`, `/stop` | Starts broker subscriptions/history or stops them; new shared bearer gate |
| ingestion | GET `/health`, `/backfill-progress`, `/watchlist` | Reads; preserve direct access |
| signal | POST `/signals/outcomes/refresh`, `/signals/strategies/:strategyId` | Database writes; new shared bearer gate |
| signal | GET/implicit HEAD `/signals/outcomes/summary`, `/signals/report`, `/signals/strategies` | Refreshes outcomes/synchronizes strategy state; authenticated as mutation-bearing reads without refactoring behavior |
| signal | POST `/runtime/dry-run` | Evaluation, even though no order/database write; included in new bearer gate |
| signal | POST `/runtime/execute`, `/runtime/trading-loop/run-once` | Existing bearer + Paper/runtime gates retained, covered by global gate too |
| signal | POST `/signals/run-once`, `/signals/on-candle` | Retired; authorized request still gets503 `verified_bound_runtime_required`; never revive |
| signal | GET `/health`, `/signals/recent`, `/runtime/health`, `/runtime/ready`, `/runtime/execute/ready`, `/runtime/trading-loop/status`, `/runtime/trading-loop/ready` | Existing probes/status; no new entry authority |
| execution | POST `/execution/bootstrap`, `/execution/refresh-position-snapshot`, `/execution/alerts/test` | Existing bearer/audit/guards; session, snapshot and alert effects |
| execution | POST `/execution/execute-proposed/:id`, `/execution/reject-proposed/:id`, `/execution/cancel-proposed/:id`, `/execution/execute-ticket` | Existing submission/rejection/cancellation protections unchanged |
| execution | POST `/execution/reconciliation`, `/execution/reconciliation/run`, `/execution/reconciliation/holds/:id/acknowledge`, `/execution/reconciliation/holds/:id/resolve` | Existing auth/guards; resolve also requires its existing independent credential; proxy does not expose these new controls |
| execution | POST `/execution/lifecycle/:id/close`, `/execution/lifecycle/:id/close/reconcile` | Existing supported audited close; no new UI control in PP0 |
| execution | GET `/health`, `/ready`; `/execution/{kill-switch,alerts,account/summary,orders,trades,aapl-window,gpw-window,reconciliation/latest,reconciliation/holds}`, `/execution/instruments/:instrumentId/market-rules`, `/execution/lifecycle/:id`, `/execution/lifecycle/:id/{close,round-trip}` | Existing auth/public-path rules preserved; account/ready reads may refresh evidence and remain governed by their existing policies |
| backtest | POST `/backtest/history`, `/backtest/history/symbols`, `/backtest/history/resume`, `/backtest/run` | Dataset reset/history acquisition/run creation; new bearer gate, preserve research database immutability guard |
| backtest | POST `/backtest/research/es-compatibility`, `/backtest/research/es-compatibility-v2`, `/backtest/research/es-compatibility-v3` | Existing research job creation, capacity/config/identity guards; new bearer gate, no ES implementation edits |
| backtest | GET `/health`, `/backtest/{dataset,runs,report}`, `/backtest/research/es-compatibility{,-v2,-v3}` | Reads; existing worker runs jobs, not an independent HTTP strategy-lab API |

Root mutation hooks cover every non-GET/HEAD/OPTIONS method, including future child
plugins, before handler effects and before validation error details. OPTIONS never
grants CORS. Inventory tests verify route families including child-plugin routes;
the authentication boundary is not a fragile list of only today's POST paths.

## Direct-service authentication contract

Reuse the single `EXECUTION_API_TOKEN` internal credential. Ingestion, signal and
backtest install a shared root `onRequest` hook before route/plugin registration.
Protect all unsafe methods, plus signal's three mutation-bearing GET/HEAD paths.
Classify these GET/HEAD endpoints using Fastify's matched `request.routeOptions.url`
in the root hook, not the raw request pathname. Fastify resolves encoded aliases
such as `/signals/repor%74` to `/signals/report`; query strings and implicit HEAD
must receive exactly the same authorization boundary as that canonical route.
Empty token always denies (401 generic `unauthorized`), even with trading disabled.
Missing, wrong, malformed or duplicate authorization headers deny before effects.
Correct Bearer auth reaches existing handlers and their original rejections.

Extract/reuse the runtime bearer verification into a small Node-only shared auth
subpath, rather than importing a service from another service or shipping crypto
into the browser root export. Comparison uses UTF-8 bytes and timing-safe fixed
digest comparison (with explicit nonempty token validation). Existing runtime
preHandlers delegate to it. Execution's audited auth hooks, verification result
reasons and token fingerprints remain intact, but its comparison primitive must
use this shared byte-safe comparator. Independent review reproduced a credential
collision: configured `"a".repeat(31) + "?"` incorrectly accepts `"a".repeat(31)`
because the existing verifier XORs byte lengths into the final credential byte.
This narrowly scoped auth.ts/auth.test.ts repair is required PP0 credential
correctness, not permission to change execution audit/account/write semantics.
No account/write guard is copied into ingestion or signal; execution remains owner.
Configure/redact request authorization/cookie/proxy-authorization headers in any
new logging and the touched service loggers. Request serializers log route/method
without query strings; userinfo/credentials embedded in malformed URLs must not
reach logs. Never log input credentials, request headers/bodies, backend target
credentials or raw proxy errors.

## Authenticated browser proxy contract

Use an application-owned authenticated reverse proxy integrated into Vite's
`configureServer` and `configurePreviewServer`, installed before built-in proxies
and static middleware. This is the PP0 approved authenticated proxy option, not a
new session service. HTTP Basic uses fixed username `operator` and independent
`UI_OPERATOR_PASSWORD` (minimum32 printable ASCII characters; no colon/newline).
It must differ from `EXECUTION_API_TOKEN`; both must be configured and the backend
token must have minimum32 non-space printable ASCII characters, excluding commas
to match the internal Bearer grammar, for UI delegation. Empty/invalid settings fail
closed at server startup with non-secret error text. Build-only operations do not
require secrets. `.env` credentials are server-only; Vite env loading must never
expose either through `VITE_*`, `define`, HTML replacement or browser modules.

The browser's native Basic challenge collects the operator credential. React does
not read, persist or assemble it. Browser authentication cache is distinct from the
backend execution token, which never reaches a browser. No cookies/session store,
login endpoint, credential URL, password field or frontend storage is introduced.
All UI HTTP paths, assets and proxied reads require operator authentication; Vite's
side-effecting `/__open-in-editor` tooling route and its suffix variants are denied
entirely, including authenticated GET. Generic
401 plus `WWW-Authenticate: Basic realm="IBKR operator", charset="UTF-8"` supplies
the challenge. Wrong credentials cannot cause upstream calls. Authenticated proxy
API errors must not forward an upstream Basic challenge to overwrite browser login.

Use exactly one configured `UI_PUBLIC_ORIGIN`, default `http://127.0.0.1:5173`.
It is a canonical HTTP(S) origin with no userinfo/path/query/fragment/wildcard.
Compare the incoming raw Host to its authority exactly (case-normalized hostname,
explicit configured port), never to request-supplied Forwarded/X-Forwarded headers.
Reject duplicate Host, absolute-form URLs, protocol-relative URLs, backslashes,
encoded path separators, percent-encoded/double-encoded path segments, dot segments,
duplicate slashes, fragments and invalid encodings before route selection/rewrite.
API matching uses the raw pathname plus an explicit method/route allowlist; query
strings cannot select a host/path. Prefix lookalikes and unsupported methods deny.

All React API requests send `X-Operator-Request: 1`; this is a CSRF intent marker,
not an authentication secret. Every proxied API request requires it. If Origin is
present it must equal `UI_PUBLIC_ORIGIN`; unsafe methods require that Origin to be
present. GET/HEAD may omit Origin because browsers do so, but must have the intent
header; any present Sec-Fetch-Site other than `same-origin` is denied for APIs.
Do not emit permissive CORS/preflight responses. Cross-origin Basic-cache requests,
forms, images, navigation to mutation-bearing GET and absent/null/foreign Origin
mutations therefore cannot delegate. Deny framing with frame-ancestors/X-Frame-Options;
use no-referrer, nosniff and no-store. Fetch must not follow an API redirect.

Allowlisted upstreams come only from four server-side `UI_*_PROXY_TARGET` settings,
validated as fixed HTTP(S) origins (no userinfo/path/query/fragment). Do not accept
client-provided targets. Strip browser Authorization, cookies, proxy-authorization,
Forwarded/X-Forwarded, connection/hop headers and arbitrary sensitive headers.
Construct an explicit upstream header set: method/body content type, fixed backend
Bearer and optionally valid existing correlation ID. Inject Bearer for all four
services, only after authentication/CSRF/path/method approval. Do not proxy WS/API
upgrades; disable HMR for the secured server to avoid an unauthenticated upgrade
path. Preview protection must have real HTTP integration coverage.

Upstream redirects are not followed and are converted to generic502, dropping
Location. Strip Set-Cookie, upstream WWW-Authenticate, CORS, server/proxy headers;
return only an explicit safe set (JSON content type/correlation ID). Errors must
not include request headers, target URLs with secrets or backend credentials. If
an upstream response body contains either configured credential, reject it with a
generic502 rather than forwarding a secret echo; inspect the bounded response as
bytes/text without logging it. Credentials never enter upstream query parameters.
Bound body size to1MiB and proxy response size to10MiB; bound body reading and
upstream wait together to30s. Abort slow incomplete bodies by closing their socket.
A timeout is a request failure of unknown mutation outcome; UI never retries it.
Never copy backend auth into redirect or alternate-host requests.

### Exact UI proxy allowlist

Every entry additionally requires operator auth and the CSRF rules above. No broad
prefix forwarding survives. Numeric IDs accept positive decimal integers only;
strategy IDs accept the repository's ASCII alphanumeric/underscore/hyphen IDs.

| Prefix | GET (HEAD may be rejected) | POST |
| --- | --- | --- |
| `/api/ingestion` | `/health`, `/backfill-progress`, `/watchlist` | `/bootstrap`, `/stop` |
| `/api/signal` | `/health`, `/signals/report`, `/signals/strategies`, `/signals/outcomes/summary`, `/signals/recent`, `/runtime/trading-loop/status`, `/runtime/trading-loop/ready` | `/signals/strategies/:strategyId`, `/runtime/trading-loop/run-once` |
| `/api/execution` | `/health`, `/execution/orders`, `/execution/trades`, `/execution/account/summary` | `/execution/bootstrap`, `/execution/execute-proposed/:id`, `/execution/reject-proposed/:id`, `/execution/cancel-proposed/:id` |
| `/api/backtest` | `/backtest/dataset`, `/backtest/runs`, `/backtest/report` | `/backtest/history`, `/backtest/history/resume`, `/backtest/run` |

Retired signal paths are not delegated by UI. Authenticated direct legacy requests
remain503. Other existing operator API workflows continue directly with Bearer;
this does not add close/resolve/execute-ticket/research controls to the browser.

## Loopback and opt-in deployment

Publish each Compose port as `${HOST_BIND_ADDRESS:-127.0.0.1}:port:port`; internal
container hosts remain0.0.0.0 and service DNS targets unchanged. One explicit env
override permits LAN publication; documentation must distinguish it from changing
UI_HOST (container listener). UI_PUBLIC_ORIGIN defaults exactly to the local URL.
Native ingestion/signal/backtest listeners also default to127.0.0.1 using
`INGESTION_BIND_HOST`, `SIGNAL_BIND_HOST`, `BACKTEST_BIND_HOST`; an explicit nonempty
trimmed value opts into another interface. Compose supplies0.0.0.0 for these three
container listeners. Execution already has its own loopback-default bind setting.
Sol owns these new config/default/env plumbing lines; A owns index listen wiring.
Non-loopback operator access requires HTTPS at a separately managed trusted TLS
terminator and an explicit HTTPS UI_PUBLIC_ORIGIN. The terminator preserves the
configured Host and restricts direct UI access; forwarded header identity is never
trusted by this implementation. Do not publish Basic over plaintext LAN. Remote
administration may instead use an SSH tunnel to the default loopback URL.

Changing HOST_BIND_ADDRESS exposes DB/Redis and backend reads too; document firewall
and database/Redis authentication consequences explicitly. No claim that HTTP auth
secures unauthenticated Postgres/Redis. LAN publishing is opt-in, never deployment
automation in this task. Existing `.env` is not edited or printed. Example config
contains empty secret placeholders and disabled trading defaults only.

## PP0-B UI action contract

Replace `POST /api/signal/signals/run-once` with an empty-body
`POST /api/signal/runtime/trading-loop/run-once`. This operates the server-configured
instrument scope; do not send tickers/IDs, fabricate a signal, or imply the table's
symbol filter selects its scope. Label the control `Evaluate configured instruments`
and explain that normal proposal/AI/risk gates apply and entry may follow when
already enabled. Do not add activation controls.

Successful JSON is `{cycleId, startedAt, finishedAt, durationMs, reports}`;
reports contain `{instrumentId, startedAt, finishedAt, durationMs, outcome}` and
outcome has `kind` plus optional `reason`, `message`, `idempotencyKey`. Kinds are
SUBMITTED, DUPLICATE, PENDING, AWAITING_AI, CONFLICT, UNKNOWN, NOT_SUBMITTED,
SKIPPED, ERROR. Display cycle and every instrument's kind/reason/message/key as
text; no generated-count or filled/approved claim. Empty reports explicitly mean
no configured instruments evaluated. UNKNOWN remains visibly unknown. Future or
malformed response data yields an unavailable/error message, never success.
401/403 authentication/origin errors and404/503 unavailable/Paper-guard failures
remain explicit; no fallback to retired routes. Disable action while in flight;
keep errors visible and do not automatically retry. Existing requestJson receives
the fixed intent header for every API call, same-origin credentials and manual/error
redirect behavior. Render text via React escaping. Unit tests exercise request
contract and displayed real outcome distinctions including empty/unknown/failure.

## Dependency exposure and compatibility boundary

Refresh `pnpm audit --prod` and full audit with declared pnpm9.5.0. Known baseline
Fastify5.8.5 advisories concern schema coercion and trustProxy; source inspection
shows no intentional trustProxy enablement, but untrusted route input reaches
Fastify. Auth wrappers do not substitute for patching framework weaknesses.
Approved Fastify target5.12.1 in all four direct service manifests, remaining
within major5. Source presently uses manual Zod parsing rather than root Fastify
body schemas and does not enable trustProxy; this limits the demonstrated advisory
paths but does not justify retaining the vulnerable framework. Record exact
versions and relevant compatibility tests. Existing root overrides must be checked
against that target, not blindly removed. Preserve unrelated backtest manifest
scripts and simulator changes when editing its dependency line.

Do not upgrade broker libraries, React major, TypeScript major, strategy/runtime
business dependencies or pnpm major to improve audit totals. Vite5.4.21 has a network
development-server source-map path traversal advisory (GHSA-4w7w-66w2-5vf9) and
Windows file-denial bypass advisories. Approve the smallest patched maintained
branch target Vite6.4.3, with compatible existing React plugin4.7.0 and its patched
esbuild0.25 dependency, subject to real dev/preview/build tests. Same-range PostCSS
resolution to8.5.23 or newer8.x is allowed to remove parser advisories; no unrelated
broad dependency update. Registry evidence confirms Vite6.4.3 accepts Node24 and
plugin4.7.0 accepts Vite6. This one Vite major
upgrade is within PP0 because Compose runs that network development server with
server-side secrets. Do not widen to Vite7/8 or React/plugin majors. Lead's refreshed
baseline audit has24 entries (14 high,8 moderate,2 low); final evidence must distinguish
production-reachable UI dev tooling from build-only and Windows-only residuals.
Record residual findings with reachability and mitigation, not just totals.
No tests proving stock strategy behavior need rerunning as backtests because PP0
does not change strategy/simulator behavior; dirty ES work is not PP0 validation.

## Ownership, sequence and review gates

1. PP0-A design/security: `gpt-6-astra/high`, this plan and source inspection.
   Different independent RA `gpt-6-astra/high` accepts plan before runtime work.
2. PP0-A implementation owns shared Node auth helper/export/tests, ingestion/signal/
   backtest auth registration and logger redaction/tests, signal runtime bearer
   adapter, execution `auth.ts` comparison primitive and `auth.test.ts` regression,
   `apps/ui/vite.config.ts`, new server-side security/proxy module/tests.
   Never edit dirty `signal-engine.ts` or backtest research/simulator files.
3. PP0-B `gpt-6-luna/medium` owns `apps/ui/src/App.tsx`, bounded UI request/result
   helpers/tests and UI-only rendering; no server auth/credential decisions. It
   starts only after accepted section above and agreed helper import boundaries.
4. PP0-C `gpt-6-sol/medium` owns dependency lines/lockfile, UI test script/tooling
   if needed, Compose port/env plumbing, Docker build compatibility and `.env.example`.
   Exact variables/semantics above are binding; coordinate UI package/tsconfig
   edits with A/B first. New security semantics, major updates or repeated failure
   stop and escalate. One ordinary targeted repair before escalation.
5. Lead integrates, writes security/runbook docs and PP0 report, updates current
   state/roadmap to evidence-based PP0 status only, arranges distinct independent
   hostile RA reviewer (not plan reviewer or any implementer). Fix until accepted.
6. M `gpt-5.6-luna/low` may run specified full checks/publication commands after
   lead supplies reviewed file scope; no blanket staging, force push or repairs.

All workers read AGENTS and relevant cited source, report files, commands/exit codes,
failures, requested/actual model/effort, repairs/escalations, elapsed and exposed
token usage (otherwise unavailable). No git mutation before reviewed publication.

## Acceptance and validation

- Shared auth tests: empty/missing/wrong/malformed/duplicate credentials,
  UTF-8/length collision and correct credential; unsafe methods and mutation-bearing
  GET/HEAD deny without effects, including direct percent-encoded route aliases
  such as `/signals/repor%74`, query suffixes and implicit HEAD. Assert zero handler
  side effects for every unauthenticated alias; authorized aliases retain handler
  behavior. Public probes remain usable; nested backtest and
  runtime routes inherit root gate. Correct credentials retain retired503 and
  immutable-research423/Paper-guard failures.
- Execution comparator regression must reject expected `"a".repeat(31) + "?"`
  versus presented `"a".repeat(31)`, accept the exact correct token, reject different
  UTF-8 byte lengths and padded-prefix/trailing-NUL collisions, and preserve existing
  auth reasons/fingerprints/audit and execution guard tests.
- Real local HTTP fixture tests of both Vite dev and preview: unauthenticated asset
  and API calls, wrong/empty operator configuration, wrong credentials, no/foreign/
  null Origin, missing intent header, cross-site fetch, Host spoofing, Forwarded
  spoofing, raw path confusion/encoded slash/dot/query/absolute target, forbidden
  method, denied WS upgrade, safe upstream header construction and body forwarding.
  Backend fixture records zero calls on every denied request.
- Upstream302 and cookies never escape/follow; hostile upstream error/header content
  cannot leak bearer/operator password. Bound oversized body/response and timeout;
  one backend attempt only. Scan built frontend artifacts for sentinel test secrets.
- Correct operator request reaches stubbed normal bound cycle; render all relevant
  outcome cases, empty report, unknown outcome and HTTP errors. Existing execute/
  cancel integration guard tests retain unauthorized/disabled-write/account behavior.
- Compose config assertions prove all seven default host bindings loopback and
  explicit override behavior while internal DNS/listeners and disabled defaults stay
  unchanged. Do not dump resolved secret-bearing Compose environment in evidence.
  Native listener config tests cover unset127.0.0.1, trimmed explicit override and
  empty/whitespace rejection, and verify each index uses its configured bind host.
  Editor tooling GET/HEAD plus suffix/query stays denied; slow incomplete-body
  fixture closes its socket with zero upstream calls.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` with a dedicated
  disposable PostgreSQL URL, and `pnpm build`; clean Docker build required. No
  TEST_RESEARCH_POSTGRES_URL to an empty fixture, no operational DB fixtures.
- Final reviewed scoped diff, report, commit/push main and GitHub CI for that exact
  SHA. Missing Docker/CI capability is an explicit incomplete gate, never a pass.

## Rollback and operational limits

No migration. Rollback retains loopback exposure, authenticated proxy and backend
mutation gates. If a prior reviewed image predates these protections, keep UI
unpublished/stopped and use authenticated direct execution API until repaired;
never restore naked credential delegation for convenience. Entries remain disabled
in deployment instructions; rolling back source does not authorize a restart or
change existing broker protection. Credential rotation updates private config and
requires browser reauthentication/service reload under separate deployment scope.
PP0 completion is source/security verification, not broker readiness or permission
to trade. No operational mutations or real provider calls are acceptance evidence.
