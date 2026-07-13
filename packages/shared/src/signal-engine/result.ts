import type { DecisionResult } from "../decision-engine/types.js";
import type { RiskEvaluation } from "../risk-engine/types.js";
import type { PipelineOutcome } from "./pipeline.js";
import type { SignalStatus } from "./types.js";

/**
 * Terminal-status resolver. Rules — evaluated in this exact order:
 *
 *   1. `errored`                → ERROR
 *   2. decision has blockers    → BLOCKED
 *   3. decision action = HOLD   → HOLD
 *   4. risk.approved = false    → REJECTED
 *   5. otherwise                → GENERATED
 *
 * The ordering matches the spec: ERROR beats everything (short-
 * circuits the pipeline), BLOCKED beats HOLD (a blocked decision is
 * always HOLD under the hood, but the reason is a hard failure, not
 * a lack of conviction), REJECTED comes from risk, GENERATED is the
 * only happy path.
 */
export function deriveSignalStatus(outcome: PipelineOutcome): SignalStatus {
  if (outcome.errored) return "ERROR";
  const decision = outcome.decision;
  if (!decision) return "ERROR"; // defensive: errored=false but no decision
  if (decision.blockedBy.length > 0) return "BLOCKED";
  if (decision.action === "HOLD") return "HOLD";
  if (outcome.risk && !outcome.risk.approved) return "REJECTED";
  return "GENERATED";
}

/**
 * Human-readable, single-line explanation. Aimed at operator UIs and
 * structured logs — not at end-users. Deliberately terse.
 */
export function summarizeReason(
  status: SignalStatus,
  outcome: PipelineOutcome,
): string {
  switch (status) {
    case "ERROR": {
      const first = outcome.warnings[0];
      return first ? `ERROR — ${first.message}` : "ERROR — pipeline failure";
    }
    case "BLOCKED":
      return `BLOCKED — ${listBlockerCodes(outcome.decision)}`;
    case "HOLD":
      return `HOLD — ${describeHold(outcome.decision)}`;
    case "REJECTED":
      return `REJECTED — ${listRejectionCodes(outcome.risk)}`;
    case "GENERATED":
      return describeGenerated(outcome.decision, outcome.risk);
  }
}

function listBlockerCodes(decision: DecisionResult | null): string {
  if (!decision || decision.blockedBy.length === 0) return "no blockers";
  return decision.blockedBy.map((b) => b.code).join(", ");
}

function describeHold(decision: DecisionResult | null): string {
  if (!decision) return "no decision";
  return `score ${decision.overallScore}, confidence ${decision.confidence}`;
}

function listRejectionCodes(risk: RiskEvaluation | null): string {
  if (!risk || risk.blockers.length === 0) return "risk rejected";
  return risk.blockers.map((b) => b.code).join(", ");
}

function describeGenerated(
  decision: DecisionResult | null,
  risk: RiskEvaluation | null,
): string {
  if (!decision) return "GENERATED";
  const risky = risk ? `, riskScore ${risk.riskScore}` : "";
  return `GENERATED — ${decision.action} (confidence ${decision.confidence}${risky})`;
}

/**
 * Cycle-safe deep-freeze. Duplicated from `market-context/builder.ts`,
 * `decision-engine/evaluator.ts` and `risk-engine/evaluator.ts` on
 * purpose — see architectural TODOs in each of those files for the
 * planned extraction into a shared utility.
 */
export function deepFreezeSignal<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node as Record<string, unknown>)) {
      walk(child);
    }
    if (!Object.isFrozen(node)) {
      Object.freeze(node);
    }
  };
  walk(value);
  return value;
}
