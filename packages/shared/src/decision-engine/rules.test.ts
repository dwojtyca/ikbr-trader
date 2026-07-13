import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BrokerAvailabilityRule,
  FreshPriceRule,
  HighImpactCalendarRule,
  MissingPriceRule,
  NewsRiskRule,
} from "./rules.js";
import {
  buildSnapshot,
  sampleBrokerData,
  sampleCalendarEvent,
  sampleNewsData,
  samplePriceData,
} from "./snapshot.testfixture.js";

describe("FreshPriceRule", () => {
  const rule = new FreshPriceRule();

  it("supports every snapshot", () => {
    assert.equal(rule.supports(buildSnapshot()), true);
  });

  it("emits a neutral reason when price is fresh", () => {
    const snapshot = buildSnapshot({
      price: { kind: "present", status: "fresh", data: samplePriceData() },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 0);
    assert.equal(outcome.reasons.length, 1);
    assert.equal(outcome.reasons[0].direction, "NEUTRAL");
    assert.equal(outcome.reasons[0].category, "TECHNICAL");
    assert.equal(outcome.scoreContribution, 0);
  });

  it("raises STALE_DATA + warning when price is stale", () => {
    const snapshot = buildSnapshot({
      price: { kind: "present", status: "stale", data: samplePriceData() },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 1);
    assert.equal(outcome.blockers[0].code, "STALE_DATA");
    assert.equal(outcome.warnings.length, 1);
  });

  it("is a no-op when price is unavailable", () => {
    const snapshot = buildSnapshot({ price: { kind: "unavailable" } });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 0);
    assert.equal(outcome.reasons.length, 0);
    assert.equal(outcome.warnings.length, 0);
  });
});

describe("MissingPriceRule", () => {
  const rule = new MissingPriceRule();

  it("raises MISSING_PRICE when price data is null", () => {
    const snapshot = buildSnapshot({ price: { kind: "unavailable" } });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 1);
    assert.equal(outcome.blockers[0].code, "MISSING_PRICE");
  });

  it("stays silent when price data is present", () => {
    const snapshot = buildSnapshot({
      price: { kind: "present", data: samplePriceData() },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 0);
  });
});

describe("HighImpactCalendarRule", () => {
  const rule = new HighImpactCalendarRule({ thresholdMs: 60 * 60_000 });

  it("blocks when the next high-impact event is within the threshold", () => {
    const snapshot = buildSnapshot({
      calendar: {
        kind: "present",
        data: {
          upcomingEvents: [],
          nextHighImpactEvent: sampleCalendarEvent(15),
        },
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 1);
    assert.equal(outcome.blockers[0].code, "HIGH_IMPACT_EVENT");
    assert.match(outcome.blockers[0].message, /FOMC/);
  });

  it("stays silent when the event is beyond the threshold", () => {
    const snapshot = buildSnapshot({
      calendar: {
        kind: "present",
        data: {
          upcomingEvents: [],
          nextHighImpactEvent: sampleCalendarEvent(120),
        },
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 0);
  });

  it("stays silent when the event is in the past", () => {
    const snapshot = buildSnapshot({
      calendar: {
        kind: "present",
        data: {
          upcomingEvents: [],
          nextHighImpactEvent: sampleCalendarEvent(-5),
        },
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 0);
  });

  it("stays silent when there is no next high-impact event", () => {
    const snapshot = buildSnapshot({
      calendar: {
        kind: "present",
        data: { upcomingEvents: [] },
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 0);
  });
});

describe("NewsRiskRule", () => {
  const rule = new NewsRiskRule();

  it("emits a bearish contribution proportional to risk flag count", () => {
    const snapshot = buildSnapshot({
      news: {
        kind: "present",
        data: sampleNewsData({ riskFlags: ["earnings", "lawsuit"] }),
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.scoreContribution, -40);
    assert.equal(outcome.reasons[0].direction, "BEARISH");
    assert.equal(outcome.warnings.length, 1);
  });

  it("caps the risk-flag magnitude", () => {
    const snapshot = buildSnapshot({
      news: {
        kind: "present",
        data: sampleNewsData({
          riskFlags: ["a", "b", "c", "d", "e", "f"],
        }),
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.scoreContribution, -60);
  });

  it("emits a small bullish contribution on positive sentiment (no flags)", () => {
    const snapshot = buildSnapshot({
      news: {
        kind: "present",
        data: sampleNewsData({ sentiment: "positive" }),
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.scoreContribution, 15);
    assert.equal(outcome.reasons[0].direction, "BULLISH");
  });

  it("emits a small bearish contribution on negative sentiment (no flags)", () => {
    const snapshot = buildSnapshot({
      news: {
        kind: "present",
        data: sampleNewsData({ sentiment: "negative" }),
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.scoreContribution, -15);
    assert.equal(outcome.reasons[0].direction, "BEARISH");
  });

  it("is silent on neutral / mixed sentiment", () => {
    for (const sentiment of ["neutral", "mixed"] as const) {
      const snapshot = buildSnapshot({
        news: {
          kind: "present",
          data: sampleNewsData({ sentiment }),
        },
      });
      const outcome = rule.evaluate(snapshot);
      assert.equal(outcome.scoreContribution, 0);
      assert.equal(outcome.reasons.length, 0);
    }
  });

  it("is a no-op when news data is unavailable", () => {
    const snapshot = buildSnapshot({ news: { kind: "unavailable" } });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.scoreContribution, 0);
    assert.equal(outcome.reasons.length, 0);
    assert.equal(outcome.blockers.length, 0);
  });
});

describe("BrokerAvailabilityRule", () => {
  const rule = new BrokerAvailabilityRule();

  it("raises BROKER_UNAVAILABLE when broker data is null", () => {
    const snapshot = buildSnapshot({ brokerState: { kind: "unavailable" } });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 1);
    assert.equal(outcome.blockers[0].code, "BROKER_UNAVAILABLE");
  });

  it("emits a neutral reason and no warnings when the broker is healthy", () => {
    const snapshot = buildSnapshot({
      brokerState: {
        kind: "present",
        data: sampleBrokerData({ buyingPower: 100_000 }),
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 0);
    assert.equal(outcome.reasons.length, 1);
    assert.equal(outcome.reasons[0].direction, "NEUTRAL");
    assert.match(outcome.reasons[0].message, /paper/);
    assert.equal(outcome.warnings.length, 0);
  });

  it("warns when buying power is 0 but does not block", () => {
    const snapshot = buildSnapshot({
      brokerState: {
        kind: "present",
        data: sampleBrokerData({ buyingPower: 0 }),
      },
    });
    const outcome = rule.evaluate(snapshot);
    assert.equal(outcome.blockers.length, 0);
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0], /zero buying power/);
  });
});
