import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROTECTED_RESEARCH_ROUTES, protectedResearchRouteRejection } from "./research-route-guard.js";

const researchUrl = "postgresql://postgres:postgres@localhost:5432/ikbr_trader_backtest_pr15_5a";

describe("PR15.5C HTTP route guard", () => {
  it("rejects every mutable history route and the pre-PR15.5D run route", () => {
    for (const route of PROTECTED_RESEARCH_ROUTES) {
      assert.deepEqual(protectedResearchRouteRejection(researchUrl, route), {
        error: "research_dataset_immutable",
        message: "Mutable history and run routes are disabled for the PR15.5C research database.",
      });
    }
  });

  it("does not change the ordinary mutable backtest database", () => {
    assert.equal(protectedResearchRouteRejection(
      "postgresql://localhost/ikbr_trader_backtest", "/backtest/history"), null);
  });

  it("allows only the dedicated PR15.5D experiment route on the research database", () => {
    assert.equal(protectedResearchRouteRejection(
      researchUrl, "/backtest/research/es-compatibility"), null);
  });
});
