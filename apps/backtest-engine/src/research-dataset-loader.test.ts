import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueryResult } from "pg";
import { loadRegisteredResearchDataset, type ResearchDatasetQueryPort } from "./research-dataset-loader.js";
import {
  RESEARCH_ES_DATASET_FINGERPRINT,
  RESEARCH_ES_EXPERIMENT_ID,
  RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
  RESEARCH_ES_PROVENANCE_ID,
} from "./research-run-request.js";

const researchUrl = "postgresql://localhost/ikbr_trader_backtest_pr15_5a";
const request = {
  experimentId: RESEARCH_ES_EXPERIMENT_ID,
  specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
  implementationCommitSha: "a".repeat(40),
  provenanceId: RESEARCH_ES_PROVENANCE_ID,
  datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
} as const;

const contractValues = [
  ["637533641", "ESU5", "2025-09-19T13:30:00.000Z", "2025-06-22T22:00:00.000Z", "2025-09-15T21:59:00.000Z", "2025-09-15T22:00:00.000Z"],
  ["495512563", "ESZ5", "2025-12-19T14:30:00.000Z", "2025-09-15T22:00:00.000Z", "2025-12-15T22:59:00.000Z", "2025-12-15T23:00:00.000Z"],
  ["649180695", "ESH6", "2026-03-20T13:30:00.000Z", "2025-12-15T23:00:00.000Z", "2026-03-16T21:59:00.000Z", "2026-03-16T22:00:00.000Z"],
  ["649180678", "ESM6", "2026-06-18T13:30:00.000Z", "2026-03-16T22:00:00.000Z", "2026-06-15T21:59:00.000Z", "2026-06-15T22:00:00.000Z"],
  ["649180671", "ESU6", "2026-09-18T13:30:00.000Z", "2026-06-15T22:00:00.000Z", "2026-08-31T20:59:00.000Z", null],
] as const;

function manifest() {
  return {
    schemaVersion: "pr15.5c-es-dataset-v1",
    provenanceId: RESEARCH_ES_PROVENANCE_ID,
    instrument: "ES",
    timeframe: "1m",
    dateFrom: "2025-06-22T22:00:00.000Z",
    dateTo: "2026-08-31T20:59:00.000Z",
    source: {
      provider: "synthetic fixture",
      artifactId: "registered-fixture",
      version: "v1",
      candlesSha256: "9d40e586a77c29f036cf0df270f71ef59bcd36ea3f7625941cd81c99fbef7ca3",
    },
    aggregationAlgorithmVersion: "research-cme-aggregate-v1",
    rollPolicy: {
      version: "ibkr-es-volume-crossover-next-session-v2",
      contractOrder: contractValues.map(([conId]) => conId),
    },
    sessionPolicy: {
      template: "cme_equity_index",
      timezone: "America/Chicago",
      calendarVersion: "cme-equity-index-2024-2026-v1",
    },
    contracts: contractValues.map(([conId, localSymbol, lastTradeAt, validFrom, validTo, rollAt]) => ({
      conId, localSymbol, symbol: "ES", tradingClass: "ES", exchange: "CME", currency: "USD",
      expiry: lastTradeAt, lastTradeAt, validFrom, validTo, rollAt, multiplier: "50", minTick: "0.25",
    })),
  };
}

function result(rows: Record<string, unknown>[]): QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function port(
  datasetPatch: Record<string, unknown> = {},
  readBackPatch: Partial<{ fingerprint: string; candlesCount: number }> = {},
  queries?: string[],
): ResearchDatasetQueryPort {
  let call = 0;
  return {
    async readBackFingerprint() {
      return {
        fingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
        candlesCount: 123,
        ...readBackPatch,
      };
    },
    async query(text) {
      queries?.push(text);
      call += 1;
      if (call === 1) return result([{ database: "ikbr_trader_backtest_pr15_5a", schema: "public", schemas: ["public"] }]);
      return result([{
        id: "7", status: "ready", finalized_at: new Date(),
        provenance_id: RESEARCH_ES_PROVENANCE_ID,
        fingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
        candles_count: "123", manifest_json: manifest(), ...datasetPatch,
      }]);
    },
  };
}

describe("PR15.5D registered dataset loader", () => {
  it("resolves the runtime id only after exact durable identity validation", async () => {
    const queries: string[] = [];
    const loaded = await loadRegisteredResearchDataset(researchUrl, request, port({}, {}, queries));
    assert.equal(loaded.datasetId, 7);
    assert.equal(loaded.fingerprint, RESEARCH_ES_DATASET_FINGERPRINT);
    assert.deepEqual(loaded.manifest.contracts.map((contract) => contract.localSymbol),
      ["ESU5", "ESZ5", "ESH6", "ESM6", "ESU6"]);
    assert.match(queries[0], /array_to_json\(current_schemas\(false\)\)/);
  });

  it("fails closed for database, finalization, fingerprint, and manifest mismatches", async () => {
    await assert.rejects(() => loadRegisteredResearchDataset(
      "postgresql://localhost/ikbr_trader_backtest", request, port()), /exactly/);
    await assert.rejects(() => loadRegisteredResearchDataset(researchUrl, request,
      port({ finalized_at: null })), /not finalized/);
    await assert.rejects(() => loadRegisteredResearchDataset(researchUrl, request,
      port({ fingerprint: "f".repeat(64) })), /identity mismatch/);
    await assert.rejects(() => loadRegisteredResearchDataset(researchUrl, request,
      port({}, { fingerprint: "f".repeat(64) })), /read-back fingerprint mismatch/);
    await assert.rejects(() => loadRegisteredResearchDataset(researchUrl, request,
      port({ manifest_json: { ...manifest(), dateTo: "2026-08-31T20:58:00.000Z" } })), /manifest|validity/i);
  });
});
