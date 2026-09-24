import type { BoundInstrument } from "@ikbr/shared";

export interface WseStrategyMetadataReader {
  read(bound: BoundInstrument): Promise<{ accountId: string; metadata: unknown }>;
}
export class HttpWseStrategyMetadataReader implements WseStrategyMetadataReader {
  constructor(private readonly options: { engineUrl: string; bearerToken: string; requestTimeoutMs: number; fetchFn?: typeof fetch }) {}
  async read(bound: BoundInstrument): Promise<{ accountId: string; metadata: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const response = await (this.options.fetchFn ?? fetch)(`${this.options.engineUrl.replace(/\/$/, "")}/execution/instruments/${encodeURIComponent(bound.instrumentId)}/market-rules`, {
        headers: { authorization: `Bearer ${this.options.bearerToken}` }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`wse_metadata_http_${response.status}`);
      const data = await response.json() as { accountId?: unknown; metadata?: unknown };
      if (typeof data?.accountId !== "string" || !data.accountId.trim() || !data.metadata) throw new Error("wse_metadata_response_invalid");
      return { accountId: data.accountId, metadata: data.metadata };
    } finally { clearTimeout(timer); }
  }
}
