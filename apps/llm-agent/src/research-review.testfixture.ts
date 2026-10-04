import { researchFixture } from "@ikbr/shared/instrument-research-testfixture";
import { evaluateResearchEligibility, researchHash, type ValidatedResearchBinding, type ResearchOrderContextV1 } from "@ikbr/shared/instrument-research";
import { buildStrategyAttribution } from "@ikbr/shared/trading-config";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import type { BoundClaim } from "./bound-review-repository.js";
export function reviewFixture(now = Date.now(), instrumentId = "aapl_smart") {
  const f = researchFixture(now, instrumentId), instrument = f.config.instruments.find(i => i.id === instrumentId)!;
  const stamp = new Date(now - 100).toISOString();
  const attribution = buildStrategyAttribution(f.config, instrumentId, instrument.strategySelection.instanceIds[0]);
  const order: BoundClaim["order"] = { id: 1, instrument: instrument.contract.symbol, instrumentId, conid: String(instrument.contract.conId),
    side: "BUY", positionEffect: "OPEN_OR_ADD", orderType: "LMT", quantity: 1, entry: 100, stop: 99, takeProfit: 105,
    confidence: .8, reason: "fixture", riskCheckStatus: "PASS", status: "PROPOSED", timestamp: stamp, createdAt: new Date(stamp),
    strategy: attribution.implementationId, clientOrderHashVersion: 2, strategyAttribution: attribution,
    strategyTrigger: { version: 1, source: "evaluation_bucket", timeframe: "1m", observedAt: stamp, bucketStartMs: Math.floor((now - 100) / 60000) * 60000 } };
  const hash = computeClientOrderHash(order);
  const claim: BoundClaim = { order, identity: { clientOrderHash: hash, instrumentId, conid: order.conid!, accountId: "DU_TEST", sessionId: "session",
    clientOrderHashVersion: 2, strategyAttribution: attribution, strategyTrigger: order.strategyTrigger }, token: "00000000-0000-4000-8000-000000000001",
    claimUntil: new Date(now + 30000).toISOString(), expiresAt: new Date(now + 120000).toISOString() };
  const research: ValidatedResearchBinding = { binding: { proposalId: 1, clientOrderHash: hash, instrumentId, configHash: f.configHash, manifestHash: f.manifestHash,
    snapshotId: "00000000-0000-4000-8000-000000000002", snapshotHash: researchHash(f.snapshot), sequence: 1 },
    manifest: f.manifest, stored: { id: "00000000-0000-4000-8000-000000000002", hash: researchHash(f.snapshot), sequence: 1, snapshot: f.snapshot },
    eligibility: evaluateResearchEligibility(f.snapshot, f.manifest, now) };
  const currency = instrument.contract.currency, fx = currency === "USD" ? 1 : .25;
  const context: ResearchOrderContextV1 = { schemaVersion: 1, proposedOrderId: 1, clientOrderHash: hash, effectiveConfigHash: f.configHash,
    accountId: "DU_TEST", sessionId: "session", instrumentId, conid: order.conid!, requestedAt: stamp, completedAt: stamp,
    validUntilMs: now + 9000, connectionGeneration: 1,
    reconciliation: { runId: 1, positionGeneration: 1, requestStartedAt: stamp, completedAt: stamp, capturedAt: stamp, complete: true, positions: [], openOrders: [] },
    account: { requestStartedAt: stamp, completedAt: stamp, configuredBaseCurrency: "USD", cashByCurrency: { USD: 10000, PLN: 10000 }, exchangeRatesToBase: { USD: 1, PLN: .25 },
      usdMetrics: { netLiquidation: 10000, availableFunds: 10000, grossPositionValue: 0 } },
    quote: { bid: 99.9, ask: 100, bidObservedAt: stamp, askObservedAt: stamp },
    valuation: { quoteCurrency: currency, valuationCurrency: "USD", quoteNotional: 100, quoteStopRisk: 1, fxToUsd: fx, fxSource: currency === "USD" ? "same_currency" : "ib_account_exchange_rate", fxValuationBuffer: 1 },
    fees: { currency, reserve: 5, source: "configured_risk_reserve", estimateStatus: "UNAVAILABLE" },
    risk: { ok: true, evidence: { accountId: "DU_TEST", sessionId: "session", instrumentId, conid: order.conid!, assessedAtMs: now - 100, validUntilMs: now + 9000 } } };
  return { ...f, claim, research, context };
}
