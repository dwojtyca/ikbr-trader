# PP0 — operator security delivery report

Date: 2026-09-28. Baseline: `ff013988259ca4094d0fc7c7b557cdd7b25bf9cd`.
Status: implementation and independent hostile review accepted; all local delivery
checks passed. Commit/push and exact-commit CI are the remaining publication gates.
Scope: [accepted bounded plan](PP0_IMPLEMENTATION_PLAN.md),
[PP0 delivery specification](PAPER_PRODUCTION_DELIVERY_PLAN.md#4-pp0--operational-security-and-usable-controls),
[operator runbook](../../runbooks/OPERATOR_SECURITY.md).

## Result and boundaries

PP0 protects the existing operator surface: separate browser authentication before
server-side Bearer delegation, authenticated backend mutations, loopback host
publication and the supported bound evaluation action. It does not implement PP1,
change strategy/risk/order behavior, migrate a database or activate/deploy trading.
No broker writes, operational service restarts, paid provider calls or real alert
recipients are part of this implementation's verification.

The independent plan review reproduced two defects that define required regressions:
Fastify resolves encoded route aliases before handler execution, so mutation-bearing
GET/HEAD authorization must use matched route identity; execution's old padded/XOR
comparison accepted a shortened wrong token for one suffix/length combination.
The plan was amended to fix both while retaining existing execution audit and
account/write guards. Independent RA accepted the revised plan with SHA256
`27e3fb02f1678b7281cfcbf8c9f6833f0b30d99deaa16b29c78030cf99ae97f8`
(before its status-only acceptance annotation).

A subsequent narrow amendment was independently accepted at plan SHA256
`358448c08379d79ae921d1f021e609fa84b2217860b0248f014007298721503d`:
native application listeners must also default to loopback, with explicit
container overrides; Vite editor GET/HEAD routes are denied; incomplete request
bodies have a bounded wait. These refine PP0's existing network/resource boundary.

## Verification evidence

The independent implementation reviewer accepted the frozen source and document
content after four findings were repaired: UUID correlation-header credential echo
(P1), escaped JSON credential echo (P1), default Fastify 404/parser log disclosure
(P2) and comma-token startup inconsistency (P2). Lead/implementation review also
closed the empty-JSON client request mismatch and Vite overwriting no-store headers.
The reviewer independently ran 9 targeted tests and checked 200 local file links.

Targeted implementation evidence: proxy fixtures 6/6, backend auth fixtures 29/29,
UI behavior/render fixtures 4/4, native configuration/Compose fixtures 5/5. The proxy
fixtures run both real Vite modes through the actual UI request helper and Fastify
trading-loop route, preserve the Paper guard rejection, and reject unauthenticated
or confused requests before upstream effects. The protected-research rejection and
existing execution guard suites remain enforced. New credentials never reach the
frontend through request delegation, redirects, response headers or decoded JSON.

All local gates passed against a clean export of baseline plus the reviewed PP0
files, excluding the pre-existing ES/signal work and private `.env`:

| Command / check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS: 2,481 passed, 52 database-dependent skips; zero failures |
| `pnpm test:integration` | PASS: 2,042 passed, zero failures/skips on isolated PostgreSQL |
| `pnpm build` | PASS; built UI has no raw or Base64 synthetic credential sentinels |
| `docker buildx build --load --no-cache -t ikbr-trader-pp0:verify .` | PASS on isolated daemon; final image `sha256:8da3d312d958f6b97ff2f4978095f53f94ead50b3504708e22ce09cd993aba81` |
| `git diff --check` and unrelated-file preservation | PASS before publication |

Unit suite passes by package: shared438, verifier163, llm48, execution1,130,
ingestion102, UI10, signal485, backtest105. Unit-only database skips are covered by
the standard integration chain: execution1,418, backtest18, llm13, ingestion106,
signal487. Local logs are `/tmp/pp0-check-{lint,typecheck,test,build}.log`,
`/tmp/pp0-check-integration-container.log` and
`/tmp/pp0-check-docker-build-final.log`; the bundle scan is retained in
`/tmp/pp0-check-sentinel.log`. These temporary paths are not durable CI
artifacts. Strategy/backtest replay is not required: PP0 changes no strategy or
simulator behavior. Unrelated local ES diagnostics are not shipped functionality.

The first sandboxed unit attempt could not open local fixture sockets and was
interrupted. The permitted full run exposed a successful proxy request exceeding
the fixture's artificial100ms deadline under parallel scheduling. A increased
only that test deadline to5s, RA independently accepted the change, and the full
unit rerun passed. Production30s limits and timeout/no-retry assertions are unchanged.

The first host-to-VM integration attempt had six ownership-fixture failures:
PostgreSQL timestamps were39–40ms ahead of host time in three measured samples,
so the existing future-snapshot rejection correctly blocked the fixtures. The
later retained samples in `/tmp/pp0-clock-samples.json` confirm31–33ms skew at
12:47UTC; the skew changes over time. The
standard integration command then passed in the clean application image sharing
the isolated PostgreSQL guest clock and network namespace. No freshness guard,
production behavior or integration assertion was relaxed. The subsequent clean
Docker rebuild includes the accepted test-only deadline change; later documentation
updates do not alter the tested runtime. Both Docker builds passed.

Available command wall-time estimates from the mechanical worker's execution
sessions: install1.4s, lint1.3s, typecheck6.8s, final unit33.0s, container
integration52.8s, build4.0s and the final clean Docker build23.3s. These are
approximate command times, not total package/agent time; failed attempts and
reviews are not silently counted as zero. Per-agent elapsed/token telemetry is
unavailable.

Integration uses a fresh PostgreSQL 16 container `pp0-postgres` in a dedicated
Colima profile `pp0-verification`, with host port 55439 bound to 127.0.0.1 and database
`ikbr_trader_pp0_test`. No operational database is used. Frozen research variables
remain unset. The default Docker context was not switched and the operational
Docker Desktop was not started. A stalled Desktop credential-helper pull was
terminated; the isolated build client uses an empty temporary Docker configuration
to fetch public images. This changes no user credentials.

Host toolchain: Node24.4.1 and declared pnpm9.5.0. The Docker build/integration
image uses Node24.20.0 and pnpm9.5.0; PostgreSQL16 is isolated from operational data.
Baseline GitHub CI was successful
for `ff013988259ca4094d0fc7c7b557cdd7b25bf9cd`
([run36417298276](https://github.com/dwojtyca/ikbr-trader/actions/runs/36417298276));
this is baseline evidence only, not the PP0 publication gate.

## Dependency assessment

The refreshed full baseline audit found 24 advisory entries: 14 high, 8 moderate and
2 low, with none critical. Resolved remediation: Fastify 5.12.1 in all four backend
manifests, Vite 6.4.3, PostCSS 8.5.28, UI esbuild 0.25.12 and PostCSS's transitive
nanoid 3.3.19. Existing broker libraries,
React major, TypeScript major, pnpm and root Fastify transitive overrides remain
outside this update. The resulting production audit has zero findings. The full
audit retains 11 entries (9 distinct GHSA IDs): 8 high, 1 moderate and 2 low.
Repeated dependency paths are not counted as separate vulnerabilities. Compose
installs development dependencies and runs Vite, so a production-only audit is
not sufficient evidence about the deployed surface.

The Fastify advisories concern
[root primitive schema coercion](https://github.com/fastify/fastify/security/advisories/GHSA-w2qp-rph6-63g4)
and [trustProxy header spoofing](https://github.com/fastify/fastify/security/advisories/GHSA-3m5p-2c4r-xxw2).
Inspected application factories did not enable either triggering configuration;
the update still removes the advised versions. Compose serves the UI with Vite,
so its [source-map path traversal](https://github.com/vitejs/vite/security/advisories/GHSA-4w7w-66w2-5vf9)
is relevant to the deployed surface. Audit totals alone do not establish exposure
or a complete security assessment.

| Remaining dependency | Exposure and limit of remediation |
| --- | --- |
| `esbuild 0.27.7` via `tsx 4.21.0` | Windows development-server file-read advisory; no esbuild `serve` use found. Verification host is macOS and deployment image Linux. Vite's own esbuild is patched. |
| `@babel/core 7.29.0` via UI React plugin | Source-map file read requires attacker-controlled transform input. Repository JS is trusted and Vite access is authenticated; authenticated transform tooling remains exposed, so this is retained risk rather than a claim of no exposure. |
| `browserslist 4.28.2`, `baseline-browser-mapping 2.10.19` via Babel | Malicious queries/stats/input can cause failures or resource exhaustion. Current inputs are repository build configuration; no operator API accepts these parameters. |
| `brace-expansion 1.1.16/5.0.7` via ESLint/typescript-eslint | Brace-expansion resource exhaustion in lint globs/configuration; no operational route uses these packages. |
| `js-yaml 4.3.0` via ESLint | CPU exhaustion with hostile YAML; repository lint configuration is the relevant input, not an HTTP body. |

The package did not broadly upgrade lint/transform toolchains to remove these
totals. Reassess before accepting untrusted repository source/configuration or
Windows development-server use. Audit JSON was retained locally for review.

## Routing and review record

| Work | Requested / actual model and effort | Acceptance / rework | Time and tokens |
| --- | --- | --- | --- |
| PP0-A design and critical implementation | `gpt-6-astra/high` selected | Accepted; 2 initial plan findings and 4 hostile findings repaired; native amendment separately reviewed; logger type integration and one fixture deadline repaired, no model promotion | Instrumented elapsed/tokens unavailable |
| Independent plan review | `gpt-6-astra/high` selected | ACCEPT after 2 findings resolved; reviewer authored no changes | Elapsed/tokens unavailable |
| PP0-B UI implementation | `gpt-6-luna/medium` selected | Targeted UI tests/typecheck pass; 2 focused repair rounds, no promotion | Elapsed/tokens unavailable |
| PP0-C dependencies and Compose | `gpt-6-sol/medium` selected | Targeted checks pass; 0 ordinary repair rounds; 1 escalation to A for logger integration typing | Elapsed/tokens unavailable |
| Lead integration and documentation | Capable lead | Scope integration and document review accepted; local work preservation verified | Runtime model/token telemetry unavailable |
| Independent hostile implementation review | `gpt-6-astra/high` selected | ACCEPT; 4 findings resolved; distinct from plan reviewer and implementers | Elapsed/tokens unavailable |
| Mechanical checks/publication | M requested `gpt-5.6-luna/low`; selected fallback `gpt-6-luna/low` | All local gates passed; two validation failures escalated to lead/A, no worker source repairs; publication pending | Elapsed/tokens unavailable |

Selections above are the exact requested/accepted dispatch settings. Tools do not
report a separate runtime model identifier or token counters, so those actual
runtime fields remain unavailable. The UI repairs fixed a JSX test-runtime issue
and then a lead-discovered empty-JSON request mismatch. The latter is covered by
client assertions and a real proxy/Fastify fixture, not only mocked fetch results.
The requested M model was not exposed by the delegation tool. The documented
available-Luna fallback was disclosed before dispatch; critical reviews stayed on
the requested Astra route.

The PP1-B schema pilot was not started. No token savings percentage or model quality
claim is inferred from this package. Telemetry missing from tools is unavailable,
not zero. Dependency installation, fixtures and isolated tests never authorize a
broker/provider retry or operational change.

## Publication and rollback

Preserve all 25 pre-existing dirty files captured at task start. For the already
modified backtest manifest, stage only the reviewed Fastify dependency change;
retain the local ES diagnostic scripts. Preserve dirty signal-engine and simulator
files byte-for-byte. No blanket staging or branch/PR creation is permitted.

Publication remains pending scoped commit/push on main and successful GitHub CI
for that exact commit. The implementation commit's immutable SHA/run URL will be
recorded in a documentation follow-up after its CI succeeds; that follow-up also
requires successful exact-commit CI. Baseline success is not substituted.

No schema rollback is needed. Keep authentication and loopback restrictions during
rollback; an older unprotected UI must remain unpublished/stopped. Existing broker
protection, ownership and unknown outcomes retain their original handling. See the
runbook for credential rotation and separately authorized disabled deployment.
