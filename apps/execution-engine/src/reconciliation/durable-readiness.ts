import type { ReconciliationRunHealthInput } from "../readiness.js";
import type { ReconciliationRepository } from "./repository.js";
import { classifyReadiness } from "./gate.js";
export interface ReadinessIdentity { accountId: string | null; generation: number; connected: boolean }
export async function loadDurableReadiness(input: {
  repository: Pick<ReconciliationRepository, "getReadinessEvidence">;
  current: () => ReadinessIdentity; sessionId: string; now: () => Date;
}): Promise<{ lastReconciliationAt: Date | null; reconciliationRunHealth: ReconciliationRunHealthInput }> {
  const deny = (kind: ReconciliationRunHealthInput["kind"]) => ({ lastReconciliationAt: null, reconciliationRunHealth: { kind } });
  const before = { ...input.current() };
  if (!before.accountId || !before.connected) return deny("none_in_session");
  try {
    const evidence = await input.repository.getReadinessEvidence(before.accountId, input.sessionId);
    const after = input.current();
    if (after.accountId !== before.accountId || after.generation !== before.generation || !after.connected) return deny("wrong_session");
    const run = evidence.latest;
    if (run && run.accountId !== before.accountId) return deny("wrong_session");
    const health = classifyReadiness(evidence.running, run, input.sessionId);
    if (health.kind !== "healthy" && health.kind !== "incomplete_recovery") return deny(health.kind);
    const time = run?.completedAt?.getTime();
    if (time === undefined || !Number.isFinite(time) || time > input.now().getTime()) return deny("failed");
    return { lastReconciliationAt: new Date(time), reconciliationRunHealth: health };
  } catch { return deny("failed"); }
}
