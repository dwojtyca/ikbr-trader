import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateCmeFuturesCandles, CmeSessionCalendar, parseCmeCalendarsJson } from "./cme-session-calendar.js";

const calendar = new CmeSessionCalendar({
  version: "fixture-v1", coverageStart: "2026-01-01", coverageEnd: "2026-12-31",
  fullClosures: ["2026-12-25"], earlyCloses: { "2026-11-27": "12:15" },
});

describe("CME equity index session calendar", () => {
  it("assigns the overnight session and excludes maintenance/weekend", () => {
    assert.equal(calendar.sessionFor(new Date("2026-06-02T03:00:00Z"))?.id, "2026-06-02");
    assert.equal(calendar.sessionFor(new Date("2026-06-01T21:30:00Z")), null);
    assert.equal(calendar.sessionFor(new Date("2026-06-06T03:00:00Z")), null);
  });
  it("handles spring and fall DST with Chicago wall-clock opens", () => {
    assert.equal(calendar.sessionFor(new Date("2026-03-09T22:30:00Z"))?.id, "2026-03-10");
    assert.equal(calendar.sessionFor(new Date("2026-11-02T23:30:00Z"))?.id, "2026-11-03");
    const springSunday = new Date("2026-03-08T22:30:00Z");
    assert.equal(calendar.sessionFor(springSunday)?.openAt.toISOString(), "2026-03-08T22:00:00.000Z");
    assert.equal(calendar.completedAt(springSunday, "4h").toISOString(), "2026-03-09T02:00:00.000Z");
    const fallSunday = new Date("2026-11-01T23:30:00Z");
    assert.equal(calendar.sessionFor(fallSunday)?.openAt.toISOString(), "2026-11-01T23:00:00.000Z");
    assert.equal(calendar.completedAt(fallSunday, "4h").toISOString(), "2026-11-02T03:00:00.000Z");
  });
  it("honors closures, early close and coverage", () => {
    assert.equal(calendar.sessionFor(new Date("2026-12-25T16:00:00Z")), null);
    assert.equal(calendar.sessionFor(new Date("2026-11-27T19:00:00Z")), null);
    assert.throws(() => calendar.sessionFor(new Date("2027-01-05T15:00:00Z")), /no coverage/);
    assert.throws(() => parseCmeCalendarsJson("{"), /valid JSON/);
    assert.throws(() => new CmeSessionCalendar({
      version: "bad", coverageStart: "2026-01-01", coverageEnd: "2026-12-31",
      fullClosures: [], earlyCloses: { "2027-01-01": "12:00" },
    }), /Invalid or uncovered early close/);
    assert.throws(() => new CmeSessionCalendar({
      version: "bad", coverageStart: "2026-01-01", coverageEnd: "2026-12-31",
      fullClosures: [], earlyCloses: { "2026-11-27": "17:30" },
    }), /Invalid or uncovered early close/);
  });
  it("exposes completion rather than bucket start", () => {
    const ts = new Date("2026-06-02T03:15:00Z");
    assert.equal(calendar.completedAt(ts, "1h").toISOString(), "2026-06-02T04:00:00.000Z");
    assert.equal(calendar.completedAt(ts, "1d").toISOString(), "2026-06-02T21:00:00.000Z");
  });
  it("aggregates by session and conId without creating a synthetic roll candle", () => {
    const make = (conid: string, iso: string, price: number) => ({
      symbol: "ES", conid, timeframe: "1m" as const, ts: new Date(iso),
      open: price, high: price + 1, low: price - 1, close: price + 0.25, volume: 1,
    });
    const rows = aggregateCmeFuturesCandles([
      make("1", "2026-06-01T22:05:00Z", 5000),
      make("1", "2026-06-01T22:55:00Z", 5001),
      make("2", "2026-06-01T23:05:00Z", 5100),
    ], "1h", calendar);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.conid), ["1", "2"]);
    assert.equal(rows[0].ts.toISOString(), "2026-06-01T22:00:00.000Z");
  });
});
