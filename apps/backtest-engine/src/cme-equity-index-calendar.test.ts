import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CmeSessionCalendar } from "./cme-session-calendar.js";
import { CME_EQUITY_INDEX_2024_2026, withBuiltInResearchCalendar } from "./cme-equity-index-calendar.js";

describe("bounded PR15.5C.1 CME calendar", () => {
  it("covers the exact research range and explicit closures", () => {
    assert.equal(CME_EQUITY_INDEX_2024_2026.coverageStart, "2024-12-22");
    assert.equal(CME_EQUITY_INDEX_2024_2026.coverageEnd, "2026-08-31");
    const calendar = new CmeSessionCalendar(CME_EQUITY_INDEX_2024_2026);
    assert.equal(calendar.sessionFor(new Date("2025-12-25T16:00:00Z")), null);
    assert.equal(calendar.sessionFor(new Date("2025-11-28T18:30:00Z")), null);
    assert.ok(calendar.sessionFor(new Date("2025-01-09T14:29:00Z")));
    assert.equal(calendar.sessionFor(new Date("2025-01-09T14:30:00Z")), null);
    assert.ok(calendar.sessionFor(new Date("2025-07-03T17:14:00Z")));
    assert.equal(calendar.sessionFor(new Date("2025-07-03T17:15:00Z")), null);
  });

  it("is built in and cannot be overridden through environment JSON", () => {
    assert.equal(withBuiltInResearchCalendar(new Map()).get(CME_EQUITY_INDEX_2024_2026.version), CME_EQUITY_INDEX_2024_2026);
    assert.throws(() => withBuiltInResearchCalendar(new Map([[CME_EQUITY_INDEX_2024_2026.version, { ...CME_EQUITY_INDEX_2024_2026, fullClosures: [] }]])), /may not override/);
  });
});
