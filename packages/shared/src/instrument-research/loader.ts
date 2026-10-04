import { readFileSync } from "node:fs";
import type { LoadedTradingConfiguration } from "../trading-configuration/loader.js";
import { parseResearchManifest, researchAssert, researchHash } from "./validation.js";
import type { ResearchManifestV1 } from "./types.js";

export function loadResearchManifest(env: Readonly<Record<string, string | undefined>>, loaded: LoadedTradingConfiguration): { manifest: ResearchManifestV1; hash: string; manifestHash: string } | null {
  const path = env.RESEARCH_CONFIG_PATH, hash = env.RESEARCH_CONFIG_EXPECTED_HASH;
  if (!path && !hash) return null;
  researchAssert(path && hash && loaded.mode === "bundle", "RESEARCH_CONFIGURATION_REQUIRED");
  const manifest = parseResearchManifest(JSON.parse(readFileSync(path, "utf8")), loaded.configuration, loaded.effectiveHash);
  researchAssert(researchHash(manifest) === hash, "RESEARCH_MANIFEST_HASH_MISMATCH");
  return { manifest, hash, manifestHash: hash };
}
export const loadResearchConfiguration = loadResearchManifest;
