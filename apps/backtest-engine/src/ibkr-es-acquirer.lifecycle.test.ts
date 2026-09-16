import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { IBKR_ES_BAR_REQUEST, IBKR_ES_BAR_SOURCE_VERSION, type Candle } from "@ikbr/shared";
import { CME_EQUITY_INDEX_2024_2026 } from "./cme-equity-index-calendar.js";
import {
  acquireApprovedIbkrEsDataset,
  type IbkrHistoricalChunkPort,
} from "./ibkr-es-acquirer.js";
import {
  IBKR_ES_ACQUISITION_SPEC_VERSION,
  IBKR_ES_CALENDAR_VERSION,
  IBKR_ES_ROLL_POLICY_VERSION,
  acquisitionSpecSha256,
  type IbkrEsAcquisitionSpec,
} from "./ibkr-es-acquisition-spec.js";

const targetFrom = "2026-06-01T22:00:00.000Z";
const targetTo = "2026-06-03T20:59:00.000Z";

function compactSpec(): IbkrEsAcquisitionSpec {
  return {
    schemaVersion: IBKR_ES_ACQUISITION_SPEC_VERSION,
    sourceVersion: IBKR_ES_BAR_SOURCE_VERSION,
    createdAt: "2026-09-16T12:00:00.000Z",
    target: { dateFrom: targetFrom, dateTo: targetTo },
    request: { ...IBKR_ES_BAR_REQUEST },
    rollPolicyVersion: IBKR_ES_ROLL_POLICY_VERSION,
    calendarVersion: IBKR_ES_CALENDAR_VERSION,
    pacing: { requestsPer10Minutes: 50, maxConcurrency: 2 },
    contracts: [
      {
        conId: 101, localSymbol: "ESU5", symbol: "ES", secType: "FUT",
        tradingClass: "ES", exchange: "CME", currency: "USD", multiplier: "50",
        minTick: 0.25, lastTradeDateOrContractMonth: "20250919", expiryDate: "20250919",
        expiryDateSource: "ibkr-summary-expiry", lastTradeRuleVersion: "cme-es-quarterly-termination-0830-ct-v1",
        lastTradeAt: "2026-06-03T14:30:00.000Z", fetchFrom: targetFrom,
        fetchTo: "2026-06-03T14:30:00.000Z",
      },
      {
        conId: 202, localSymbol: "ESZ5", symbol: "ES", secType: "FUT",
        tradingClass: "ES", exchange: "CME", currency: "USD", multiplier: "50",
        minTick: 0.25, lastTradeDateOrContractMonth: "20251219", expiryDate: "20251219",
        expiryDateSource: "ibkr-summary-expiry", lastTradeRuleVersion: "cme-es-quarterly-termination-0830-ct-v1",
        lastTradeAt: "2026-06-04T14:30:00.000Z", fetchFrom: targetFrom, fetchTo: targetTo,
      },
    ],
    estimatedHistoricalRequests: 2,
    ibApiServerVersion: 77,
  } as unknown as IbkrEsAcquisitionSpec;
}

function bars(conid: string): Candle[] {
  const result: Candle[] = [];
  const end = conid === "101" ? new Date("2026-06-03T14:30:00.000Z").getTime() : new Date(targetTo).getTime();
  for (let value = new Date(targetFrom).getTime(); value <= end; value += 60_000) {
    const date = new Date(value);
    const hour = date.getUTCHours();
    if (hour === 21) continue;
    result.push({
      symbol: "ES", conid, timeframe: "1m", ts: date,
      open: 6000, high: 6000.25, low: 5999.75, close: 6000,
      volume: conid === "202" && date < new Date("2026-06-02T21:00:00.000Z") ? 20 : 5,
    });
  }
  return result;
}

class FakeHistoricalPort implements IbkrHistoricalChunkPort {
  calls = 0;
  orderCalls = 0;

  constructor(private readonly failOnCall?: number) {}

  async fetchExactHistorical1mChunk(sub: { conid: string }): Promise<Candle[]> {
    this.calls += 1;
    if (this.calls === this.failOnCall) throw new Error("synthetic interruption");
    return bars(sub.conid);
  }

  placeOrder(): never {
    this.orderCalls += 1;
    throw new Error("order API must not be called");
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ibkr-es-acquirer-"));
}

describe("IBKR ES acquisition lifecycle", () => {
  it("rejects an unapproved spec hash before creating acquisition state", async () => {
    const root = await tempRoot();
    try {
      const client = new FakeHistoricalPort();
      await assert.rejects(
        acquireApprovedIbkrEsDataset(compactSpec(), "0".repeat(64), client,
          CME_EQUITY_INDEX_2024_2026, path.join(root, "work"), path.join(root, "final")),
        /SHA-256 mismatch/,
      );
      assert.equal(client.calls, 0);
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("leaves no final bundle on failure, then resumes deterministically and finalizes atomically", async () => {
    const root = await tempRoot();
    const cleanRoot = await tempRoot();
    try {
      const spec = compactSpec();
      const hash = acquisitionSpecSha256(spec);
      const final = path.join(root, "final");
      const interrupted = new FakeHistoricalPort(2);
      await assert.rejects(
        acquireApprovedIbkrEsDataset(spec, hash, interrupted, CME_EQUITY_INDEX_2024_2026,
          path.join(root, "work"), final),
        /synthetic interruption/,
      );
      await assert.rejects(readFile(path.join(final, "manifest.json")), /ENOENT/);
      assert.equal(interrupted.orderCalls, 0);

      const resumed = new FakeHistoricalPort();
      const resumedResult = await acquireApprovedIbkrEsDataset(
        spec, hash, resumed, CME_EQUITY_INDEX_2024_2026, path.join(root, "work"), final,
      );
      assert.equal(resumed.calls, 1);
      assert.equal(resumed.orderCalls, 0);
      assert.equal((await readdir(root)).some((entry) => entry.startsWith("final.tmp-")), false);

      const cleanClient = new FakeHistoricalPort();
      const cleanFinal = path.join(cleanRoot, "final");
      const cleanResult = await acquireApprovedIbkrEsDataset(
        spec, hash, cleanClient, CME_EQUITY_INDEX_2024_2026, path.join(cleanRoot, "work"), cleanFinal,
      );
      assert.equal(cleanClient.calls, 2);
      assert.equal(cleanClient.orderCalls, 0);
      assert.equal(resumedResult.candlesSha256, cleanResult.candlesSha256);
      assert.deepEqual(await readFile(path.join(final, "manifest.json")), await readFile(path.join(cleanFinal, "manifest.json")));
      assert.deepEqual(await readFile(path.join(final, "candles-1m.ndjson")), await readFile(path.join(cleanFinal, "candles-1m.ndjson")));

      const overwriteClient = new FakeHistoricalPort();
      await assert.rejects(
        acquireApprovedIbkrEsDataset(spec, hash, overwriteClient, CME_EQUITY_INDEX_2024_2026,
          path.join(root, "work"), final),
        /Refusing to overwrite/,
      );
      assert.equal(overwriteClient.calls, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cleanRoot, { recursive: true, force: true });
    }
  });

  it("rejects a corrupted resumable chunk instead of refetching it", async () => {
    const root = await tempRoot();
    try {
      const spec = compactSpec();
      const hash = acquisitionSpecSha256(spec);
      await assert.rejects(
        acquireApprovedIbkrEsDataset(spec, hash, new FakeHistoricalPort(2), CME_EQUITY_INDEX_2024_2026,
          path.join(root, "work"), path.join(root, "final")),
        /synthetic interruption/,
      );
      const chunk = path.join(root, "work", hash, "chunks", "101-000.json");
      const saved = JSON.parse(await readFile(chunk, "utf8")) as { checksum: string };
      saved.checksum = "0".repeat(64);
      await writeFile(chunk, `${JSON.stringify(saved)}\n`);
      const client = new FakeHistoricalPort();
      await assert.rejects(
        acquireApprovedIbkrEsDataset(spec, hash, client, CME_EQUITY_INDEX_2024_2026,
          path.join(root, "work"), path.join(root, "final")),
        /Invalid resumable chunk/,
      );
      assert.equal(client.calls, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
