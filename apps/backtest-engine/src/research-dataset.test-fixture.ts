import { createHash } from "node:crypto";
import type { CmeCalendarDefinition } from "./cme-session-calendar.js";

export const TEST_CALENDAR: CmeCalendarDefinition = {
  version: "cme-test-v1",
  coverageStart: "2026-06-01",
  coverageEnd: "2026-06-03",
  fullClosures: [],
  earlyCloses: {},
};

export function researchFixture() {
  const rows = [
    { symbol: "ES", conId: "101", ts: "2026-06-01T22:00:00.000Z", openTicks: "24000", highTicks: "24004", lowTicks: "23996", closeTicks: "24001", volume: "125" },
    { symbol: "ES", conId: "102", ts: "2026-06-01T22:00:00.000Z", openTicks: "24002", highTicks: "24006", lowTicks: "23998", closeTicks: "24003", volume: "75" },
    { symbol: "ES", conId: "102", ts: "2026-06-01T22:01:00.000Z", openTicks: "24003", highTicks: "24007", lowTicks: "24000", closeTicks: "24006", volume: "140" },
    { symbol: "ES", conId: "102", ts: "2026-06-01T22:02:00.000Z", openTicks: "24006", highTicks: "24008", lowTicks: "24002", closeTicks: "24004", volume: "120" },
  ];
  const raw = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const candlesSha256 = createHash("sha256").update(raw).digest("hex");
  const manifest = {
    schemaVersion: "pr15.5c-es-dataset-v1",
    provenanceId: "synthetic-es-fixture-v1",
    instrument: "ES",
    timeframe: "1m",
    dateFrom: "2026-06-01T22:00:00.000Z",
    dateTo: "2026-06-01T22:02:00.000Z",
    source: {
      provider: "synthetic-test",
      artifactId: "es-fixture",
      version: "1",
      candlesSha256,
    },
    aggregationAlgorithmVersion: "research-cme-aggregate-v1",
    rollPolicy: { version: "fixed-transition-v1", contractOrder: ["101", "102"] },
    sessionPolicy: {
      template: "cme_equity_index",
      timezone: "America/Chicago",
      calendarVersion: TEST_CALENDAR.version,
    },
    contracts: [
      {
        conId: "101", localSymbol: "ESM6", symbol: "ES", tradingClass: "ES",
        exchange: "CME", currency: "USD", expiry: "2026-06-19T16:00:00.000Z",
        lastTradeAt: "2026-06-19T15:59:00.000Z",
        validFrom: "2026-06-01T22:00:00.000Z", validTo: "2026-06-01T22:00:00.000Z",
        rollAt: "2026-06-01T22:01:00.000Z", multiplier: "50", minTick: "0.25",
      },
      {
        conId: "102", localSymbol: "ESU6", symbol: "ES", tradingClass: "ES",
        exchange: "CME", currency: "USD", expiry: "2026-09-18T16:00:00.000Z",
        lastTradeAt: "2026-09-18T15:59:00.000Z",
        validFrom: "2026-06-01T22:01:00.000Z", validTo: "2026-06-01T22:02:00.000Z",
        rollAt: null, multiplier: "50", minTick: "0.25",
      },
    ],
  };
  return { rows, raw, manifest, calendars: new Map([[TEST_CALENDAR.version, TEST_CALENDAR]]) };
}
