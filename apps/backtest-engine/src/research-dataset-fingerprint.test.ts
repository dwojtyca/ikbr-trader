import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalFingerprintBytes,
  fingerprintResearchDataset,
  ticksToPrice,
} from "./research-dataset-fingerprint.js";
import { parseResearchCandles, parseResearchManifest } from "./research-dataset-schema.js";
import { researchFixture } from "./research-dataset.test-fixture.js";

function parsedFixture() {
  const fixture = researchFixture();
  const manifest = parseResearchManifest(fixture.manifest, fixture.calendars);
  const candles = parseResearchCandles(fixture.raw, manifest, fixture.calendars);
  return { ...fixture, manifest, candles };
}

describe("PR15.5C dataset fingerprint", () => {
  it("matches frozen canonical bytes and golden SHA-256", () => {
    const { manifest, candles } = parsedFixture();
    const bytes = canonicalFingerprintBytes(manifest, candles).toString("utf8");
    assert.ok(bytes.startsWith("IKBR-TRADER-ES-DATASET-FINGERPRINT-V1\n{\"type\":\"dataset\""));
    assert.ok(bytes.endsWith("\n"));
    assert.equal(
      fingerprintResearchDataset(manifest, candles),
      "3a3ad79690f7a41c3b1950ccafa4c5d3f2cc6c29da8d7ad7953e22e35d752c1a",
    );
  });

  it("excludes runtime datasetId and reacts to every durable input class", () => {
    const { manifest, candles } = parsedFixture();
    const baseline = fingerprintResearchDataset(manifest, candles);
    assert.equal(fingerprintResearchDataset({ ...manifest, datasetId: 99 } as typeof manifest, candles), baseline);
    assert.notEqual(fingerprintResearchDataset({
      ...manifest,
      source: { ...manifest.source, version: "2" },
    }, candles), baseline);
    assert.notEqual(fingerprintResearchDataset({
      ...manifest,
      aggregationAlgorithmVersion: "research-cme-aggregate-v1-other" as "research-cme-aggregate-v1",
    }, candles), baseline);
    assert.notEqual(fingerprintResearchDataset({
      ...manifest,
      sessionPolicy: { ...manifest.sessionPolicy, calendarVersion: "other-calendar" },
    }, candles), baseline);
    assert.notEqual(fingerprintResearchDataset({
      ...manifest,
      contracts: manifest.contracts.map((contract, index) =>
        index === 1 ? { ...contract, expiry: "2026-09-18T16:01:00.000Z" } : contract),
    }, candles), baseline);
    assert.notEqual(fingerprintResearchDataset(manifest, candles.map((candle, index) =>
      index === 0 ? { ...candle, closeTicks: "24002" } : candle)), baseline);
  });

  it("sorts contract metadata numerically and converts integer ticks exactly for ES", () => {
    const { manifest, candles } = parsedFixture();
    const reversed = { ...manifest, contracts: [...manifest.contracts].reverse() };
    assert.equal(fingerprintResearchDataset(reversed, candles), fingerprintResearchDataset(manifest, candles));
    assert.equal(ticksToPrice("24001", "0.25"), 6000.25);
  });
});
