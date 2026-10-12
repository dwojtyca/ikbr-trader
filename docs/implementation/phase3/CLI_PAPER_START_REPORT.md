# Explicit Paper CLI startup — delivery evidence

Date: 2026-10-12. Baseline: `fe7f975`. Independent implementation review is
accepted; local validation, clean Docker build and installed-profile validation
passed. Publication evidence is recorded separately for the exact pushed commit.

The owner requested one manual command that connects to Paper, fills known data
gaps, checks safeguards and starts continuous operation. The
[accepted plan](CLI_PAPER_START_PLAN.md) and
[independent plan review](CLI_PAPER_START_PLAN_REVIEW.md) define this package.
The operating instructions are in [the runbook](../../runbooks/CONTINUOUS_PAPER.md).

## Implementation boundary

Explicit startup prepares research under an audited durable pause and then uses
the existing guarded resume path. Revision comparison prevents an older startup
from overriding a newer operator pause. Existing proposal, AI, risk, reconciliation,
research eligibility and provider budget rules remain applicable. Startup does
not create a trading signal or renew expired source/accounting evidence.

The terminal interface provides start, stop, status and logs. A private release
proof binds the approved local Compose configuration, image and mounted files.
Start cannot rebuild, pull or silently accept configuration changes. Stop can
pause entries even when the startup proof is stale, and retains execution and
ingestion for exit supervision. Secrets and private operational files are excluded
from Git and Docker build context.

The stable Redis YAML override preserves the existing `!reset []` removal of its
published port. It is a third pinned Compose input because ordinary JSON merge
cannot express that reset; trading semantics are unchanged.

## Routing and reviews

| Work | Requested route | Evidence |
| --- | --- | --- |
| Critical contract and execution implementation | gpt-6-astra / high | `cli_start_core` |
| Independent critical plan review | gpt-6-astra / high | `cli_start_plan_review`, accepted after bounded corrections |
| CLI helpers and packaging under the fixed contract | gpt-6-luna / medium | `cli_start_packaging` |
| Mechanical validation and release preparation | gpt-6-luna / low | `cli_start_checks`; gpt-5.6-luna unavailable in the model selector |
| Independent final implementation review | gpt-6-astra / high | `cli_start_final_review`, accepted after critical fixes |

The CLI received one coherent integration repair pass, then escalated to the
critical implementer after review found cross-process stop/start and unknown-resume
races. Passing mocked CLI tests did not cover these cases and was not accepted as
release readiness. The correction added specific race fixtures and passed renewed independent
implementation review.

Requested model settings are recorded above. Runtime model telemetry and token
usage are unavailable. The [final review](CLI_PAPER_START_IMPLEMENTATION_REVIEW.md) records the concrete
findings and fixes. There was one critical escalation from Luna to Astra, one
consolidated critical repair and two bounded follow-up fixes for bootstrap state
and malformed control responses. Core implementation took approximately ten
minutes; exact per-agent elapsed telemetry is unavailable.

## Validation and operational state

Focused verification passed: 31 CLI fixtures, five execution/control route unit
tests and eight isolated PostgreSQL tests, plus targeted typecheck/lint. The final
reviewer independently reran the CLI and core unit checks. The CLI tests include
actual HTTP origin routing, delayed account readiness, stop before startup pause,
late resume after interruption, concurrent stop/resume, stale profile, symlinks,
unknown responses and finite transport bounds.

The first full integration run found an existing recurring-session fixture that
extended its calendar with `Date.now() + 2h`, crossing the Warsaw account-day
boundary at the actual test time. Production correctly returned
`paper_budget_session_interval_invalid`. A separately reviewed test-only repair
uses the already-valid fixture end to exercise both shortening and genuine
extension beyond the original bound cutoff. All original assertions remain; the
entire five-test PostgreSQL file passes. This does not make the older real-time
fixture family independent of all midnight boundaries.

Full local validation passed in the clean snapshot:

| Check | Result |
| --- | --- |
| `pnpm lint` | Exit 0 |
| `pnpm typecheck` | Exit 0 |
| `pnpm test` | Exit 0 |
| `pnpm test:integration` | Exit 0, including the repaired fixture |
| `pnpm build` | Exit 0 |

The runner followed CI environment scope: only integration received
`TEST_POSTGRES_URL`, pointing at the dedicated PostgreSQL server on port 55432.
The final integration log's last package summary reports 547 passing tests across
97 suites; that is not an aggregate count for the whole monorepo. Validation logs
are retained privately in `/private/tmp/cli-paper-start-validation-20261012-logs`.
A clean `docker build --no-cache` from the reviewed source snapshot passed.
Image: `sha256:5e923ed6796da2f458b2f236298b69aec1ce20120a7495b45c919b30cf7dc407`.
The stable private profile pins that image, and `pnpm paper:runtime check` passed
against the actual local files and rendered Compose configuration. Its proof
covers 23 files, including all 18 unchanged accounting files. No service was
started to perform this check.

The private signal allowlist was made explicit as `pko_wse,aapl_nasdaq`, derived
from the approved bundle's entry-enabled instruments. The configured loop treats
an empty filter as all bundle instruments; this alignment preserves the existing
instrument scope rather than adding an instrument. Strategy/research content,
canonical identities, risk limits and expiry were not changed.

Commit SHA, exact GitHub CI URL/conclusion and publication time are recorded after
publication in the ignored `.local/paper-runtime/delivery.json` receipt and the
owner's delivery message. Passing local checks alone is not recorded as CI success.
The clean validation source excludes unrelated backtest diagnostics and the
unrelated local `signal-engine.ts` edit. No strategy/simulator behavior is changed.

The owner-stopped operational bot remains stopped during implementation. Private
configuration copies preserve source bytes, policy identity, limits and expiry.
Neither tests nor the CLI feature demonstrate a real broker entry or round trip.
Current source/accounting approval expiry is 2026-10-14T21:48:23Z; this package does
not extend it. Missing/stale supported data can be fetched, while expired rights
remain an explicit hold.
