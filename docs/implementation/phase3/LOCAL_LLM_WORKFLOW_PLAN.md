# Supervised local coding model — bounded plan

Date: 2026-10-07. Baseline: `a7893084e2b7c7344f70e6c205cd8deb4d171a82`.
Status: accepted by independent `gpt-6-astra` / `high` after one correction to
record the owner's selected installed Qwen; no outstanding findings.
Owner requests local-model collaboration,
updated agent/routing instructions and practical model setup, not trading changes.

## Scope and contract

Documentation-only repository delivery plus local LM Studio setup and synthetic
API probes. No production code/configuration, package dependencies or new runtime
bridge. Codex remains the supervisor. First supported mode is proposed edits:
the local model receives a deliberately selected, non-secret task/context through
loopback Chat Completions and returns an edit proposal; it has no execution tools.
Codex validates paths/current contents/scope and independently reviews the proposal
before applying it through its existing patch tool and running reviewed checks.
This supports local-authored edits without claiming autonomous local filesystem
access, built-in external subagents, or MCP installation. A future automatic
executor requires its own reviewed security contract and implementation.

Allowed versioned writes: AGENTS.md; docs/implementation/phase3/MODEL_ROUTING_GUIDE.md;
this plan and LOCAL_LLM_WORKFLOW_REPORT.md in the same directory;
docs/runbooks/LOCAL_LLM_CODING.md; docs/README.md;
docs/implementation/ROADMAP.md; docs/implementation/phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md.
Preserve all pre-existing staged/unstaged/untracked files, including accounting
recovery and ES research. Do not unstage their work or include it in this commit.
Use an explicit-path commit after verifying the reviewed diff; detect changed HEAD
and revalidate scope before publication. No branches, broker/provider/trading
actions, operational DBs, Docker restarts, secrets or bot-model changes.

## Deliverables

1. Add local route LOCAL under Astra/Sol supervision, limited to individually
   scoped noncritical tasks satisfying existing L eligibility. Local is an optional
   pilot, never a silent replacement for required S/A/RS/RA reviews. Existing checks,
   different independent reviewers, scoped publication and exact SHA CI remain.
2. Concrete task packet: current HEAD plus source hashes/dirty-file exclusions,
   active contract precedence, exact editable paths and read context, fixed
   input/output/default/error semantics, acceptance cases, supervisor-run commands,
   one ordinary repair maximum, deadline/output/context limits, return schema.
   Treat old plans/reports as dated evidence. Critical/ambiguous changes escalate.
3. Document Devstral Small 2 24B MLX 4-bit as a candidate, not measured best or
   guaranteed reliable. Inspect installed model identity; disclose actual probe
   model. Owner selected the installed `qwen/qwen3.8-27b` (~16 GB).
   No model download/install is in scope. Verify and report the actual artifact
   and runtime identity before probing. Model boot/HTTP/tool-format
   success is distinct from repository coding acceptance. Use conservative context,
   one loaded model/prediction, explicit loopback, no CORS, bounded timeout, no retries.
4. Runbook for setup, API request/proposal/review/apply cycle, model identity and
   runtime checks, unload/stop and failure handling. Include a worked synthetic
   formatter task with missing values and an out-of-scope/ambiguous task. The model
   requests edits via a declared function; only the supervisor can accept/apply.
   Prompt-only restrictions are not a sandbox. Do not execute emitted shell text.
5. Report exact actual model/artifact/runtime/configuration, probe results, review
   evidence, observed limitations and pending steps honestly. No adoption claim
   before real small task review, unchanged scope and acceptance test evidence.

## Acceptance and validation

- Independent Astra/high plan review before substantive edits; different
   Astra/high final document/workflow review (authorization/tool boundary scope).
- Verify current CLI help and official API/model docs, local links/anchors,
   exact scoped diff/whitespace, preserved dirty/index contents. Docs-only delivery
   needs no unchanged runtime suites; exact published-commit CI still required.
- With owner-selected model, load bounded context, start loopback API, test
   model discovery and a non-executed function-call edit proposal plus escalation.
   Apply only reviewed synthetic output in a private temporary fixture and test
   positive/missing/zero cases. Do not grant local model shell/filesystem/Git access.
- If runtime/download/memory/network prevents probes, retain useful policy and
   setup docs with explicit pending evidence; never claim successful configuration.
- Commit/push only the eight named Markdown files on main and verify exact CI.
  If GitHub access is unavailable, exhaust installed CLI/auth paths without reading
  secrets, report the limitation and do not claim publication/CI success.

## Runtime clarification

Both load interfaces reported 61,696 context despite requesting 8,192.
Report this mismatch; do not claim a working 8k limit. Remaining synthetic probes
use under 1k input tokens, max 2,048 output, one prediction and a 180-second
deadline. Large-context use remains unqualified. UI read access became available
after owner confirmation, but control attempts failed with noWindowsAvailable.
No runtime install/update or manual settings-file edits are in scope.
Unload the session model and stop its server after the probes.

## Review record

Requested plan/final reviewers: different `gpt-6-astra`, reasoning `high`.
Record actual dispatched models, repairs, elapsed time and available usage in report.
