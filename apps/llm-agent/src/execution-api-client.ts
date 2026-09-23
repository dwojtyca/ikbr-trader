import type { DeliveryOutcome } from "./bound-review-repository.js";

export interface AccountSummary {
  source: 'cache' | 'live';
  accountId: string;
  retrievedAt: string;
  metrics?: {
    netLiquidation?: number;
    totalCashValue?: number;
    settledCash?: number;
    buyingPower?: number;
    availableFunds?: number;
    excessLiquidity?: number;
    equityWithLoanValue?: number;
    grossPositionValue?: number;
    initMarginReq?: number;
    maintMarginReq?: number;
    unrealizedPnL?: number;
    realizedPnL?: number;
  };
  totals: {
    positionsCount: number;
    grossExposure: number;
    netExposure: number;
    unrealizedPnL: number;
    realizedPnL: number;
  };
  positions: Array<{
    conid?: string;
    symbol: string;
    position: number;
    marketPrice?: number;
    marketValue?: number;
    averageCost?: number;
    unrealizedPnL?: number;
    realizedPnL?: number;
  }>;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

export interface ExecuteProposedPayload {
  overrideRejected?: boolean;
  actor?: 'llm-agent' | 'user' | 'user_override';
  decisionSource?: 'signal' | 'llm' | 'user' | 'user_override';
  aiDecision?: 'EXECUTE' | 'REJECT';
  aiReason?: string;
  aiModel?: string;
  aiDecisionConfidence?: number;
  llmDecisionId?: number;
  sourceError?: string;
}

export interface RejectProposedPayload {
  reason: string;
  actor: 'llm-agent' | 'user';
  decisionSource?: 'signal' | 'llm' | 'user' | 'user_override';
  aiDecision?: 'EXECUTE' | 'REJECT';
  aiReason?: string;
  aiModel?: string;
  aiDecisionConfidence?: number;
  llmDecisionId?: number;
  sourceError?: string;
}

export class ExecutionApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly bearerToken: string
  ) {}

  async getAccountSummary(force = false): Promise<AccountSummary> {
    const suffix = force ? '?force=true' : '';
    return this.requestJson<AccountSummary>(`/execution/account/summary${suffix}`);
  }

  async executeProposed(orderId: number, payload: ExecuteProposedPayload): Promise<void> {
    await this.requestJson(`/execution/execute-proposed/${orderId}`, {
      method: 'POST',
      body: payload
    });
  }

  async executeBoundProposed(orderId: number): Promise<DeliveryOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/execution/execute-proposed/${orderId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.bearerToken}` },
        body: JSON.stringify({ actor: 'llm-agent' }),
        signal: controller.signal,
      });
      if (response.status >= 500) return 'UNKNOWN';
      if (response.status >= 400 && response.status < 500) return 'REFUSED';
      if (!response.ok) return 'UNKNOWN';
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') return 'UNKNOWN';
      const data = body as { outcome?: unknown; order?: { id?: unknown; status?: unknown } };
      if (['SUBMITTED', 'RESUMED', 'DUPLICATE_SUBMITTED'].includes(String(data.outcome)) &&
          Number(data.order?.id) === orderId && data.order?.status === 'SUBMITTED') return 'SUBMITTED';
      return 'UNKNOWN';
    } catch { return 'UNKNOWN'; }
    finally { clearTimeout(timeout); }
  }

  async rejectProposed(orderId: number, payload: RejectProposedPayload): Promise<void> {
    await this.requestJson(`/execution/reject-proposed/${orderId}`, {
      method: 'POST',
      body: payload
    });
  }

  private async requestJson<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json'
      };
      if (this.bearerToken) {
        headers.authorization = `Bearer ${this.bearerToken}`;
      }
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${response.status} ${response.statusText}: ${text}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
