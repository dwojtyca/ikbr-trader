import type { ResearchManifest, ResearchSnapshot, TwoSourceResearchManifest, TwoSourceResearchSnapshot } from "./types.js";
import type { ResearchRole } from "./repair.js";

export function isTwoSourceResearch(value: ResearchManifest): value is TwoSourceResearchManifest;
export function isTwoSourceResearch(value: ResearchSnapshot): value is TwoSourceResearchSnapshot;
export function isTwoSourceResearch(value: ResearchManifest | ResearchSnapshot): value is TwoSourceResearchManifest | TwoSourceResearchSnapshot;
export function isTwoSourceResearch(value: ResearchManifest | ResearchSnapshot): value is TwoSourceResearchManifest | TwoSourceResearchSnapshot {
  return "researchPolicy" in value && value.researchPolicy === "TWO_SOURCE_HOURLY_V1";
}
export function researchRequiredRoles(manifest: ResearchManifest): readonly ResearchRole[] {
  return isTwoSourceResearch(manifest) ? ["news", "calendar"] : ["reports", "news", "calendar"];
}
