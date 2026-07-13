/**
 * Initial catalogue of deterministic rules for the Decision Engine.
 *
 * Each rule is a pure function of the snapshot. Rules may be added,
 * removed or swapped at engine-construction time; the engine itself
 * has no knowledge of which rules exist.
 *
 * Every rule in this file is intentionally small: the goal in PR7 is
 * to prove the scaffold end-to-end, not to build a production
 * strategy. Meaningful rules (multi-timeframe technical confluence,
 * COT-driven positioning, cross-asset regime detection, …) will be
 * added in later PRs.
 */

import type { MarketContextSnapshot } from "../market-context/types.js";
import type {
  DecisionBlocker,
  DecisionReason,
  Rule,
  RuleEvaluation,
} from "./types.js";

function emptyEvaluation(): RuleEvaluation {
  return {
    scoreContribution: 0,
    reasons: [],
    warnings: [],
    blockers: [],
  };
}

// ---------------------------------------------------------------------------
// Price freshness
// ---------------------------------------------------------------------------

export interface FreshPriceRuleOptions {
  readonly id?: string;
}

/**
 * Flags the price section's freshness. Does not itself take a
 * directional stance — it emits a neutral reason on fresh data or a
 * `STALE_DATA` blocker on stale data. Absent data is handled by
 * `MissingPriceRule`, not here.
 */
export class FreshPriceRule implements Rule {
  readonly id: string;
  readonly category = "TECHNICAL" as const;

  constructor(options: FreshPriceRuleOptions = {}) {
    this.id = options.id ?? "fresh-price";
  }

  supports(_snapshot: MarketContextSnapshot): boolean {
    return true;
  }

  evaluate(snapshot: MarketContextSnapshot): RuleEvaluation {
    const price = snapshot.sections.price;
    if (price.status === "fresh") {
      const reason: DecisionReason = {
        id: `${this.id}:fresh`,
        category: this.category,
        weight: 0.1,
        direction: "NEUTRAL",
        message: "price data is fresh",
      };
      return { ...emptyEvaluation(), reasons: [reason] };
    }
    if (price.status === "stale") {
      const blocker: DecisionBlocker = {
        code: "STALE_DATA",
        message: "price data is stale",
        ruleId: this.id,
      };
      return {
        ...emptyEvaluation(),
        warnings: ["price data is stale"],
        blockers: [blocker],
      };
    }
    return emptyEvaluation();
  }
}

// ---------------------------------------------------------------------------
// Missing price
// ---------------------------------------------------------------------------

export interface MissingPriceRuleOptions {
  readonly id?: string;
}

export class MissingPriceRule implements Rule {
  readonly id: string;
  readonly category = "TECHNICAL" as const;

  constructor(options: MissingPriceRuleOptions = {}) {
    this.id = options.id ?? "missing-price";
  }

  supports(_snapshot: MarketContextSnapshot): boolean {
    return true;
  }

  evaluate(snapshot: MarketContextSnapshot): RuleEvaluation {
    const price = snapshot.sections.price;
    if (price.data === null) {
      const blocker: DecisionBlocker = {
        code: "MISSING_PRICE",
        message: "no price data available",
        ruleId: this.id,
      };
      return { ...emptyEvaluation(), blockers: [blocker] };
    }
    return emptyEvaluation();
  }
}

// ---------------------------------------------------------------------------
// High-impact economic calendar events
// ---------------------------------------------------------------------------

export interface HighImpactCalendarRuleOptions {
  readonly id?: string;
  /**
   * Block window: if `nextHighImpactEvent.startsAt` is within this
   * many milliseconds AFTER `snapshot.generatedAt`, raise
   * `HIGH_IMPACT_EVENT`. Default: 60 min.
   */
  readonly thresholdMs?: number;
}

export class HighImpactCalendarRule implements Rule {
  readonly id: string;
  readonly category = "MACRO" as const;
  readonly #thresholdMs: number;

  constructor(options: HighImpactCalendarRuleOptions = {}) {
    this.id = options.id ?? "high-impact-calendar";
    this.#thresholdMs = options.thresholdMs ?? 60 * 60_000;
  }

  supports(_snapshot: MarketContextSnapshot): boolean {
    return true;
  }

  evaluate(snapshot: MarketContextSnapshot): RuleEvaluation {
    const calendar = snapshot.sections.calendar;
    const next = calendar.data?.nextHighImpactEvent;
    if (!next) {
      return emptyEvaluation();
    }
    const deltaMs = next.startsAt.getTime() - snapshot.generatedAt.getTime();
    if (deltaMs < 0 || deltaMs > this.#thresholdMs) {
      return emptyEvaluation();
    }
    const blocker: DecisionBlocker = {
      code: "HIGH_IMPACT_EVENT",
      message: `high-impact event "${next.title}" in ${Math.round(
        deltaMs / 60_000,
      )}m`,
      ruleId: this.id,
    };
    return {
      ...emptyEvaluation(),
      warnings: [blocker.message],
      blockers: [blocker],
    };
  }
}

// ---------------------------------------------------------------------------
// News risk / sentiment
// ---------------------------------------------------------------------------

export interface NewsRiskRuleOptions {
  readonly id?: string;
  /** Score per flagged risk item (bearish, negative sign). Default 20. */
  readonly perFlagContribution?: number;
  /** Cap for the risk-flag contribution. Default 60. */
  readonly maxFlagContribution?: number;
  /** Score for a positive/negative sentiment when no risk flags fire. */
  readonly sentimentContribution?: number;
}

export class NewsRiskRule implements Rule {
  readonly id: string;
  readonly category = "NEWS" as const;
  readonly #perFlag: number;
  readonly #maxFlag: number;
  readonly #sentiment: number;

  constructor(options: NewsRiskRuleOptions = {}) {
    this.id = options.id ?? "news-risk";
    this.#perFlag = options.perFlagContribution ?? 20;
    this.#maxFlag = options.maxFlagContribution ?? 60;
    this.#sentiment = options.sentimentContribution ?? 15;
  }

  supports(_snapshot: MarketContextSnapshot): boolean {
    return true;
  }

  evaluate(snapshot: MarketContextSnapshot): RuleEvaluation {
    const news = snapshot.sections.news;
    if (news.data === null) {
      return emptyEvaluation();
    }
    const { riskFlags, sentiment } = news.data;
    if (riskFlags.length > 0) {
      const magnitude = Math.min(
        this.#maxFlag,
        riskFlags.length * this.#perFlag,
      );
      const reason: DecisionReason = {
        id: `${this.id}:flags`,
        category: this.category,
        weight: Math.min(1, riskFlags.length / 3),
        direction: "BEARISH",
        message: `news risk flags: ${riskFlags.join(", ")}`,
      };
      return {
        scoreContribution: -magnitude,
        reasons: [reason],
        warnings: [`news risk flags present (${riskFlags.length})`],
        blockers: [],
      };
    }
    switch (sentiment) {
      case "positive": {
        const reason: DecisionReason = {
          id: `${this.id}:positive`,
          category: this.category,
          weight: 0.3,
          direction: "BULLISH",
          message: "news sentiment positive",
        };
        return {
          ...emptyEvaluation(),
          scoreContribution: this.#sentiment,
          reasons: [reason],
        };
      }
      case "negative": {
        const reason: DecisionReason = {
          id: `${this.id}:negative`,
          category: this.category,
          weight: 0.3,
          direction: "BEARISH",
          message: "news sentiment negative",
        };
        return {
          ...emptyEvaluation(),
          scoreContribution: -this.#sentiment,
          reasons: [reason],
        };
      }
      case "neutral":
      case "mixed":
        return emptyEvaluation();
    }
  }
}

// ---------------------------------------------------------------------------
// Broker availability
// ---------------------------------------------------------------------------

export interface BrokerAvailabilityRuleOptions {
  readonly id?: string;
}

export class BrokerAvailabilityRule implements Rule {
  readonly id: string;
  readonly category = "BROKER" as const;

  constructor(options: BrokerAvailabilityRuleOptions = {}) {
    this.id = options.id ?? "broker-availability";
  }

  supports(_snapshot: MarketContextSnapshot): boolean {
    return true;
  }

  evaluate(snapshot: MarketContextSnapshot): RuleEvaluation {
    const broker = snapshot.sections.brokerState;
    if (broker.data === null) {
      const blocker: DecisionBlocker = {
        code: "BROKER_UNAVAILABLE",
        message: "broker state unavailable",
        ruleId: this.id,
      };
      return { ...emptyEvaluation(), blockers: [blocker] };
    }
    const warnings: string[] = [];
    if (
      broker.data.buyingPower !== undefined &&
      broker.data.buyingPower <= 0
    ) {
      warnings.push("broker reports zero buying power");
    }
    const reason: DecisionReason = {
      id: `${this.id}:ok`,
      category: this.category,
      weight: 0.1,
      direction: "NEUTRAL",
      message: `broker available (${broker.data.accountEnvironment})`,
    };
    return { ...emptyEvaluation(), reasons: [reason], warnings };
  }
}
