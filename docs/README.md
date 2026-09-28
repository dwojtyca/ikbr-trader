# Project documentation

Documentation reconciled 2026-09-28 against the September26 audit of runtime
`6cbd2c7`. This update describes and plans work; it does not implement or activate it.

## Start here

1. [Current project state](implementation/CURRENT_STATE.md): what exists, gaps,
   source pointers and dated broker/test evidence.
2. [Roadmap](implementation/ROADMAP.md): owner-selected sequence for production-style
   **Paper**, initially PKO+AAPL with independent strategy and instrument configuration.
3. [Detailed implementation plan](implementation/phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md):
   PP0–PP7 dependencies, code boundaries, acceptance, migrations, recovery and soak.
4. [Strategy/parameter/instrument contract](architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md):
   reusable named strategy instances selected by separately configured instruments.
5. [Instrument research contract](architecture/INSTRUMENT_RESEARCH_CONTEXT.md):
   company reports/news/earnings, asset-specific evidence and immutable AI context.
6. [Current runtime flow](implementation/phase2/RUNTIME_FLOW.md) and
   [planned production-Paper acceptance](runbooks/PRODUCTION_PAPER_ACCEPTANCE.md).

## Authority and reading rules

Current owner instructions and repository safety/workflow rules apply first.
CURRENT_STATE owns observed facts, ROADMAP owns sequencing and the detailed plan
owns future acceptance. Proposed configuration examples are not current runtime
settings. Historical reports prove only their dated scope; an early blocker may
have been fixed by a later change. Their original "next" steps do not restart ES
research or supersede this queue. No report, test or healthy endpoint authorizes
trading. Live readiness is a separate future decision.

Architecture pages begin with current wiring; historical module specifications
remain below for API/design context. The old entry-only runbook is historical.
PKO/AAPL runbooks describe currently supported **separate supervised** profiles;
they do not provide a generic two-instrument unattended deployment.

## Document inventory

Every versioned document and new document in this change appears below. Frozen
JSON artifacts retain their exact bytes. Historical Markdown receives a scope
notice, not a rewritten experimental outcome. Local drafts are listed separately
and are intentionally unpublished/preserved.

| Document | Status / use |
| --- | --- |
| [README.md](README.md) | Current navigation and complete inventory |
| [adr/ADR-001-execution-security.md](adr/ADR-001-execution-security.md) | Historical decision with current security qualification |
| [architecture/DATABASE_MIGRATIONS.md](architecture/DATABASE_MIGRATIONS.md) | Current wiring plus retained module specification |
| [architecture/DECISION_ENGINE.md](architecture/DECISION_ENGINE.md) | Current wiring plus retained module specification |
| [architecture/EXECUTION_RUNTIME.md](architecture/EXECUTION_RUNTIME.md) | Current wiring plus retained module specification |
| [architecture/EXECUTION_TICKET.md](architecture/EXECUTION_TICKET.md) | Current wiring plus retained module specification |
| [architecture/INSTRUMENT_REGISTRY.md](architecture/INSTRUMENT_REGISTRY.md) | Current wiring plus retained module specification |
| [architecture/INSTRUMENT_RESEARCH_CONTEXT.md](architecture/INSTRUMENT_RESEARCH_CONTEXT.md) | Proposed contract; not implemented |
| [architecture/MARKET_CONTEXT_ENGINE.md](architecture/MARKET_CONTEXT_ENGINE.md) | Current wiring plus retained module specification |
| [architecture/MARKET_DATA_RUNTIME.md](architecture/MARKET_DATA_RUNTIME.md) | Current wiring plus retained module specification |
| [architecture/RECONCILIATION_RUNTIME.md](architecture/RECONCILIATION_RUNTIME.md) | Current wiring plus retained module specification |
| [architecture/RISK_ENGINE.md](architecture/RISK_ENGINE.md) | Current wiring plus retained module specification |
| [architecture/SIGNAL_ENGINE.md](architecture/SIGNAL_ENGINE.md) | Current wiring plus retained module specification |
| [architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md](architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md) | Proposed contract; not implemented |
| [architecture/TRADING_LOOP.md](architecture/TRADING_LOOP.md) | Current wiring plus retained module specification |
| [architecture/TRADING_PIPELINE.md](architecture/TRADING_PIPELINE.md) | Current wiring plus retained module specification |
| [implementation/CURRENT_STATE.md](implementation/CURRENT_STATE.md) | Current implementation and dated evidence |
| [implementation/PHASE_0_PLAN.md](implementation/PHASE_0_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/PHASE_1_PLAN.md](implementation/PHASE_1_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/PHASE_1_REPORT.md](implementation/PHASE_1_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/ROADMAP.md](implementation/ROADMAP.md) | Current delivery sequence |
| [implementation/phase2/CONFIGURATION.md](implementation/phase2/CONFIGURATION.md) | Current runtime reference |
| [implementation/phase2/FAILURE_AND_RECOVERY.md](implementation/phase2/FAILURE_AND_RECOVERY.md) | Current runtime reference |
| [implementation/phase2/PAPER_MECHANICS_DELIVERY.md](implementation/phase2/PAPER_MECHANICS_DELIVERY.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PHASE_2_ROADMAP.md](implementation/phase2/PHASE_2_ROADMAP.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_1_PLAN.md](implementation/phase2/PR15_1_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_1_REPORT.md](implementation/phase2/PR15_1_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_2_PLAN.md](implementation/phase2/PR15_2_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_2_REPORT.md](implementation/phase2/PR15_2_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_3_PLAN.md](implementation/phase2/PR15_3_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_3_REPORT.md](implementation/phase2/PR15_3_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_4_1_PLAN.md](implementation/phase2/PR15_4_1_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_4_1_REPORT.md](implementation/phase2/PR15_4_1_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_4_PLAN.md](implementation/phase2/PR15_4_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_4_REPORT.md](implementation/phase2/PR15_4_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5A_ES_COMPATIBILITY_PLAN.md](implementation/phase2/PR15_5A_ES_COMPATIBILITY_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5A_ES_DECISION_RECORD.md](implementation/phase2/PR15_5A_ES_DECISION_RECORD.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5A_REPORT.md](implementation/phase2/PR15_5A_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5B_FUTURES_BACKTEST_MODEL_PLAN.md](implementation/phase2/PR15_5B_FUTURES_BACKTEST_MODEL_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5B_REPORT.md](implementation/phase2/PR15_5B_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5C_1_IBKR_ACQUISITION_SPEC.json](implementation/phase2/PR15_5C_1_IBKR_ACQUISITION_SPEC.json) | Frozen research artifact; unchanged |
| [implementation/phase2/PR15_5C_1_IBKR_ES_DATA_PLAN.md](implementation/phase2/PR15_5C_1_IBKR_ES_DATA_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5C_1_REPORT.md](implementation/phase2/PR15_5C_1_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5C_REPORT.md](implementation/phase2/PR15_5C_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5C_REPRODUCIBLE_ES_DATASET_PLAN.md](implementation/phase2/PR15_5C_REPRODUCIBLE_ES_DATASET_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_1_ACTIVE_CONTRACT_REMEDIATION_PLAN.md](implementation/phase2/PR15_5D_1_ACTIVE_CONTRACT_REMEDIATION_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_1_STAGE_A_REPORT.md](implementation/phase2/PR15_5D_1_STAGE_A_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_1_STAGE_B_REPORT.md](implementation/phase2/PR15_5D_1_STAGE_B_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_2_BENCHMARK_MANIFEST.json](implementation/phase2/PR15_5D_2_BENCHMARK_MANIFEST.json) | Frozen research artifact; unchanged |
| [implementation/phase2/PR15_5D_2_PERFORMANCE_REMEDIATION_PLAN.md](implementation/phase2/PR15_5D_2_PERFORMANCE_REMEDIATION_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_3_PARALLEL_SCENARIO_WORKERS_PLAN.md](implementation/phase2/PR15_5D_3_PARALLEL_SCENARIO_WORKERS_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_3_PARALLEL_SCENARIO_WORKERS_REPORT.md](implementation/phase2/PR15_5D_3_PARALLEL_SCENARIO_WORKERS_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_3_STAGE_B_REPORT.md](implementation/phase2/PR15_5D_3_STAGE_B_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_ES_COMPATIBILITY_EXPERIMENT_PLAN.md](implementation/phase2/PR15_5D_ES_COMPATIBILITY_EXPERIMENT_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_ES_DECISION_RECORD.md](implementation/phase2/PR15_5D_ES_DECISION_RECORD.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_STAGE_A_REPORT.md](implementation/phase2/PR15_5D_STAGE_A_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5D_STAGE_B_REPORT.md](implementation/phase2/PR15_5D_STAGE_B_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5E_MECHANICAL_BACKTEST_E2E_PLAN.md](implementation/phase2/PR15_5E_MECHANICAL_BACKTEST_E2E_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5E_REPORT.md](implementation/phase2/PR15_5E_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_5_PLAN.md](implementation/phase2/PR15_5_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_6_AI_PROPOSAL_GATE_PLAN.md](implementation/phase2/PR15_6_AI_PROPOSAL_GATE_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_6_AI_PROPOSAL_GATE_REPORT.md](implementation/phase2/PR15_6_AI_PROPOSAL_GATE_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_PLAN.md](implementation/phase2/PR15_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/PR15_REPORT.md](implementation/phase2/PR15_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase2/README.md](implementation/phase2/README.md) | Current runtime reference |
| [implementation/phase2/RUNTIME_FLOW.md](implementation/phase2/RUNTIME_FLOW.md) | Current runtime reference |
| [implementation/phase2/STATE_AND_RECONCILIATION.md](implementation/phase2/STATE_AND_RECONCILIATION.md) | Current runtime reference |
| [implementation/phase2/TESTING_AND_ROLLOUT.md](implementation/phase2/TESTING_AND_ROLLOUT.md) | Current runtime reference |
| [implementation/phase3/AAPL_AI_IDENTITY_PLAN.md](implementation/phase3/AAPL_AI_IDENTITY_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/AAPL_AI_IDENTITY_REPORT.md](implementation/phase3/AAPL_AI_IDENTITY_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/AAPL_MORNING_SESSION_PLAN.md](implementation/phase3/AAPL_MORNING_SESSION_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/AAPL_MORNING_SESSION_REPORT.md](implementation/phase3/AAPL_MORNING_SESSION_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/AAPL_NATIVE_HISTORY_PLAN.md](implementation/phase3/AAPL_NATIVE_HISTORY_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/AAPL_NATIVE_HISTORY_REPORT.md](implementation/phase3/AAPL_NATIVE_HISTORY_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/AAPL_PAPER_PLAN.md](implementation/phase3/AAPL_PAPER_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/AAPL_PAPER_REPORT.md](implementation/phase3/AAPL_PAPER_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/AGENT_WORKFLOW_REFRESH_PLAN.md](implementation/phase3/AGENT_WORKFLOW_REFRESH_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/AGENT_WORKFLOW_REFRESH_REPORT.md](implementation/phase3/AGENT_WORKFLOW_REFRESH_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/CASH_RECONCILIATION_PLAN.md](implementation/phase3/CASH_RECONCILIATION_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/CASH_RECONCILIATION_REPORT.md](implementation/phase3/CASH_RECONCILIATION_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/COMPLETED_ZERO_TOTAL_PLAN.md](implementation/phase3/COMPLETED_ZERO_TOTAL_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/COMPLETED_ZERO_TOTAL_REPORT.md](implementation/phase3/COMPLETED_ZERO_TOTAL_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW1_CURRENCY_RISK_PLAN.md](implementation/phase3/GPW1_CURRENCY_RISK_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW1_CURRENCY_RISK_REPORT.md](implementation/phase3/GPW1_CURRENCY_RISK_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW2A_PLN_LIFECYCLE_PLAN.md](implementation/phase3/GPW2A_PLN_LIFECYCLE_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW2A_PLN_LIFECYCLE_REPORT.md](implementation/phase3/GPW2A_PLN_LIFECYCLE_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW2B_MARKET_RULES_PLAN.md](implementation/phase3/GPW2B_MARKET_RULES_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW2B_MARKET_RULES_REPORT.md](implementation/phase3/GPW2B_MARKET_RULES_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW3_CONTROLLED_WINDOW_PLAN.md](implementation/phase3/GPW3_CONTROLLED_WINDOW_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW3_CONTROLLED_WINDOW_REPORT.md](implementation/phase3/GPW3_CONTROLLED_WINDOW_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_COMPLETED_ORDERS_PLAN.md](implementation/phase3/GPW_COMPLETED_ORDERS_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_COMPLETED_ORDERS_REPORT.md](implementation/phase3/GPW_COMPLETED_ORDERS_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_EXECUTION_TIME_PLAN.md](implementation/phase3/GPW_EXECUTION_TIME_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_EXECUTION_TIME_REPORT.md](implementation/phase3/GPW_EXECUTION_TIME_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_INSTRUMENT_SCOPE_PLAN.md](implementation/phase3/GPW_INSTRUMENT_SCOPE_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_INSTRUMENT_SCOPE_REPORT.md](implementation/phase3/GPW_INSTRUMENT_SCOPE_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_PKO_PROFILE_PLAN.md](implementation/phase3/GPW_PKO_PROFILE_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_PKO_PROFILE_REPORT.md](implementation/phase3/GPW_PKO_PROFILE_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_PREFLIGHT_CLOSURE_PLAN.md](implementation/phase3/GPW_PREFLIGHT_CLOSURE_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_PREFLIGHT_CLOSURE_REPORT.md](implementation/phase3/GPW_PREFLIGHT_CLOSURE_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_PREFLIGHT_DOCKER_PLAN.md](implementation/phase3/GPW_PREFLIGHT_DOCKER_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/GPW_PREFLIGHT_DOCKER_REPORT.md](implementation/phase3/GPW_PREFLIGHT_DOCKER_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/INSTRUMENT_SESSION_READINESS_PLAN.md](implementation/phase3/INSTRUMENT_SESSION_READINESS_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/INSTRUMENT_SESSION_READINESS_REPORT.md](implementation/phase3/INSTRUMENT_SESSION_READINESS_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md](implementation/phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md) | Planned PP0–PP7 implementation; not shipped |
| [implementation/phase3/PAPER_PRODUCTION_DOCUMENTATION_PLAN.md](implementation/phase3/PAPER_PRODUCTION_DOCUMENTATION_PLAN.md) | Current documentation change plan/report |
| [implementation/phase3/PAPER_PRODUCTION_DOCUMENTATION_REPORT.md](implementation/phase3/PAPER_PRODUCTION_DOCUMENTATION_REPORT.md) | Current documentation change plan/report |
| [implementation/phase3/PR16A_OWNERSHIP_PLAN.md](implementation/phase3/PR16A_OWNERSHIP_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/PR16A_OWNERSHIP_REPORT.md](implementation/phase3/PR16A_OWNERSHIP_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/PR16B_FULL_CLOSE_PLAN.md](implementation/phase3/PR16B_FULL_CLOSE_PLAN.md) | Historical scoped plan/report; current queue supersedes ordering |
| [implementation/phase3/PR16B_FULL_CLOSE_REPORT.md](implementation/phase3/PR16B_FULL_CLOSE_REPORT.md) | Historical scoped plan/report; current queue supersedes ordering |
| [runbooks/AAPL_PAPER_ROUND_TRIP.md](runbooks/AAPL_PAPER_ROUND_TRIP.md) | Current narrow operational reference; scope applies |
| [runbooks/GPW_PAPER_ROUND_TRIP.md](runbooks/GPW_PAPER_ROUND_TRIP.md) | Current narrow operational reference; scope applies |
| [runbooks/INSTRUMENT_SESSION_READINESS.md](runbooks/INSTRUMENT_SESSION_READINESS.md) | Current narrow operational reference; scope applies |
| [runbooks/PAPER_ENTRY_E2E.md](runbooks/PAPER_ENTRY_E2E.md) | Historical; do not use to launch |
| [runbooks/PAPER_STACK_VERIFICATION.md](runbooks/PAPER_STACK_VERIFICATION.md) | Current narrow operational reference; scope applies |
| [runbooks/PRODUCTION_PAPER_ACCEPTANCE.md](runbooks/PRODUCTION_PAPER_ACCEPTANCE.md) | Planned runbook; prerequisites not shipped |

## Existing local drafts outside publication

The following files were already untracked. They remain local and unverified; the
published docs do not depend on them. Names are plain text so a clean checkout does
not contain broken links. Their contents are not silently promoted to delivered work.

- `implementation/phase2/PR15_5F_ES_SIGNAL_DIAGNOSTICS_PLAN.md`
- `implementation/phase2/PR15_5F_ES_SIGNAL_DIAGNOSTICS_REPORT.md`
- `implementation/phase2/PROJECT_STATUS_REVIEW_2026_09_23.md`
- `implementation/phase3/OPERATOR_GUIDE_AND_AGENT_ROUTING_PLAN.md`

Local `.DS_Store` OS metadata is also excluded from publication; it is not project documentation.

## Delivery evidence

See the [documentation report](implementation/phase3/PAPER_PRODUCTION_DOCUMENTATION_REPORT.md)
for independent reviews, validation and publication status. Runtime implementation
starts only through separately reviewed PP work packages.
