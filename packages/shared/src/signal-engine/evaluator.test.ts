import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DecisionEngine } from "../decision-engine/evaluator.js";
import type { Rule } from "../decision-engine/types.js";
import { buildSnapshot } from "../decision-engine/snapshot.testfixture.js";
import { RiskEngine } from "../risk-engine/evaluator.js";
import type { RiskRule, RiskRuleEvaluation } from "../risk-engine/types.js";
import { buildInstrument } from "../risk-engine/risk-input.testfixture.js";
import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import { SIGNAL_ENGINE_VERSION, SignalEngine } from "./evaluator.js";
import type { InstrumentResolver } from "./pipeline.js";
import type {
  SignalEvaluation,
  SignalWarning,
} from "./types.js";

// ---------------------------------------------------------------------------
// Rule doubles — Decision Engine
// ---------------------------------------------------------------------------

function directionalRule(id: string, contribution: number): Rule {
  return {
    id,
    category: "TECHNICAL",
    supports: () => true,
    evaluate: () => ({
      scoreContribution: contribution,
      reasons: [
        {
          id: `${id}-reason`,
          category: "TECHNICAL",
          weight: 1,
          direction: contribution >= 0 ? "BULLISH" : "BEARISH",
          message: `contribution ${contribution}`,
        },
      ],
      warnings: [],
      blockers: [],
    }),
  };
}

function decisionBlockerRule(id: string): Rule {
  return {
    id,
    category: "TECHNICAL",
    supports: () => true,
    evaluate: () => ({
      scoreContribution: 0,
      reasons: [],
      warnings: [],
      blockers: [{ code: "STALE_DATA", message: "test blocker", ruleId: id }],
    }),
  };
}

function throwingDecisionRule(): Rule {
  return {
    id: "throw-decision",
    category: "TECHNICAL",
    supports: () => true,
    evaluate: () => {
      throw new Error("decision boom");
    },
  };
}

// ---------------------------------------------------------------------------
// Rule doubles — Risk Engine
// ---------------------------------------------------------------------------

class RiskScoreRule implements RiskRule {
  readonly id: string;
  readonly #contribution: number;
  constructor(id: string, contribution: number) {
    this.id = id;
    this.#contribution = contribution;
  }
  supports(): boolean {
    return true;
  }
  evaluate(): RiskRuleEvaluation {
    return {
      scoreContribution: this.#contribution,
      warnings: [],
      blockers: [],
    };
  }
}

class RiskBlockerRule implements RiskRule {
  readonly id = "risk-blocker";
  supports(): boolean {
    return true;
  }
  evaluate(): RiskRuleEvaluation {
    return {
      scoreContribution: 0,
      warnings: [],
      blockers: [
        {
          code: "INSTRUMENT_DISABLED",
          message: "test risk block",
          ruleId: this.id,
        },
      ],
    };
  }
}

class ThrowingRiskRule implements RiskRule {
  readonly id = "throw-risk";
  supports(): boolean {
    return true;
  }
  evaluate(): RiskRuleEvaluation {
    throw new Error("risk boom");
  }
}

// ---------------------------------------------------------------------------
// Engine builder
// ---------------------------------------------------------------------------

interface BuildEngineOptions {
  readonly decisionRules?: readonly Rule[];
  readonly riskRules?: readonly RiskRule[];
  readonly resolver?: InstrumentResolver;
  readonly scoreThreshold?: number;
  readonly minConfidence?: number;
}

function buildEngine(options: BuildEngineOptions = {}): {
  engine: SignalEngine;
  resolverCalls: string[];
} {
  const resolverCalls: string[] = [];
  const defaultResolver: InstrumentResolver = (id) => {
    resolverCalls.push(id);
    return buildInstrument({ id });
  };

  const decisionEngine = new DecisionEngine({
    rules: options.decisionRules ?? [directionalRule("bull", 30)],
    scoreThreshold: options.scoreThreshold ?? 10,
    minConfidenceForAction: options.minConfidence ?? 25,
    expectedRuleCount: 1,
    now: () => new Date("2026-07-13T12:00:00Z"),
    idFactory: () => "decision-id",
    performanceNow: (() => {
      let t = 0;
      return () => (t += 1);
    })(),
  });

  const riskEngine = new RiskEngine({
    rules: options.riskRules ?? [],
    performanceNow: (() => {
      let t = 0;
      return () => (t += 1);
    })(),
  });

  let signalTick = 0;
  const engine = new SignalEngine({
    decisionEngine,
    riskEngine,
    instrumentResolver: options.resolver ?? defaultResolver,
    now: () => new Date("2026-07-13T12:00:05Z"),
    idFactory: () => "signal-id",
    performanceNow: () => (signalTick += 1),
  });

  return { engine, resolverCalls };
}

function fixtureSnapshot(): MarketContextSnapshot {
  return buildSnapshot({ overallStatus: "fresh" });
}

// ---------------------------------------------------------------------------
// Approval paths
// ---------------------------------------------------------------------------

describe("SignalEngine — LONG approved", () => {
  it("returns GENERATED with decision LONG and risk approved", () => {
    const { engine, resolverCalls } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      riskRules: [new RiskScoreRule("mild", 10)],
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "GENERATED");
    assert.equal(evaluation.decision?.action, "LONG");
    assert.equal(evaluation.risk?.approved, true);
    assert.match(evaluation.reasonSummary, /GENERATED.*LONG.*riskScore 10/);
    assert.deepEqual(resolverCalls, [fixtureSnapshot().instrumentId]);
  });
});

describe("SignalEngine — SHORT approved", () => {
  it("returns GENERATED with decision SHORT and risk approved", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bear", -40)],
      riskRules: [new RiskScoreRule("mild", 5)],
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "GENERATED");
    assert.equal(evaluation.decision?.action, "SHORT");
    assert.equal(evaluation.risk?.approved, true);
    assert.match(evaluation.reasonSummary, /GENERATED.*SHORT/);
  });
});

// ---------------------------------------------------------------------------
// HOLD path (decision action = HOLD, no blockers) — risk must be skipped
// ---------------------------------------------------------------------------

describe("SignalEngine — HOLD", () => {
  it("returns HOLD and does NOT invoke risk or resolver", () => {
    let riskCalls = 0;
    const noisyRisk: RiskRule = {
      id: "noisy",
      supports: () => {
        riskCalls += 1;
        return true;
      },
      evaluate: () => ({
        scoreContribution: 0,
        warnings: [],
        blockers: [],
      }),
    };
    const { engine, resolverCalls } = buildEngine({
      decisionRules: [directionalRule("weak", 2)], // score below threshold=10 → HOLD
      riskRules: [noisyRisk],
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "HOLD");
    assert.equal(evaluation.decision?.action, "HOLD");
    assert.equal(evaluation.risk, null);
    assert.equal(riskCalls, 0);
    assert.deepEqual(resolverCalls, []);
    assert.match(evaluation.reasonSummary, /^HOLD — score /);
  });
});

// ---------------------------------------------------------------------------
// Risk rejected
// ---------------------------------------------------------------------------

describe("SignalEngine — risk rejected", () => {
  it("returns REJECTED when risk engine blocks a directional decision", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      riskRules: [new RiskBlockerRule()],
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "REJECTED");
    assert.equal(evaluation.decision?.action, "LONG");
    assert.equal(evaluation.risk?.approved, false);
    assert.match(evaluation.reasonSummary, /REJECTED.*INSTRUMENT_DISABLED/);
  });
});

// ---------------------------------------------------------------------------
// Decision blocked
// ---------------------------------------------------------------------------

describe("SignalEngine — decision blocked", () => {
  it("returns BLOCKED and does NOT invoke risk or resolver", () => {
    let riskCalls = 0;
    const noisyRisk: RiskRule = {
      id: "noisy",
      supports: () => {
        riskCalls += 1;
        return true;
      },
      evaluate: () => ({ scoreContribution: 0, warnings: [], blockers: [] }),
    };
    const { engine, resolverCalls } = buildEngine({
      decisionRules: [
        directionalRule("bull", 40),
        decisionBlockerRule("stale"),
      ],
      riskRules: [noisyRisk],
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "BLOCKED");
    assert.equal(riskCalls, 0);
    assert.deepEqual(resolverCalls, []);
    assert.match(evaluation.reasonSummary, /BLOCKED.*STALE_DATA/);
  });
});

// ---------------------------------------------------------------------------
// Exceptions — isolated
// ---------------------------------------------------------------------------

describe("SignalEngine — decision engine exception", () => {
  it("returns ERROR without leaking the exception", () => {
    const { engine } = buildEngine({
      decisionRules: [throwingDecisionRule()],
    });
    // Note: DecisionEngine already isolates rule exceptions into
    // UNKNOWN blockers → BLOCKED, not ERROR. To exercise the outer
    // ERROR path we must make DecisionEngine.evaluate itself throw.
    // Simulate by replacing the engine with a broken one via a
    // secondary construction:
    const brokenEngine = new SignalEngine({
      decisionEngine: {
        evaluate: () => {
          throw new Error("decision boom");
        },
      } as unknown as DecisionEngine,
      riskEngine: new RiskEngine({ rules: [] }),
      instrumentResolver: () => buildInstrument(),
      now: () => new Date("2026-07-13T12:00:05Z"),
      idFactory: () => "signal-id",
      performanceNow: (() => {
        let t = 0;
        return () => (t += 1);
      })(),
    });
    // Sanity check: the underlying "throwing rule" engine still runs
    // (BLOCKED), while the outer broken engine returns ERROR.
    const sane = engine.evaluate(fixtureSnapshot());
    assert.equal(sane.status, "BLOCKED"); // decision rule threw → UNKNOWN blocker

    const evaluation = brokenEngine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "ERROR");
    assert.equal(evaluation.decision, null);
    assert.equal(evaluation.risk, null);
    const w = evaluation.warnings[0];
    assert.equal(w.source, "decision-engine");
    assert.match(w.message, /decision boom/);
    assert.match(evaluation.reasonSummary, /ERROR.*decision boom/);
  });
});

describe("SignalEngine — risk engine exception", () => {
  it("returns ERROR when risk engine throws", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      riskRules: [new ThrowingRiskRule()],
    });
    // RiskEngine internally isolates rule throws → UNKNOWN blocker →
    // REJECTED. To exercise ERROR path we must make
    // RiskEngine.evaluate itself throw.
    const brokenEngine = new SignalEngine({
      decisionEngine: new DecisionEngine({
        rules: [directionalRule("bull", 40)],
        scoreThreshold: 10,
        minConfidenceForAction: 25,
        expectedRuleCount: 1,
        now: () => new Date("2026-07-13T12:00:00Z"),
        idFactory: () => "decision-id",
        performanceNow: (() => {
          let t = 0;
          return () => (t += 1);
        })(),
      }),
      riskEngine: {
        evaluate: () => {
          throw new Error("risk engine crash");
        },
      } as unknown as RiskEngine,
      instrumentResolver: () => buildInstrument(),
      now: () => new Date("2026-07-13T12:00:05Z"),
      idFactory: () => "signal-id",
      performanceNow: (() => {
        let t = 0;
        return () => (t += 1);
      })(),
    });
    const sane = engine.evaluate(fixtureSnapshot());
    assert.equal(sane.status, "REJECTED"); // risk rule threw → UNKNOWN blocker

    const evaluation = brokenEngine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "ERROR");
    assert.equal(evaluation.decision?.action, "LONG");
    assert.equal(evaluation.risk, null);
    const w = evaluation.warnings[0];
    assert.equal(w.source, "risk-engine");
    assert.match(w.message, /risk engine crash/);
  });
});

describe("SignalEngine — instrument resolver", () => {
  it("returns ERROR when the resolver returns undefined", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      resolver: () => undefined,
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "ERROR");
    assert.equal(evaluation.decision?.action, "LONG");
    assert.equal(evaluation.risk, null);
    assert.equal(evaluation.warnings[0].code, "INSTRUMENT_NOT_FOUND");
  });

  it("returns ERROR when the resolver throws", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      resolver: () => {
        throw new Error("registry offline");
      },
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "ERROR");
    assert.equal(evaluation.warnings[0].code, "INSTRUMENT_RESOLVER_EXCEPTION");
    assert.match(evaluation.warnings[0].message, /registry offline/);
  });
});

// ---------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------

describe("SignalEngine — deep freeze", () => {
  function build(): SignalEvaluation {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      riskRules: [new RiskScoreRule("mild", 10)],
    });
    return engine.evaluate(fixtureSnapshot());
  }

  it("freezes the top-level evaluation", () => {
    const evaluation = build();
    assert.equal(Object.isFrozen(evaluation), true);
    assert.throws(() => {
      (evaluation as { status: string }).status = "REJECTED";
    });
  });

  it("freezes warnings, metadata and engineVersions", () => {
    const evaluation = build();
    assert.equal(Object.isFrozen(evaluation.warnings), true);
    assert.equal(Object.isFrozen(evaluation.metadata), true);
    assert.equal(Object.isFrozen(evaluation.metadata.engineVersions), true);
    assert.throws(() => {
      (evaluation.warnings as SignalWarning[]).push({
        code: "x",
        message: "y",
        source: "signal-engine",
      });
    });
  });

  it("preserves nested freezes from Decision and Risk engines", () => {
    const evaluation = build();
    assert.ok(evaluation.decision);
    assert.ok(evaluation.risk);
    assert.equal(Object.isFrozen(evaluation.decision), true);
    assert.equal(Object.isFrozen(evaluation.risk), true);
  });
});

// ---------------------------------------------------------------------------
// evaluateMany
// ---------------------------------------------------------------------------

describe("SignalEngine — evaluateMany", () => {
  it("evaluates each snapshot independently and preserves order", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      riskRules: [new RiskScoreRule("mild", 10)],
    });
    const a = fixtureSnapshot();
    const b = buildSnapshot({ instrumentId: "other_fut" });
    const c = buildSnapshot({ instrumentId: "third_fut" });
    const results = engine.evaluateMany([a, b, c]);
    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.instrumentId),
      ["ctx_fut", "other_fut", "third_fut"],
    );
    for (const r of results) {
      assert.equal(r.status, "GENERATED");
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata / deterministic clocks
// ---------------------------------------------------------------------------

describe("SignalEngine — engine metadata", () => {
  it("populates engineVersions for signal + decision + risk when they run", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      riskRules: [new RiskScoreRule("a", 5)],
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(
      evaluation.metadata.engineVersions.signal,
      SIGNAL_ENGINE_VERSION,
    );
    assert.equal(typeof evaluation.metadata.engineVersions.decision, "string");
    assert.equal(typeof evaluation.metadata.engineVersions.risk, "string");
  });

  it("omits risk engineVersion when risk did not run (HOLD)", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("weak", 2)],
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "HOLD");
    assert.equal(evaluation.metadata.engineVersions.risk, undefined);
  });

  it("omits both engineVersions when the pipeline errored before decision", () => {
    const brokenEngine = new SignalEngine({
      decisionEngine: {
        evaluate: () => {
          throw new Error("boom");
        },
      } as unknown as DecisionEngine,
      riskEngine: new RiskEngine({ rules: [] }),
      instrumentResolver: () => buildInstrument(),
      now: () => new Date("2026-07-13T12:00:05Z"),
      idFactory: () => "sid",
      performanceNow: (() => {
        let t = 0;
        return () => (t += 1);
      })(),
    });
    const evaluation = brokenEngine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.status, "ERROR");
    assert.equal(evaluation.metadata.engineVersions.decision, undefined);
    assert.equal(evaluation.metadata.engineVersions.risk, undefined);
    assert.equal(evaluation.metadata.engineVersions.signal, SIGNAL_ENGINE_VERSION);
  });
});

describe("SignalEngine — deterministic clocks", () => {
  it("uses injected now(), idFactory() and performanceNow()", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      riskRules: [new RiskScoreRule("mild", 10)],
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.equal(evaluation.signalId, "signal-id");
    assert.equal(
      evaluation.generatedAt.toISOString(),
      "2026-07-13T12:00:05.000Z",
    );
    assert.equal(evaluation.metadata.evaluationTimeMs, 1);
  });

  it("falls back to performance.now() when no clock is injected", () => {
    const engine = new SignalEngine({
      decisionEngine: new DecisionEngine({
        rules: [directionalRule("bull", 40)],
        scoreThreshold: 10,
        minConfidenceForAction: 25,
        expectedRuleCount: 1,
      }),
      riskEngine: new RiskEngine({ rules: [] }),
      instrumentResolver: (id: string) => buildInstrument({ id }),
    });
    const evaluation = engine.evaluate(fixtureSnapshot());
    assert.ok(
      evaluation.metadata.evaluationTimeMs >= 0,
      `got ${evaluation.metadata.evaluationTimeMs}`,
    );
    assert.ok(evaluation.signalId.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Construction guardrails
// ---------------------------------------------------------------------------

describe("SignalEngine — construction", () => {
  it("throws when decisionEngine is missing", () => {
    assert.throws(
      () =>
        new SignalEngine({
          decisionEngine: undefined as unknown as DecisionEngine,
          riskEngine: new RiskEngine({ rules: [] }),
          instrumentResolver: () => buildInstrument(),
        }),
      /decisionEngine is required/,
    );
  });

  it("throws when riskEngine is missing", () => {
    assert.throws(
      () =>
        new SignalEngine({
          decisionEngine: new DecisionEngine({ rules: [] }),
          riskEngine: undefined as unknown as RiskEngine,
          instrumentResolver: () => buildInstrument(),
        }),
      /riskEngine is required/,
    );
  });

  it("throws when instrumentResolver is missing", () => {
    assert.throws(
      () =>
        new SignalEngine({
          decisionEngine: new DecisionEngine({ rules: [] }),
          riskEngine: new RiskEngine({ rules: [] }),
          instrumentResolver: undefined as unknown as InstrumentResolver,
        }),
      /instrumentResolver is required/,
    );
  });
});

// touch fixture type to keep unused-import guard silent if strict rules land
const _i: Instrument = buildInstrument();
void _i;

// ---------------------------------------------------------------------------
// PR15.4 §14.3 — metadata.strategyId stamped for every SignalStatus when
// attribution is provided; undefined when it isn't. Real SignalEngine +
// runSignalPipeline drive the check across GENERATED / HOLD / BLOCKED /
// REJECTED / ERROR.
// ---------------------------------------------------------------------------

describe("SignalEngine — PR15.4 §14.3 attribution.strategyId per SignalStatus", () => {
  const ATTRIBUTION = { strategyId: "test_v1", intendedAction: "LONG" as const };

  it("GENERATED: metadata.strategyId equals attribution.strategyId", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      riskRules: [new RiskScoreRule("mild", 10)],
    });
    const evaluation = engine.evaluate(fixtureSnapshot(), ATTRIBUTION);
    assert.equal(evaluation.status, "GENERATED");
    assert.equal(evaluation.metadata.strategyId, ATTRIBUTION.strategyId);
  });

  it("HOLD: metadata.strategyId equals attribution.strategyId", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("weak", 2)],
    });
    const evaluation = engine.evaluate(fixtureSnapshot(), ATTRIBUTION);
    assert.equal(evaluation.status, "HOLD");
    assert.equal(evaluation.metadata.strategyId, ATTRIBUTION.strategyId);
  });

  it("BLOCKED (decision blocker): metadata.strategyId equals attribution.strategyId", () => {
    const { engine } = buildEngine({
      decisionRules: [
        directionalRule("bull", 40),
        decisionBlockerRule("stale"),
      ],
    });
    const evaluation = engine.evaluate(fixtureSnapshot(), ATTRIBUTION);
    assert.equal(evaluation.status, "BLOCKED");
    assert.equal(evaluation.metadata.strategyId, ATTRIBUTION.strategyId);
  });

  it("BLOCKED (attribution direction gate): metadata.strategyId equals attribution.strategyId", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bear", -40)],
      riskRules: [new RiskScoreRule("mild", 10)],
    });
    const evaluation = engine.evaluate(fixtureSnapshot(), ATTRIBUTION);
    assert.equal(evaluation.status, "BLOCKED");
    assert.equal(evaluation.blockers.length, 1);
    assert.equal(evaluation.blockers[0].source, "attribution");
    assert.equal(evaluation.metadata.strategyId, ATTRIBUTION.strategyId);
  });

  it("REJECTED: metadata.strategyId equals attribution.strategyId", () => {
    const { engine } = buildEngine({
      decisionRules: [directionalRule("bull", 40)],
      riskRules: [new RiskBlockerRule()],
    });
    const evaluation = engine.evaluate(fixtureSnapshot(), ATTRIBUTION);
    assert.equal(evaluation.status, "REJECTED");
    assert.equal(evaluation.metadata.strategyId, ATTRIBUTION.strategyId);
  });

  it("ERROR: metadata.strategyId equals attribution.strategyId", () => {
    const brokenEngine = new SignalEngine({
      decisionEngine: {
        evaluate: () => {
          throw new Error("boom");
        },
      } as unknown as DecisionEngine,
      riskEngine: new RiskEngine({ rules: [] }),
      instrumentResolver: () => buildInstrument(),
      now: () => new Date("2026-07-13T12:00:05Z"),
      idFactory: () => "signal-id",
      performanceNow: (() => {
        let t = 0;
        return () => (t += 1);
      })(),
    });
    const evaluation = brokenEngine.evaluate(fixtureSnapshot(), ATTRIBUTION);
    assert.equal(evaluation.status, "ERROR");
    assert.equal(evaluation.metadata.strategyId, ATTRIBUTION.strategyId);
  });

  it("without attribution: metadata.strategyId is undefined for every status", () => {
    const cases: Array<{ status: string; make: () => SignalEngine }> = [
      {
        status: "GENERATED",
        make: () =>
          buildEngine({
            decisionRules: [directionalRule("bull", 40)],
            riskRules: [new RiskScoreRule("mild", 10)],
          }).engine,
      },
      {
        status: "HOLD",
        make: () =>
          buildEngine({ decisionRules: [directionalRule("weak", 2)] }).engine,
      },
      {
        status: "BLOCKED",
        make: () =>
          buildEngine({
            decisionRules: [
              directionalRule("bull", 40),
              decisionBlockerRule("stale"),
            ],
          }).engine,
      },
      {
        status: "REJECTED",
        make: () =>
          buildEngine({
            decisionRules: [directionalRule("bull", 40)],
            riskRules: [new RiskBlockerRule()],
          }).engine,
      },
      {
        status: "ERROR",
        make: () =>
          new SignalEngine({
            decisionEngine: {
              evaluate: () => {
                throw new Error("boom");
              },
            } as unknown as DecisionEngine,
            riskEngine: new RiskEngine({ rules: [] }),
            instrumentResolver: () => buildInstrument(),
            now: () => new Date("2026-07-13T12:00:05Z"),
            idFactory: () => "signal-id",
            performanceNow: (() => {
              let t = 0;
              return () => (t += 1);
            })(),
          }),
      },
    ];
    for (const c of cases) {
      const evaluation = c.make().evaluate(fixtureSnapshot());
      assert.equal(evaluation.status, c.status);
      assert.equal(evaluation.metadata.strategyId, undefined);
    }
  });
});
