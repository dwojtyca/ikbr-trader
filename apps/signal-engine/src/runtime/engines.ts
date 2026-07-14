/**
 * Market Data Runtime — engine factories.
 *
 * PR12 wires the shared engines (`DecisionEngine`, `RiskEngine`,
 * `SignalEngine`, `ExecutionTicketBuilder`, `TradingPipeline`) into
 * a single `TradingPipeline` instance for dry-run use.
 *
 * All domain logic stays in `packages/shared`; this module only
 * assembles them and provides deterministic id/clock injections.
 * No I/O happens here — no HTTP, no Postgres, no Redis, no IBKR.
 */

import { randomUUID } from "node:crypto";
import {
  BrokerAvailabilityRule,
  DecisionEngine,
  DecisionConfidenceRule,
  ExecutionTicketBuilder,
  FreshPriceRule,
  HighImpactCalendarRule,
  HighImpactEventRule,
  InstrumentExecutionRule,
  MarketFreshnessRule,
  MissingPriceRule,
  NewsRiskRule,
  OvernightRule,
  RiskEngine,
  SignalEngine,
  TradingPipeline,
  type InstrumentRegistry,
  type Rule,
  type RiskRule,
} from "@ikbr/shared";

export interface RuntimeEnginesOptions {
  readonly registry: InstrumentRegistry;
  /** Deterministic id factory. Default: `crypto.randomUUID`. */
  readonly idFactory?: () => string;
  /** Deterministic wall clock. Default: `() => new Date()`. */
  readonly now?: () => Date;
}

export interface RuntimeEngines {
  readonly decisionEngine: DecisionEngine;
  readonly riskEngine: RiskEngine;
  readonly signalEngine: SignalEngine;
  readonly ticketBuilder: ExecutionTicketBuilder;
  readonly pipeline: TradingPipeline;
}

/**
 * Default rule sets. Kept as separate exported helpers so tests can
 * substitute a smaller ruleset (or a no-op set) without redefining
 * the full runtime.
 */
export function createDefaultDecisionRules(): readonly Rule[] {
  return [
    new FreshPriceRule(),
    new MissingPriceRule(),
    new HighImpactCalendarRule(),
    new NewsRiskRule(),
    new BrokerAvailabilityRule(),
  ];
}

export function createDefaultRiskRules(): readonly RiskRule[] {
  return [
    new DecisionConfidenceRule(),
    new HighImpactEventRule(),
    new MarketFreshnessRule(),
    new InstrumentExecutionRule(),
    new OvernightRule(),
  ];
}

export function createRuntimeEngines(
  options: RuntimeEnginesOptions,
): RuntimeEngines {
  if (!options?.registry) {
    throw new Error("createRuntimeEngines: registry is required");
  }
  const idFactory = options.idFactory ?? (() => randomUUID());
  const now = options.now ?? (() => new Date());

  const decisionEngine = new DecisionEngine({
    rules: createDefaultDecisionRules(),
    idFactory,
    now,
  });
  // `RiskEngine` currently accepts only `rules` + optional score /
  // version / performanceNow — no id or wall-clock injection surface.
  const riskEngine = new RiskEngine({
    rules: createDefaultRiskRules(),
  });
  const signalEngine = new SignalEngine({
    decisionEngine,
    riskEngine,
    instrumentResolver: (id) => {
      try {
        return options.registry.getInstrumentOrThrow(id);
      } catch {
        return undefined;
      }
    },
    idFactory,
    now,
  });
  const ticketBuilder = new ExecutionTicketBuilder({
    idFactory,
    correlationIdFactory: idFactory,
    now,
  });
  const pipeline = new TradingPipeline({
    signalEngine,
    ticketBuilder,
    now,
  });
  return { decisionEngine, riskEngine, signalEngine, ticketBuilder, pipeline };
}
