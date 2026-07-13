/**
 * Initial catalogue of deterministic rules for the Risk Engine.
 *
 * Each rule inspects the (decision, snapshot, instrument) triple and
 * either passes silently, adds a warning, or raises a blocker. Rules
 * are strictly independent — no rule reads or depends on another
 * rule's output.
 *
 * Score contributions are unipolar: rules only ADD risk. There is
 * no bullish/bearish concept here.
 */

import type {
  RiskBlocker,
  RiskInput,
  RiskRule,
  RiskRuleEvaluation,
} from "./types.js";

function empty(): RiskRuleEvaluation {
  return { scoreContribution: 0, warnings: [], blockers: [] };
}

// ---------------------------------------------------------------------------
// Decision confidence
// ---------------------------------------------------------------------------

export interface DecisionConfidenceRuleOptions {
  readonly id?: string;
  /** Below this confidence the rule raises `LOW_CONFIDENCE`. Default 50. */
  readonly minConfidence?: number;
  /** Score charged when the rule blocks. Default 60. */
  readonly blockingContribution?: number;
}

export class DecisionConfidenceRule implements RiskRule {
  readonly id: string;
  readonly #minConfidence: number;
  readonly #blockingContribution: number;

  constructor(options: DecisionConfidenceRuleOptions = {}) {
    this.id = options.id ?? "decision-confidence";
    this.#minConfidence = options.minConfidence ?? 50;
    this.#blockingContribution = options.blockingContribution ?? 60;
  }

  supports(_input: RiskInput): boolean {
    return true;
  }

  evaluate(input: RiskInput): RiskRuleEvaluation {
    if (input.decision.confidence < this.#minConfidence) {
      const blocker: RiskBlocker = {
        code: "LOW_CONFIDENCE",
        message: `decision confidence ${input.decision.confidence} below risk threshold ${this.#minConfidence}`,
        ruleId: this.id,
      };
      return {
        scoreContribution: this.#blockingContribution,
        warnings: [],
        blockers: [blocker],
      };
    }
    return empty();
  }
}

// ---------------------------------------------------------------------------
// High-impact economic event
// ---------------------------------------------------------------------------

export interface HighImpactEventRuleOptions {
  readonly id?: string;
  /**
   * Block window in milliseconds after `snapshot.generatedAt`.
   * Default 60 min.
   */
  readonly thresholdMs?: number;
  readonly blockingContribution?: number;
}

export class HighImpactEventRule implements RiskRule {
  readonly id: string;
  readonly #thresholdMs: number;
  readonly #blockingContribution: number;

  constructor(options: HighImpactEventRuleOptions = {}) {
    this.id = options.id ?? "high-impact-event";
    this.#thresholdMs = options.thresholdMs ?? 60 * 60_000;
    this.#blockingContribution = options.blockingContribution ?? 40;
  }

  supports(_input: RiskInput): boolean {
    return true;
  }

  evaluate(input: RiskInput): RiskRuleEvaluation {
    const next = input.snapshot.sections.calendar.data?.nextHighImpactEvent;
    if (!next) return empty();
    const deltaMs =
      next.startsAt.getTime() - input.snapshot.generatedAt.getTime();
    if (deltaMs < 0 || deltaMs > this.#thresholdMs) return empty();
    const blocker: RiskBlocker = {
      code: "HIGH_IMPACT_EVENT",
      message: `high-impact event "${next.title}" in ${Math.round(deltaMs / 60_000)}m`,
      ruleId: this.id,
    };
    return {
      scoreContribution: this.#blockingContribution,
      warnings: [{ code: "HIGH_IMPACT_EVENT", message: blocker.message, ruleId: this.id }],
      blockers: [blocker],
    };
  }
}

// ---------------------------------------------------------------------------
// Snapshot freshness
// ---------------------------------------------------------------------------

export interface MarketFreshnessRuleOptions {
  readonly id?: string;
  /** Score charged for `stale` snapshots. Default 30. */
  readonly staleContribution?: number;
  /** Score charged for `unavailable` snapshots. Default 60. */
  readonly unavailableContribution?: number;
}

export class MarketFreshnessRule implements RiskRule {
  readonly id: string;
  readonly #stale: number;
  readonly #unavailable: number;

  constructor(options: MarketFreshnessRuleOptions = {}) {
    this.id = options.id ?? "market-freshness";
    this.#stale = options.staleContribution ?? 30;
    this.#unavailable = options.unavailableContribution ?? 60;
  }

  supports(_input: RiskInput): boolean {
    return true;
  }

  evaluate(input: RiskInput): RiskRuleEvaluation {
    const status = input.snapshot.overallStatus;
    if (status === "stale") {
      const blocker: RiskBlocker = {
        code: "STALE_SNAPSHOT",
        message: "market context snapshot is stale",
        ruleId: this.id,
      };
      return {
        scoreContribution: this.#stale,
        warnings: [],
        blockers: [blocker],
      };
    }
    if (status === "unavailable") {
      const blocker: RiskBlocker = {
        code: "UNAVAILABLE_SNAPSHOT",
        message: "market context snapshot is unavailable",
        ruleId: this.id,
      };
      return {
        scoreContribution: this.#unavailable,
        warnings: [],
        blockers: [blocker],
      };
    }
    return empty();
  }
}

// ---------------------------------------------------------------------------
// Instrument execution flag
// ---------------------------------------------------------------------------

export interface InstrumentExecutionRuleOptions {
  readonly id?: string;
  readonly blockingContribution?: number;
}

export class InstrumentExecutionRule implements RiskRule {
  readonly id: string;
  readonly #blockingContribution: number;

  constructor(options: InstrumentExecutionRuleOptions = {}) {
    this.id = options.id ?? "instrument-execution";
    this.#blockingContribution = options.blockingContribution ?? 100;
  }

  supports(_input: RiskInput): boolean {
    return true;
  }

  evaluate(input: RiskInput): RiskRuleEvaluation {
    if (!input.instrument.trading.executionEnabled) {
      const blocker: RiskBlocker = {
        code: "INSTRUMENT_DISABLED",
        message: `execution disabled for ${input.instrument.id}`,
        ruleId: this.id,
      };
      return {
        scoreContribution: this.#blockingContribution,
        warnings: [],
        blockers: [blocker],
      };
    }
    return empty();
  }
}

// ---------------------------------------------------------------------------
// Overnight restriction
// ---------------------------------------------------------------------------

export interface OvernightRuleOptions {
  readonly id?: string;
  /**
   * Predicate answering "is the instrument currently within its
   * trading session?". Default: `() => true` (permissive when no
   * session information is available). Session-aware providers /
   * calendars will replace this in a later PR.
   */
  readonly isInSession?: (input: RiskInput) => boolean;
  readonly blockingContribution?: number;
}

export class OvernightRule implements RiskRule {
  readonly id: string;
  readonly #isInSession: (input: RiskInput) => boolean;
  readonly #blockingContribution: number;

  constructor(options: OvernightRuleOptions = {}) {
    this.id = options.id ?? "overnight";
    this.#isInSession = options.isInSession ?? (() => true);
    this.#blockingContribution = options.blockingContribution ?? 40;
  }

  supports(_input: RiskInput): boolean {
    return true;
  }

  evaluate(input: RiskInput): RiskRuleEvaluation {
    if (input.instrument.risk.allowOvernight) return empty();
    if (this.#isInSession(input)) return empty();
    const blocker: RiskBlocker = {
      code: "OVERNIGHT_NOT_ALLOWED",
      message: `instrument ${input.instrument.id} disallows overnight and is out of session`,
      ruleId: this.id,
    };
    return {
      scoreContribution: this.#blockingContribution,
      warnings: [],
      blockers: [blocker],
    };
  }
}

// ---------------------------------------------------------------------------
// Broker environment (paper vs live)
// ---------------------------------------------------------------------------

export interface BrokerEnvironmentRuleOptions {
  readonly id?: string;
  readonly expectedEnvironment: "paper" | "live";
  readonly blockingContribution?: number;
}

export class BrokerEnvironmentRule implements RiskRule {
  readonly id: string;
  readonly #expected: "paper" | "live";
  readonly #blockingContribution: number;

  constructor(options: BrokerEnvironmentRuleOptions) {
    this.id = options.id ?? "broker-environment";
    this.#expected = options.expectedEnvironment;
    this.#blockingContribution = options.blockingContribution ?? 100;
  }

  supports(_input: RiskInput): boolean {
    return true;
  }

  evaluate(input: RiskInput): RiskRuleEvaluation {
    const broker = input.snapshot.sections.brokerState.data;
    if (!broker) return empty();
    if (broker.accountEnvironment !== this.#expected) {
      const blocker: RiskBlocker = {
        code: "BROKER_ENVIRONMENT_MISMATCH",
        message: `broker environment "${broker.accountEnvironment}" does not match expected "${this.#expected}"`,
        ruleId: this.id,
      };
      return {
        scoreContribution: this.#blockingContribution,
        warnings: [],
        blockers: [blocker],
      };
    }
    return empty();
  }
}
