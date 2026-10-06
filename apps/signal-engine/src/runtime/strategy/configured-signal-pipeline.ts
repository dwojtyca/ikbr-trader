import { randomUUID } from 'node:crypto';
import {
  ExecutionTicketBuilder, RiskEngine, TradingPipeline, parseStrategyAttribution, parseStrategyTrigger,
  type DecisionBlocker, type DecisionResult, type ExecutionTicketPolicy, type Instrument,
  type MarketContextSnapshot, type SignalEvaluation,
} from '@ikbr/shared';
import type { StrategySignal } from '../../strategies/strategy.types.js';
import { createDefaultDecisionRules, createDefaultRiskRules } from '../engines.js';

export function prepareConfiguredPipeline(input: {
  instrument: Instrument; snapshot: MarketContextSnapshot; policy: ExecutionTicketPolicy;
  signal: StrategySignal; now: Date;
}) {
  const { instrument, snapshot, policy, signal, now } = input;
  const attribution = parseStrategyAttribution(signal.strategyAttribution);
  const trigger = parseStrategyTrigger(signal.strategyTrigger);
  const observed = Date.parse(trigger.observedAt), priceAt = snapshot.sections.price.observedAt?.getTime();
  if (attribution.instrumentId !== instrument.id || attribution.implementationId !== signal.strategyId ||
      signal.symbol !== instrument.brokerSymbol || signal.side !== 'BUY' || signal.direction !== 'LONG' ||
      (signal.entryOrderType !== undefined && signal.entryOrderType !== 'LMT') ||
      !Number.isFinite(signal.confidenceScore) || signal.confidenceScore < 0 || signal.confidenceScore > 1 ||
      !signal.entryReason || signal.trailingStopPct !== undefined || signal.trailingStopActivationR !== undefined ||
      (signal.partialTakeProfits !== undefined && signal.partialTakeProfits.length !== 0) ||
      ![signal.suggestedEntry, signal.stopLoss, signal.takeProfit].every(p => typeof p === 'number' && Number.isFinite(p) && p > 0) ||
      signal.stopLoss! >= signal.suggestedEntry! || signal.takeProfit! <= signal.suggestedEntry! ||
      !policy.strategyPrices || !Number.isFinite(now.getTime()) || observed > now.getTime() || now.getTime() - observed >= 90_000 ||
      priceAt === undefined || priceAt < observed || priceAt > now.getTime() || Math.floor(priceAt / 60_000) * 60_000 !== trigger.bucketStartMs)
    throw new Error('CONFIGURED_SIGNAL_IDENTITY_OR_PRICES_INVALID');
  const pipeline = new TradingPipeline({
    now: () => now,
    ticketBuilder: new ExecutionTicketBuilder({idFactory: randomUUID, correlationIdFactory: randomUUID, now: () => now}),
    signalEngine: { evaluate(current): SignalEvaluation {
      const blockedBy: DecisionBlocker[] = [], warnings: string[] = [];
      for (const rule of createDefaultDecisionRules()) {
        try {
          if (!rule.supports(current)) continue;
          const result = rule.evaluate(current);
          blockedBy.push(...result.blockers); warnings.push(...result.warnings);
        } catch { blockedBy.push({code: 'UNKNOWN', ruleId: rule.id, message: 'configured decision safety rule failed'}); }
      }
      const decision: DecisionResult = {
        decisionId: randomUUID(), generatedAt: now, instrumentId: instrument.id,
        action: blockedBy.length ? 'HOLD' : signal.direction,
        confidence: signal.confidenceScore * 100, overallScore: signal.confidenceScore * 100,
        reasons: [{id: signal.strategyId, category: 'TECHNICAL', weight: signal.confidenceScore, direction: 'BULLISH', message: signal.entryReason}],
        warnings, blockedBy, metadata: {engineVersion: 'configured-strategy-v1', evaluationTimeMs: 0},
      };
      const risk = blockedBy.length ? null : new RiskEngine({rules: createDefaultRiskRules()}).evaluate(decision, current, instrument);
      return {
        signalId: randomUUID(), generatedAt: now, instrumentId: instrument.id, decision, risk,
        status: blockedBy.length ? 'BLOCKED' : risk?.approved ? 'GENERATED' : 'REJECTED',
        reasonSummary: signal.entryReason, warnings: [], blockers: [],
        metadata: {engineVersions: {signal: 'configured-strategy-v1', decision: decision.metadata.engineVersion,
          ...(risk ? {risk: risk.metadata.engineVersion} : {})}, evaluationTimeMs: 0,
          strategyId: signal.strategyId, strategyAttribution: attribution, strategyTrigger: trigger},
      };
    }},
  });
  return pipeline.run(snapshot, instrument, policy, {strategyId: signal.strategyId, intendedAction: signal.direction,
    strategyAttribution: attribution, strategyTrigger: trigger});
}
