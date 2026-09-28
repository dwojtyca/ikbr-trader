export interface StrategyEconomicEvidence {
  fills: Array<{ execId: string; accountId: string | null; conid: string | null; proposedOrderId: number | null;
    brokerOrderId: string | null; secType: string | null; secTypeConflict: boolean; side: string; currency: string | null; quantity: number | null; price: number | null; executedAt: string | null;
    commission: number | null; commissionCurrency: string | null }>;
  links: Array<{ proposedOrderId: number; accountId: string; role: string; brokerOrderId: string | null; orderRef: string }>;
  close: null | { state: string; accountId: string; conid: string; originalHash: string; closeProposalId: number | null };
}

export function buildStrategyEconomicEvidence(input: StrategyEconomicEvidence): StrategyEconomicEvidence {
  const value = structuredClone(input);
  value.fills = value.fills.map(fill => ({ ...fill, side: ["BOT", "BUY"].includes(fill.side) ? "BUY" : ["SLD", "SELL"].includes(fill.side) ? "SELL" : fill.side }))
    .sort((a, b) => a.execId < b.execId ? -1 : a.execId > b.execId ? 1 : 0);
  value.links.sort((a, b) => a.proposedOrderId - b.proposedOrderId || a.role.localeCompare(b.role) ||
    (a.brokerOrderId ?? "").localeCompare(b.brokerOrderId ?? "") || a.orderRef.localeCompare(b.orderRef));
  return value;
}
