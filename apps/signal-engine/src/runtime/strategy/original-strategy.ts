import type { StrategyInstanceAttributionV1 } from "@ikbr/shared";
import { readStrategyAttributionSnapshot } from "@ikbr/shared/trading-config";
import { createConfiguredStrategy } from "../../strategies/strategy-registry.js";
export async function resolveOriginalStrategy(db: Parameters<typeof readStrategyAttributionSnapshot>[0], attribution: StrategyInstanceAttributionV1) {
  const original = await readStrategyAttributionSnapshot(db, attribution, { requireEnabled:false });
  return createConfiguredStrategy(original.instance);
}
