import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CmeSessionCalendar } from "./cme-session-calendar.js";
import { CME_EQUITY_INDEX_2024_2026 } from "./cme-equity-index-calendar.js";
import {
  buildIbkrEsInventorySpec,
  candleToResearchRow,
  canonicalChunkChecksum,
  deriveVolumeRollContracts,
  mergeExactResearchRows,
  planAcquisitionChunks,
  priceToQuarterTicks,
  type ResearchCandleRow,
} from "./ibkr-es-acquirer.js";

const expiryDates = ["20250919", "20251219", "20260320", "20260618", "20260918"];

async function buildSpec() {
  let index = 0;
  return buildIbkrEsInventorySpec({
    getServerVersion: () => 176,
    resolveExactExpiredEsContract: async (localSymbol) => {
      const expiryDate = expiryDates[index];
      const result = {
        conId: index + 10,
        localSymbol,
        lastTradeDateOrContractMonth: expiryDate,
        expiryDate,
        expiryDateSource: "ibkr-summary-expiry" as const,
        minTick: 0.25,
        symbol: "ES",
        secType: "FUT",
        tradingClass: "ES",
        exchange: "CME",
        currency: "USD",
        multiplier: "50",
      };
      index += 1;
      return result;
    },
  }, new Date("2026-09-16T12:00:00.000Z"));
}

function volumeRow(conId: number, ts: Date, volume: number): ResearchCandleRow {
  return {
    symbol: "ES",
    conId: String(conId),
    ts: ts.toISOString(),
    openTicks: "24000",
    highTicks: "24000",
    lowTicks: "24000",
    closeTicks: "24000",
    volume: String(volume),
  };
}

function eligibleSessions(
  calendar: CmeSessionCalendar,
  lastTradeAt: string,
): Array<{ id: string; openAt: Date; closeAt: Date }> {
  const sessions = new Map<string, { id: string; openAt: Date; closeAt: Date }>();
  const from = new Date(lastTradeAt).getTime() - 15 * 86_400_000;
  const to = new Date(lastTradeAt).getTime();
  for (let value = from; value <= to; value += 60_000) {
    const session = calendar.sessionFor(new Date(value));
    if (session && session.closeAt.getTime() <= to) sessions.set(session.id, session);
  }
  return [...sessions.values()].sort((a, b) => a.openAt.getTime() - b.openAt.getTime());
}

function volumeRowsForCrossovers(
  spec: Awaited<ReturnType<typeof buildSpec>>,
  calendar: CmeSessionCalendar,
  crossoverSessionIds: readonly string[],
): ResearchCandleRow[] {
  const rows: ResearchCandleRow[] = [];
  for (let index = 0; index < spec.contracts.length - 1; index += 1) {
    const outgoing = spec.contracts[index];
    const incoming = spec.contracts[index + 1];
    const sessions = eligibleSessions(calendar, outgoing.lastTradeAt);
    assert.ok(sessions.some((session) => session.id === crossoverSessionIds[index]));
    for (const session of sessions) {
      rows.push(volumeRow(outgoing.conId, session.openAt, 100));
      rows.push(volumeRow(incoming.conId, session.openAt,
        session.id === crossoverSessionIds[index] ? 101 : 50));
    }
  }
  return rows;
}

describe("IBKR ES acquirer pure boundaries", () => {
  it("builds Stage A sequentially with exact windows and no bar API", async () => {
    const calls: string[] = [];
    const spec = await buildIbkrEsInventorySpec({
      getServerVersion: () => 176,
      resolveExactExpiredEsContract: async (localSymbol) => {
        calls.push(localSymbol);
        const index = calls.length - 1;
        return { conId: index + 10, localSymbol, lastTradeDateOrContractMonth: expiryDates[index],
          expiryDate: expiryDates[index], expiryDateSource: "ibkr-summary-expiry", minTick: 0.25, symbol: "ES", secType: "FUT",
          tradingClass: "ES", exchange: "CME", currency: "USD", multiplier: "50" };
      },
    }, new Date("2026-09-16T12:00:00.000Z"));
    assert.deepEqual(calls, ["ESU5", "ESZ5", "ESH6", "ESM6", "ESU6"]);
    assert.equal(spec.contracts[0].fetchFrom, "2025-06-22T22:00:00.000Z");
    assert.equal(spec.contracts.at(-1)?.fetchTo, "2026-08-31T20:59:00.000Z");
    assert.ok(spec.estimatedHistoricalRequests > 0);
  });

  it("converts only exact quarter-tick prices and safe integer volume", () => {
    assert.equal(priceToQuarterTicks(6000.25), "24001");
    assert.throws(() => priceToQuarterTicks(6000.1), /off the ES/);
    assert.equal(candleToResearchRow({ conid: "10", symbol: "ES", timeframe: "1m", ts: new Date("2026-01-02T03:04:00Z"), open: 1, high: 1.25, low: 0.75, close: 1, volume: 5 }).volume, "5");
  });

  it("deduplicates identical boundaries but rejects conflicting bars", () => {
    const row = { symbol: "ES" as const, conId: "10", ts: "2026-01-02T03:04:00.000Z", openTicks: "4", highTicks: "5", lowTicks: "3", closeTicks: "4", volume: "5" };
    assert.deepEqual(mergeExactResearchRows([row, { ...row }]), [row]);
    assert.throws(() => mergeExactResearchRows([row, { ...row, closeTicks: "5" }]), /Conflicting/);
    assert.equal(canonicalChunkChecksum({ end: "x" }, [row]), canonicalChunkChecksum({ end: "x" }, [{ ...row }]));
  });

  it("plans the approved 102 requests as contiguous, non-overlapping minute ranges", async () => {
    const spec = await buildSpec();
    const plans = spec.contracts.flatMap(planAcquisitionChunks);
    assert.equal(plans.length, 102);
    assert.equal(plans.length, spec.estimatedHistoricalRequests);
    for (const contract of spec.contracts) {
      const chronological = [...planAcquisitionChunks(contract)].reverse();
      assert.equal(chronological[0].from, contract.fetchFrom);
      assert.equal(chronological.at(-1)?.to, contract.fetchTo);
      for (let index = 1; index < chronological.length; index += 1) {
        assert.equal(
          new Date(chronological[index].from).getTime(),
          new Date(chronological[index - 1].to).getTime() + 60_000,
        );
      }
      for (const plan of chronological) {
        const coveredMinutes = (new Date(plan.to).getTime() - new Date(plan.from).getTime()) / 60_000 + 1;
        assert.ok(coveredMinutes > 0 && coveredMinutes <= 5 * 24 * 60);
      }
    }
  });

  it("accepts the four observed late roll-week crossovers and rolls at the next session open", async () => {
    const spec = await buildSpec();
    const calendar = new CmeSessionCalendar(CME_EQUITY_INDEX_2024_2026);
    const observed = ["2025-09-15", "2025-12-15", "2026-03-16", "2026-06-15"];
    const rows = volumeRowsForCrossovers(spec, calendar, observed);
    const result = deriveVolumeRollContracts(spec, mergeExactResearchRows(rows), calendar);
    assert.deepEqual(result.contracts.slice(1).map((contract) => contract.validFrom), [
      "2025-09-15T22:00:00.000Z",
      "2025-12-15T23:00:00.000Z",
      "2026-03-16T22:00:00.000Z",
      "2026-06-15T22:00:00.000Z",
    ]);
    assert.equal(result.transitions.length, 4);
  });

  it("accepts a crossover in the final completed session before lastTradeAt", async () => {
    const spec = await buildSpec();
    const calendar = new CmeSessionCalendar(CME_EQUITY_INDEX_2024_2026);
    const rows = volumeRowsForCrossovers(spec, calendar, [
      "2025-09-18", "2025-12-18", "2026-03-19", "2026-06-17",
    ]);
    const result = deriveVolumeRollContracts(spec, mergeExactResearchRows(rows), calendar);
    assert.equal(result.contracts[1].validFrom, "2025-09-18T22:00:00.000Z");
    assert.equal(result.transitions.length, 4);
  });

  it("does not accept a crossover from a session completing after lastTradeAt", async () => {
    const spec = await buildSpec();
    const calendar = new CmeSessionCalendar(CME_EQUITY_INDEX_2024_2026);
    const outgoing = spec.contracts[0];
    const incoming = spec.contracts[1];
    const rows: ResearchCandleRow[] = eligibleSessions(calendar, outgoing.lastTradeAt).flatMap((session) => [
      volumeRow(outgoing.conId, session.openAt, 100),
      volumeRow(incoming.conId, session.openAt, 50),
    ]);
    const afterLastTrade = new Date("2025-09-19T14:00:00.000Z");
    rows.push(volumeRow(outgoing.conId, afterLastTrade, 1));
    rows.push(volumeRow(incoming.conId, afterLastTrade, 1_000));
    assert.throws(
      () => deriveVolumeRollContracts(spec, mergeExactResearchRows(rows), calendar),
      /INCONCLUSIVE: no timely volume crossover/,
    );
  });

  it("fails closed when no timely volume crossover exists", async () => {
    const spec = await buildSpec();
    const calendar = new CmeSessionCalendar(CME_EQUITY_INDEX_2024_2026);
    const rows: ResearchCandleRow[] = [];
    const outgoing = spec.contracts[0];
    const incoming = spec.contracts[1];
    for (const session of eligibleSessions(calendar, outgoing.lastTradeAt)) {
      rows.push(volumeRow(outgoing.conId, session.openAt, 100));
      rows.push(volumeRow(incoming.conId, session.openAt, 50));
    }
    assert.throws(
      () => deriveVolumeRollContracts(spec, mergeExactResearchRows(rows), calendar),
      /INCONCLUSIVE: no timely volume crossover/,
    );
  });
});
