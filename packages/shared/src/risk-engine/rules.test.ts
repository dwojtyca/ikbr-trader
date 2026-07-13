import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSnapshot,
  sampleCalendarEvent,
} from "../decision-engine/snapshot.testfixture.js";
import {
  BrokerEnvironmentRule,
  DecisionConfidenceRule,
  HighImpactEventRule,
  InstrumentExecutionRule,
  MarketFreshnessRule,
  OvernightRule,
} from "./rules.js";
import { buildDecision, buildInstrument } from "./risk-input.testfixture.js";
import type { RiskInput } from "./types.js";

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    decision: overrides.decision ?? buildDecision(),
    snapshot: overrides.snapshot ?? buildSnapshot({ overallStatus: "fresh" }),
    instrument: overrides.instrument ?? buildInstrument(),
  };
}

describe("DecisionConfidenceRule", () => {
  it("passes when confidence is at or above the threshold", () => {
    const rule = new DecisionConfidenceRule({ minConfidence: 50 });
    const outcome = rule.evaluate(
      input({ decision: buildDecision({ confidence: 50 }) }),
    );
    assert.equal(outcome.blockers.length, 0);
    assert.equal(outcome.scoreContribution, 0);
  });

  it("blocks with LOW_CONFIDENCE when confidence is below threshold", () => {
    const rule = new DecisionConfidenceRule({ minConfidence: 50 });
    const outcome = rule.evaluate(
      input({ decision: buildDecision({ confidence: 20 }) }),
    );
    assert.equal(outcome.blockers[0].code, "LOW_CONFIDENCE");
    assert.ok(outcome.scoreContribution > 0);
  });
});

describe("HighImpactEventRule", () => {
  const rule = new HighImpactEventRule({ thresholdMs: 60 * 60_000 });

  it("blocks when a high-impact event is within the window", () => {
    const outcome = rule.evaluate(
      input({
        snapshot: buildSnapshot({
          calendar: {
            kind: "present",
            data: {
              upcomingEvents: [],
              nextHighImpactEvent: sampleCalendarEvent(30),
            },
          },
        }),
      }),
    );
    assert.equal(outcome.blockers[0].code, "HIGH_IMPACT_EVENT");
    assert.ok(outcome.scoreContribution > 0);
  });

  it("passes when the event is beyond the window", () => {
    const outcome = rule.evaluate(
      input({
        snapshot: buildSnapshot({
          calendar: {
            kind: "present",
            data: {
              upcomingEvents: [],
              nextHighImpactEvent: sampleCalendarEvent(240),
            },
          },
        }),
      }),
    );
    assert.equal(outcome.blockers.length, 0);
  });

  it("passes when no high-impact event is reported", () => {
    const outcome = rule.evaluate(input());
    assert.equal(outcome.blockers.length, 0);
  });
});

describe("MarketFreshnessRule", () => {
  const rule = new MarketFreshnessRule();

  it("passes on fresh / partial snapshots", () => {
    for (const status of ["fresh", "partial"] as const) {
      const outcome = rule.evaluate(
        input({ snapshot: buildSnapshot({ overallStatus: status }) }),
      );
      assert.equal(outcome.blockers.length, 0);
      assert.equal(outcome.scoreContribution, 0);
    }
  });

  it("blocks with STALE_SNAPSHOT on stale snapshots", () => {
    const outcome = rule.evaluate(
      input({ snapshot: buildSnapshot({ overallStatus: "stale" }) }),
    );
    assert.equal(outcome.blockers[0].code, "STALE_SNAPSHOT");
    assert.equal(outcome.scoreContribution, 30);
  });

  it("blocks with UNAVAILABLE_SNAPSHOT and heavier score on unavailable snapshots", () => {
    const outcome = rule.evaluate(
      input({ snapshot: buildSnapshot({ overallStatus: "unavailable" }) }),
    );
    assert.equal(outcome.blockers[0].code, "UNAVAILABLE_SNAPSHOT");
    assert.equal(outcome.scoreContribution, 60);
  });
});

describe("InstrumentExecutionRule", () => {
  const rule = new InstrumentExecutionRule();

  it("passes when executionEnabled is true", () => {
    const outcome = rule.evaluate(input());
    assert.equal(outcome.blockers.length, 0);
  });

  it("blocks with INSTRUMENT_DISABLED when executionEnabled is false", () => {
    const outcome = rule.evaluate(
      input({ instrument: buildInstrument({ executionEnabled: false }) }),
    );
    assert.equal(outcome.blockers[0].code, "INSTRUMENT_DISABLED");
  });
});

describe("OvernightRule", () => {
  it("passes when the instrument allows overnight regardless of session", () => {
    const rule = new OvernightRule({ isInSession: () => false });
    const outcome = rule.evaluate(
      input({ instrument: buildInstrument({ allowOvernight: true }) }),
    );
    assert.equal(outcome.blockers.length, 0);
  });

  it("passes when overnight is disallowed but the instrument is in session", () => {
    const rule = new OvernightRule({ isInSession: () => true });
    const outcome = rule.evaluate(
      input({ instrument: buildInstrument({ allowOvernight: false }) }),
    );
    assert.equal(outcome.blockers.length, 0);
  });

  it("blocks with OVERNIGHT_NOT_ALLOWED when out of session and overnight disallowed", () => {
    const rule = new OvernightRule({ isInSession: () => false });
    const outcome = rule.evaluate(
      input({ instrument: buildInstrument({ allowOvernight: false }) }),
    );
    assert.equal(outcome.blockers[0].code, "OVERNIGHT_NOT_ALLOWED");
  });

  it("defaults to permissive when no isInSession predicate is provided", () => {
    const rule = new OvernightRule();
    const outcome = rule.evaluate(
      input({ instrument: buildInstrument({ allowOvernight: false }) }),
    );
    assert.equal(outcome.blockers.length, 0);
  });
});

describe("BrokerEnvironmentRule", () => {
  const rule = new BrokerEnvironmentRule({ expectedEnvironment: "paper" });

  it("passes when the broker environment matches", () => {
    const outcome = rule.evaluate(
      input({
        snapshot: buildSnapshot({
          brokerState: {
            kind: "present",
            data: { accountEnvironment: "paper", openOrders: [] },
          },
        }),
      }),
    );
    assert.equal(outcome.blockers.length, 0);
  });

  it("blocks with BROKER_ENVIRONMENT_MISMATCH when environments differ", () => {
    const outcome = rule.evaluate(
      input({
        snapshot: buildSnapshot({
          brokerState: {
            kind: "present",
            data: { accountEnvironment: "live", openOrders: [] },
          },
        }),
      }),
    );
    assert.equal(outcome.blockers[0].code, "BROKER_ENVIRONMENT_MISMATCH");
  });

  it("passes when broker data is unavailable (no evidence of mismatch)", () => {
    const outcome = rule.evaluate(
      input({
        snapshot: buildSnapshot({ brokerState: { kind: "unavailable" } }),
      }),
    );
    assert.equal(outcome.blockers.length, 0);
  });
});
