import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { FuturesFinalBarCoordinator } from "./futures-final-bar.js";
import {
  NativeFinalBarRequestError,
  TwsClient,
} from "./tws-client.js";
import type { InstrumentSubscription } from "./types.js";

type HistoricalRequest = readonly unknown[];

class FakeIb extends EventEmitter {
  readonly historicalRequests: HistoricalRequest[] = [];
  response: "finished" | 162 | 166 = "finished";

  reqHistoricalData(...args: unknown[]): void {
    this.historicalRequests.push(args);
    const reqId = args[0] as number;
    queueMicrotask(() => {
      if (this.response === "finished") {
        this.emit("historicalData", reqId, "finished");
      } else {
        this.emit("error", new Error("broker detail must not escape"), {
          id: reqId,
          code: this.response,
        });
      }
    });
  }
}

const config = {
  host: "127.0.0.1",
  port: 4002,
  clientId: 71,
  securityType: "STK",
  exchange: "SMART",
  currency: "USD",
  marketDataType: 1,
};

const esSubscription: InstrumentSubscription = {
  symbol: "ES",
  conid: "495512552",
  contract: {
    conId: 495512552,
    symbol: "ES",
    secType: "FUT",
    expiry: "20250620",
    multiplier: "50",
    exchange: "CME",
    currency: "USD",
    localSymbol: "ESM5",
    tradingClass: "ES",
  },
  instrumentContract: {
    symbol: "ES",
    conid: "495512552",
    secType: "FUT",
    exchange: "CME",
    currency: "USD",
    localSymbol: "ESM5",
    tradingClass: "ES",
    minTick: 0.25,
    source: "ibkr",
  },
};

function makeClient(
  ib: FakeIb,
  dependencies: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): TwsClient {
  return new TwsClient(config, () => {}, () => {}, { ib, ...dependencies });
}

describe("TwsClient native ES final-bar broker boundary", () => {
  it("sends the exact expired contract and positional historical-data tuple", async () => {
    const ib = new FakeIb();
    const client = makeClient(ib);
    const minute = new Date("2025-06-02T14:30:00.000Z");

    assert.equal(await client.confirmFinalEsMinute(esSubscription, minute), null);
    assert.equal(ib.historicalRequests.length, 1);
    const [reqId, contract, ...tuple] = ib.historicalRequests[0];
    assert.equal(reqId, 10_000);
    assert.deepEqual(contract, {
      conId: 495512552,
      symbol: "ES",
      secType: "FUT",
      expiry: "20250620",
      lastTradeDateOrContractMonth: "20250620",
      multiplier: "50",
      exchange: "CME",
      currency: "USD",
      localSymbol: "ESM5",
      tradingClass: "ES",
      includeExpired: true,
    });
    assert.deepEqual(tuple, [
      "20250602-14:31:00",
      "120 S",
      "1 min",
      "TRADES",
      0,
      2,
      false,
    ]);
  });

  for (const code of [162, 166] as const) {
    it(`classifies ib@0.2.9 envelope code ${code} as terminal and prevents coordinator retry`, async () => {
      const ib = new FakeIb();
      ib.response = code;
      const client = makeClient(ib);
      const minute = new Date("2025-06-02T14:30:00.000Z");
      let captured: unknown;
      const coordinator = new FuturesFinalBarCoordinator(
        (subscription, requestedMinute) =>
          client.confirmFinalEsMinute(subscription, requestedMinute),
        async () => {},
        {
          settlementDelayMs: 0,
          retryDelayMs: 0,
          maxAttempts: 3,
          isTerminalError: (error) => {
            captured = error;
            return (
              error instanceof NativeFinalBarRequestError && error.terminal
            );
          },
        },
      );

      assert.equal(
        await coordinator.route(
          {
            conid: esSubscription.conid,
            symbol: "ES",
            timeframe: "1m",
            ts: minute,
            open: 5000,
            high: 5000.25,
            low: 4999.75,
            close: 5000,
            volume: 1,
          },
          esSubscription,
        ),
        false,
      );
      assert.ok(captured instanceof NativeFinalBarRequestError);
      assert.equal(captured.terminal, true);
      assert.equal(captured.message.includes("broker detail"), false);
      assert.equal(ib.historicalRequests.length, 1);
    });
  }

  it("shares one 50-request rolling budget across backfill and native confirmation", async () => {
    const ib = new FakeIb();
    const sleeps: number[] = [];
    const client = makeClient(ib, {
      now: () => 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise<void>(() => {});
      },
    });
    const stock: InstrumentSubscription = {
      symbol: "AAPL",
      conid: "265598",
      contract: { conId: 265598, symbol: "AAPL", secType: "STK" },
    };

    for (let index = 0; index < 49; index += 1) {
      await client.backfillRecentCandles1m([stock], 1);
    }
    await client.confirmFinalEsMinute(
      esSubscription,
      new Date("2025-06-02T14:30:00.000Z"),
    );
    assert.equal(ib.historicalRequests.length, 50);

    void client.backfillRecentCandles1m([stock], 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ib.historicalRequests.length, 50);
    assert.deepEqual(sleeps, [30_000]);
  });
});
