import { z } from "zod";
import { researchHash, type ValidatedResearchBinding, type ResearchOrderContextV1 } from "@ikbr/shared/instrument-research";
import type { BoundClaim } from "./bound-review-repository.js";

import { RESEARCH_PROMPT_VERSION, RESEARCH_REQUEST_VERSION, RESEARCH_OUTPUT_SCHEMA_VERSION, RESEARCH_SYSTEM_PROMPT, researchWireRequest, validateResearchAiRequest } from "@ikbr/shared/instrument-research";
export { RESEARCH_PROMPT_VERSION, RESEARCH_OUTPUT_SCHEMA_VERSION, RESEARCH_SYSTEM_PROMPT, researchWireRequest };

export interface ResearchModelRequest {
  schemaVersion: typeof RESEARCH_REQUEST_VERSION;
  model: string;
  promptVersion: typeof RESEARCH_PROMPT_VERSION;
  outputSchemaVersion: typeof RESEARCH_OUTPUT_SCHEMA_VERSION;
  maxOutputTokens: number;
  systemPrompt: string;
  providerRequest: Record<string, unknown>;
  context: {
    research: ValidatedResearchBinding;
    orderContext: ResearchOrderContextV1;
    proposal: Record<string, unknown>;
    identity: BoundClaim["identity"];
    indicators: unknown;
  };
}
const outputSchema = z.object({
  decision: z.enum(["EXECUTE", "REJECT"]), confidence: z.number().finite().min(0).max(1),
  reason: z.string().trim().min(3).max(1400),
  riskFlags: z.array(z.string().trim().min(1).max(160)).max(30),
  evidenceRefs: z.array(z.string().min(1).max(200)).max(200),
}).strict();
export type ResearchModelDecision = z.infer<typeof outputSchema>;
export interface ResearchModelResult { decision: ResearchModelDecision; actualModel: string; usage: { inputTokens: number; outputTokens: number } | null }

export function validateResearchModelDecision(raw: unknown, research: ValidatedResearchBinding): ResearchModelDecision {
  const result = outputSchema.parse(raw);
  const available = new Set(research.stored.snapshot.evidence.map(item => item.ref));
  if (new Set(result.evidenceRefs).size !== result.evidenceRefs.length || result.evidenceRefs.some(ref => !available.has(ref)))
    throw new Error("AI_EVIDENCE_REFERENCE_INVALID");
  if (result.decision === "EXECUTE" && research.eligibility.requiredEvidenceRefs.some(ref => !result.evidenceRefs.includes(ref)))
    throw new Error("AI_REQUIRED_EVIDENCE_NOT_CITED");
  return result;
}

export function buildResearchModelRequest(claim: BoundClaim, research: ValidatedResearchBinding, context: ResearchOrderContextV1): ResearchModelRequest {
  const model = research.manifest.model;
  if (model.promptVersion !== RESEARCH_PROMPT_VERSION || model.outputSchemaVersion !== RESEARCH_OUTPUT_SCHEMA_VERSION)
    throw new Error("AI_PROMPT_OR_SCHEMA_UNSUPPORTED");
  const request: ResearchModelRequest = {
    schemaVersion: RESEARCH_REQUEST_VERSION, model: model.model, promptVersion: RESEARCH_PROMPT_VERSION,
    outputSchemaVersion: RESEARCH_OUTPUT_SCHEMA_VERSION, maxOutputTokens: model.maxOutputTokens,
    systemPrompt: RESEARCH_SYSTEM_PROMPT, providerRequest: {},
    context: { research, orderContext: context, proposal: claim.proposalSnapshot ?? { ...claim.order },
      identity: claim.identity, indicators: claim.order.indicators ?? null },
  };
  request.providerRequest = researchWireRequest(request);
  validateResearchAiRequest(request as unknown as Record<string, unknown>, model);
  if (JSON.stringify(request).length > model.maxInputChars) throw new Error("AI_CONTEXT_SIZE_LIMIT");
  // Serialization severs references held by callers before the durable digest is made.
  return JSON.parse(JSON.stringify(request)) as ResearchModelRequest;
}

export class ResearchOpenAiDecider {
  constructor(private readonly options: { apiKey?: string; baseUrl: string }) {}
  isConfigured(): boolean { return Boolean(this.options.apiKey); }
  async decide(request: ResearchModelRequest, signal: AbortSignal): Promise<ResearchModelResult> {
    if (!this.options.apiKey) throw new Error("AI_NOT_CONFIGURED");
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("AI_ENDPOINT_INVALID");
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request.providerRequest),
    });
    if (!response.ok) throw new Error(`AI_HTTP_${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("AI_EMPTY_RESPONSE");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) throw new Error("AI_RESPONSE_SIZE_LIMIT");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown; tool_calls?: unknown } }[];
    };
    const choice = raw.choices?.[0];
    if (raw.choices?.length !== 1 || choice?.finish_reason !== "stop" || choice.message?.refusal || choice.message?.tool_calls ||
        typeof choice.message?.content !== "string" || typeof raw.model !== "string" || !raw.model || raw.model.length > 200)
      throw new Error("AI_OUTPUT_INVALID");
    const decision = validateResearchModelDecision(JSON.parse(choice.message.content), request.context.research);
    const input = raw.usage?.prompt_tokens, output = raw.usage?.completion_tokens;
    const usage = Number.isSafeInteger(input) && Number(input) >= 0 && Number.isSafeInteger(output) && Number(output) >= 0 ?
      { inputTokens: Number(input), outputTokens: Number(output) } : null;
    if (usage && usage.outputTokens > request.maxOutputTokens) throw new Error("AI_OUTPUT_TOKEN_LIMIT");
    return { decision, actualModel: raw.model, usage };
  }
}

export const researchRequestHash = (request: ResearchModelRequest): string => researchHash(request);
