import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertResearchDatabaseUrl,
  parseResearchCandles,
  parseResearchManifest,
} from "./research-dataset-schema.js";
import { researchFixture } from "./research-dataset.test-fixture.js";

describe("PR15.5C research dataset schema", () => {
  it("accepts a canonical multi-contract ES fixture", () => {
    const fixture = researchFixture();
    const manifest = parseResearchManifest(fixture.manifest, fixture.calendars);
    const candles = parseResearchCandles(fixture.raw, manifest, fixture.calendars);
    assert.equal(candles.length, 4);
    assert.equal(candles[0].conId, "101");
    assert.equal(candles[1].conId, "102");
  });

  it("rejects shared, missing, encoded, and differently named databases", () => {
    assert.doesNotThrow(() =>
      assertResearchDatabaseUrl("postgresql://postgres:postgres@localhost:5432/ikbr_trader_backtest_pr15_5a"),
    );
    for (const url of [
      "postgresql://localhost/ikbr_trader_backtest",
      "postgresql://localhost/postgres",
      "postgresql://localhost/",
      "postgresql://localhost/ikbr_trader_backtest_pr15_5a%2Fother",
      "https://localhost/ikbr_trader_backtest_pr15_5a",
    ]) assert.throws(() => assertResearchDatabaseUrl(url));
  });

  it("rejects malformed manifest boundaries and roll policy", () => {
    const fixture = researchFixture();
    assert.throws(() => parseResearchManifest({ ...fixture.manifest, extra: true }, fixture.calendars));
    assert.throws(() => parseResearchManifest({
      ...fixture.manifest,
      rollPolicy: { ...fixture.manifest.rollPolicy, contractOrder: ["102", "101"] },
    }, fixture.calendars), /exact manifest range/);
    assert.throws(() => parseResearchManifest({
      ...fixture.manifest,
      contracts: fixture.manifest.contracts.map((contract, index) =>
        index === 0 ? { ...contract, rollAt: "2026-06-01T22:02:00.000Z" } : contract),
    }, fixture.calendars), /gap-free/);
  });

  it("rejects non-canonical files before accepting candle semantics", () => {
    const fixture = researchFixture();
    const manifest = parseResearchManifest(fixture.manifest, fixture.calendars);
    assert.throws(() => parseResearchCandles(Buffer.from(fixture.raw.toString().trim()), manifest, fixture.calendars), /LF-terminated/);
    assert.throws(() => parseResearchCandles(Buffer.from(fixture.raw.toString().replaceAll("\n", "\r\n")), manifest, fixture.calendars), /LF line endings/);
    const reordered = `${JSON.stringify({ ...fixture.rows[0], symbol: undefined })}\n`;
    assert.throws(() => parseResearchCandles(Buffer.from(reordered), manifest, fixture.calendars));
  });

  it("rejects ordering, duplicate, undeclared, invalid OHLC and closed-session candles", () => {
    const fixture = researchFixture();
    const manifest = parseResearchManifest(fixture.manifest, fixture.calendars);
    const encode = (rows: unknown[]) => Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    assert.throws(() => parseResearchCandles(encode([fixture.rows[1], fixture.rows[0]]), manifest, fixture.calendars), /ordered/);
    assert.throws(() => parseResearchCandles(encode([fixture.rows[0], fixture.rows[0]]), manifest, fixture.calendars), /ordered/);
    assert.throws(() => parseResearchCandles(encode([{ ...fixture.rows[0], conId: "999" }]), manifest, fixture.calendars), /undeclared/);
    const expiredManifest = parseResearchManifest({
      ...fixture.manifest,
      contracts: fixture.manifest.contracts.map((contract, index) => index === 0 ? {
        ...contract,
        expiry: "2026-06-01T22:01:00.000Z",
        lastTradeAt: "2026-06-01T22:01:00.000Z",
      } : contract),
    }, fixture.calendars);
    assert.throws(() => parseResearchCandles(encode([{ ...fixture.rows[0], ts: "2026-06-01T22:02:00.000Z" }]), expiredManifest, fixture.calendars), /lastTradeAt/);
    assert.throws(() => parseResearchCandles(encode([{ ...fixture.rows[0], highTicks: "23900" }]), manifest, fixture.calendars), /OHLC/);
    const maintenanceManifest = parseResearchManifest({
      ...fixture.manifest,
      dateFrom: "2026-06-01T21:00:00.000Z",
      contracts: fixture.manifest.contracts.map((contract, index) =>
        index === 0 ? { ...contract, validFrom: "2026-06-01T21:00:00.000Z" } : contract),
    }, fixture.calendars);
    assert.throws(() => parseResearchCandles(encode([{ ...fixture.rows[0], ts: "2026-06-01T21:00:00.000Z" }]), maintenanceManifest, fixture.calendars), /outside CME session/);
  });
});
