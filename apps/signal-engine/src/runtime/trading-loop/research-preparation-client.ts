import type { ResearchPreparation } from "@ikbr/shared/instrument-research";

export interface ResearchPreparationClient {
  prepare(input: { instrumentId: string; conid: string; effectiveConfigHash: string }): Promise<ResearchPreparation>;
}
export class HttpResearchPreparationClient implements ResearchPreparationClient {
  constructor(private readonly options: { engineUrl: string; bearerToken: string; requestTimeoutMs: number; fetchFn?: typeof fetch }) {}
  async prepare(input: { instrumentId: string; conid: string; effectiveConfigHash: string }): Promise<ResearchPreparation> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const response = await (this.options.fetchFn ?? fetch)(`${this.options.engineUrl.replace(/\/$/, "")}/execution/research/prepare`, {
        method: "POST", headers: { authorization: `Bearer ${this.options.bearerToken}`, "content-type": "application/json" }, body: JSON.stringify(input), signal: controller.signal,
      });
      if (!response.ok) throw new Error("RESEARCH_PREPARATION_UNAVAILABLE");
      const result = await response.json() as ResearchPreparation;
      if (!result || !["READY", "WAITING", "HOLD"].includes(result.state) || !Array.isArray(result.reasons) || result.reasons.length > 100 ||
          result.reasons.some(reason => typeof reason !== "string" || !/^[A-Z][A-Z0-9_]{1,150}$/.test(reason)) ||
          !Array.isArray(result.sources) || (result.snapshotId !== null && typeof result.snapshotId !== "string") ||
          (result.nextCheckAt !== null && (typeof result.nextCheckAt !== "string" || !Number.isFinite(Date.parse(result.nextCheckAt)))) ||
          (result.state === "READY" && (!result.snapshotId || result.reasons.length))) throw new Error("RESEARCH_PREPARATION_INVALID");
      return result;
    } finally { clearTimeout(timer); }
  }
}
