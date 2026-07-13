# ROADMAP.md

# AI Trading Platform Roadmap

## Phase 0 - Architecture Baseline
Goal:
- Audit current architecture
- Produce PHASE_0_PLAN.md
- No behavior changes

Exit criteria:
- Architecture documented
- Data flow documented
- Build/lint/test commands verified

---

## Phase 1 - Execution Security
- API authentication
- localhost by default
- Paper/Live verification
- Remove unsafe execution paths
- Disable default market orders

---

## Phase 2 - Reliability
- Idempotency keys
- Submission state machine
- Reconciliation
- Unknown submission handling
- Retry safety

---

## Phase 3 - Order Lifecycle
- Modify orders
- Partial close
- Full close
- Replace workflow
- Position ownership
- Cancel all
- Kill switch

---

## Phase 4 - Instrument Registry
- Replace env watchlist
- Instrument definitions
- Futures roll policy
- Monitoring vs execution flags

---

## Phase 5 - Decision Engine
- Separate AI from execution
- Structured decisions
- Trade thesis
- Risk validation before execution

---

## Phase 6 - Market Context
- DXY
- Yields
- Gold
- Silver
- Platinum
- Copper
- ETF flows
- COT
- Inventories
- Macro calendar
- News

---

## Phase 7 - Operator Dashboard
- Portfolio
- Orders
- Audit
- AI decisions
- Risk
- Reconciliation

---

## Phase 8 - Autonomous Paper Trading
- Advisory mode
- Approval mode
- Autonomous mode
- Shadow mode
- Paper validation

---

## Phase 9 - Live Readiness
- Security review
- Operational review
- Disaster recovery
- Limited live rollout

## Rules

Every phase follows:

1. Create PHASE_X_PLAN.md
2. Wait for approval
3. Implement only that phase
4. Run lint/typecheck/test/build
5. Perform hostile review
6. Create PHASE_X_REPORT.md
7. Stop
