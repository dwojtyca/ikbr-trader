import type { StrategyInstanceAttributionV1 } from "@ikbr/shared";

export function formatStrategyAttribution(attribution?: StrategyInstanceAttributionV1 | null): string {
  if (!attribution) return "Legacy · attribution unavailable";
  return `${attribution.implementationId} · ${attribution.instanceId} · revision ${attribution.instanceRevision} · ${attribution.instanceHash.slice(0, 12)} · config ${attribution.effectiveConfigHash.slice(0, 12)}`;
}
