import type { BoundClaim, BoundDecision, BoundReviewStore, DeliveryOutcome } from "./bound-review-repository.js";
import type { AccountSummary } from "./execution-api-client.js";
import type { DecisionContext, LlmDecision } from "./openai-decider.js";
import type { MarketNewsItem } from "./marketaux-client.js";

interface BoundWorkerDependencies {
  repository: BoundReviewStore;
  execution: {
    getAccountSummary(force?: boolean): Promise<AccountSummary>;
    executeBoundProposed(id: number): Promise<DeliveryOutcome>;
  };
  news: { isConfigured(): boolean; getNewsForSymbol(symbol: string, hours: number, limit: number): Promise<MarketNewsItem[]> };
  decider: { isConfigured(): boolean; decide(context: DecisionContext): Promise<LlmDecision> };
  model: string;
  promptVersion: string;
  newsWindowHours: number;
  maxNewsItems: number;
}

export class BoundReviewWorker {
  constructor(private readonly deps: BoundWorkerDependencies) {}

  async pollOnce(): Promise<boolean> {
    const claim = await this.deps.repository.claim();
    if (!claim) return false;
    const decision = await this.evaluate(claim);
    const mayDeliver = await this.deps.repository.finalize(claim, decision);
    if (mayDeliver) {
      // The durable marker precedes this call. Transport failures cannot become rejection or retry.
      let outcome: DeliveryOutcome = "UNKNOWN";
      try { outcome = await this.deps.execution.executeBoundProposed(claim.order.id); } catch { /* uncertain delivery */ }
      await this.deps.repository.recordDelivery(claim, outcome);
    }
    return true;
  }

  private async evaluate(claim: BoundClaim): Promise<BoundDecision> {
    const context: Record<string, unknown> = {
      proposal: claim.proposalSnapshot ?? claim.order, identity: claim.identity,
      indicatorAvailability: claim.order.indicators ? "AVAILABLE" : "UNAVAILABLE",
      startedAt: new Date().toISOString(),
    };
    const reject = (reason: string): BoundDecision => ({ decision: "REJECT", confidence: 0, reason,
      model: this.deps.model, promptVersion: this.deps.promptVersion, context });
    if (claim.order.riskCheckStatus !== "PASS") return reject("RISK_NOT_PASS");
    if (!this.deps.news.isConfigured()) return reject("NEWS_NOT_CONFIGURED");
    if (!this.deps.decider.isConfigured()) return reject("AI_NOT_CONFIGURED");

    let account: AccountSummary;
    try {
      account = await this.deps.execution.getAccountSummary(true);
      context.account = { snapshot: account, receivedAt: new Date().toISOString() };
      if (account.accountId !== claim.identity.accountId || !Array.isArray(account.positions) || !account.totals ||
          !Number.isFinite(Date.parse(account.retrievedAt))) return reject("ACCOUNT_CONTEXT_INVALID");
    } catch { return reject("ACCOUNT_UNAVAILABLE"); }
    let news: MarketNewsItem[];
    try {
      news = await this.deps.news.getNewsForSymbol(claim.order.instrument, this.deps.newsWindowHours, this.deps.maxNewsItems);
      context.news = { items: news, receivedAt: new Date().toISOString(), availability: news.length ? "AVAILABLE" : "EMPTY" };
    } catch { return reject("NEWS_UNAVAILABLE"); }
    const current = account.positions.find((position) => position.conid === claim.identity.conid);
    let decision: LlmDecision;
    try {
      decision = await this.deps.decider.decide({ order: claim.order,
        indicatorSummary: claim.order.indicators ?? null,
        accountSummary: { accountId: account.accountId, metrics: account.metrics,
          totals: account.totals, openPositions: account.positions.filter((p) => p.position !== 0) },
        currentPosition: current ? { symbol: current.symbol, qty: current.position, averageCost: current.averageCost,
          unrealizedPnL: current.unrealizedPnL, marketValue: current.marketValue } : null,
        news, nowIso: new Date().toISOString(), evidence: context,
      });
      if (!['EXECUTE', 'REJECT'].includes(decision.decision) || !Number.isFinite(decision.confidence) ||
          decision.confidence < 0 || decision.confidence > 1 || typeof decision.reason !== 'string' || !decision.reason.trim()) {
        return reject("AI_OUTPUT_INVALID");
      }
    } catch { return reject("AI_UNAVAILABLE_OR_INVALID"); }
    context.completedAt = new Date().toISOString();
    return { decision: decision.decision, reason: decision.reason.slice(0, 1400), confidence: decision.confidence,
      model: this.deps.model, promptVersion: this.deps.promptVersion, context };
  }
}
