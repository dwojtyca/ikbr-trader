import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  awaitExactlyOneContractDetail,
  HistoricalClient,
  parseExactIbkrEsContractDetail,
  type ContractDetailsEventPort,
} from "./historical-client.js";

class FakeIb extends EventEmitter implements ContractDetailsEventPort {
  requested?: Record<string, unknown>;
  constructor(private readonly replies: Record<string, unknown>[]) { super(); }
  reqContractDetails(reqId: number, contract: Record<string, unknown>) {
    this.requested = contract;
    queueMicrotask(() => {
      for (const reply of this.replies) this.emit("contractDetails", reqId, reply);
      this.emit("contractDetailsEnd", reqId);
    });
  }
}

class FakeHistoricalIb extends EventEmitter {
  calls: unknown[][] = [];

  constructor(private readonly reply: "bars" | "terminal-error") { super(); }

  connect() { queueMicrotask(() => this.emit("nextValidId", 1)); }
  disconnect() { this.emit("disconnected"); }

  reqHistoricalData(...args: unknown[]) {
    this.calls.push(args);
    const reqId = args[0] as number;
    queueMicrotask(() => {
      if (this.reply === "terminal-error") {
        this.emit("error", new Error("sensitive broker text DU1234567"), { id: reqId, code: 162 });
        return;
      }
      this.emit("historicalData", reqId, "1750000000", 6000, 6000.25, 5999.75, 6000, 123);
      this.emit("historicalData", reqId, "finished-20250901  00:00:00-20250905  00:00:00", 0, 0, 0, 0, 0);
    });
  }
}

const exact = {
  contract: { conId: 101, localSymbol: "ESH5", expiry: "20250321",
    symbol: "ES", secType: "FUT", tradingClass: "ES", exchange: "CME", currency: "USD", multiplier: "50" },
  minTick: 0.25, contractMonth: "202503",
};

describe("exact IBKR ES contract inventory", () => {
  it("fails closed for zero and multiple responses", async () => {
    await assert.rejects(awaitExactlyOneContractDetail(new FakeIb([]), 1, {}, "ESH5"), /exactly one/);
    await assert.rejects(awaitExactlyOneContractDetail(new FakeIb([exact, exact]), 1, {}, "ESH5"), /received 2/);
  });

  it("returns one response and requests no historical bars", async () => {
    const ib = new FakeIb([exact]);
    const result = await awaitExactlyOneContractDetail(ib, 7, { localSymbol: "ESH5", includeExpired: true }, "ESH5");
    assert.equal(result, exact);
    assert.deepEqual(ib.requested, { localSymbol: "ESH5", includeExpired: true });
  });

  it("handles the ib@0.2.9 {id, code} error envelope", async () => {
    const ib = new FakeIb([]);
    ib.reqContractDetails = (reqId) => queueMicrotask(() => ib.emit("error", new Error("sensitive broker text"), { id: reqId, code: 200 }));
    await assert.rejects(awaitExactlyOneContractDetail(ib, 9, {}, "ESH5"), /IBKR 200/);
  });

  it("sanitizes ib@0.2.9 connection errors without waiting for timeout", async () => {
    const ib = new FakeIb([]) as FakeIb & { connect(): void; disconnect(): void };
    ib.connect = () => queueMicrotask(() => ib.emit("error", new Error("sensitive broker text DU1234567"), { id: -1, code: 502 }));
    ib.disconnect = () => {};
    const logs: string[] = [];
    const client = new HistoricalClient({ host: "127.0.0.1", port: 4002, clientId: 1,
      securityType: "FUT", exchange: "CME", currency: "USD" }, (line) => logs.push(line), ib);
    await assert.rejects(client.connect(), /IBKR 502/);
    assert.equal(logs.some((line) => line.includes("sensitive broker text") || line.includes("DU1234567")), false);
    assert.equal(logs.some((line) => line.includes("code=502")), true);
  });

  it("rejects substituted identity and accepts the exact contract", () => {
    assert.equal(parseExactIbkrEsContractDetail(exact, "ESH5").conId, 101);
    assert.throws(() => parseExactIbkrEsContractDetail({ ...exact, contract: { ...exact.contract, conId: 102 } }, "ESM5"), /substituted/);
    assert.throws(() => parseExactIbkrEsContractDetail({ ...exact, minTick: 0.5 }, "ESH5"), /minTick/);
  });

  it("uses the frozen exact historical request tuple", async () => {
    const ib = new FakeHistoricalIb("bars");
    const client = new HistoricalClient({ host: "127.0.0.1", port: 4002, clientId: 1,
      securityType: "FUT", exchange: "CME", currency: "USD" }, () => {}, ib);
    await client.connect();
    const contract = {
      conId: 637533641, symbol: "ES", secType: "FUT", exchange: "CME", currency: "USD",
      multiplier: "50", localSymbol: "ESU5", tradingClass: "ES", expiry: "20250919",
      includeExpired: true,
    };
    const bars = await client.fetchExactHistorical1mChunk(
      { symbol: "ES", conid: "637533641", contract },
      new Date("2025-09-05T12:34:00.000Z"),
      "5 D",
    );
    assert.equal(bars.length, 1);
    assert.deepEqual(ib.calls[0], [
      70001, contract, "20250905-12:34:00", "5 D", "1 min", "TRADES", 0, 2, false,
    ]);
  });

  it("does not retry terminal historical-data errors and sanitizes broker text", async () => {
    const ib = new FakeHistoricalIb("terminal-error");
    const client = new HistoricalClient({ host: "127.0.0.1", port: 4002, clientId: 1,
      securityType: "FUT", exchange: "CME", currency: "USD" }, () => {}, ib);
    await client.connect();
    await assert.rejects(
      client.fetchExactHistorical1mChunk(
        { symbol: "ES", conid: "637533641", contract: { conId: 637533641 } },
        new Date("2025-09-05T12:34:00.000Z"),
        "5 D",
      ),
      (error: Error) => error.message.includes("IBKR 162") && !error.message.includes("DU1234567"),
    );
    assert.equal(ib.calls.length, 1);
  });

  it("does not schedule a request while disconnected and resumes only after nextValidId", async () => {
    const ib = new FakeHistoricalIb("bars");
    const client = new HistoricalClient({ host: "127.0.0.1", port: 4002, clientId: 1,
      securityType: "FUT", exchange: "CME", currency: "USD" }, () => {}, ib);
    await client.connect();
    ib.emit("disconnected");
    const pending = client.fetchExactHistorical1mChunk(
      { symbol: "ES", conid: "637533641", contract: { conId: 637533641 } },
      new Date("2025-09-05T12:34:00.000Z"),
      "5 D",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ib.calls.length, 0);
    ib.emit("connected");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ib.calls.length, 0);
    ib.emit("nextValidId", 2);
    assert.equal((await pending).length, 1);
    assert.equal(ib.calls.length, 1);
  });

  it("fails an in-flight request immediately and gates its retry until session restoration", async () => {
    class DisconnectOnceIb extends EventEmitter {
      calls: unknown[][] = [];
      connect() { queueMicrotask(() => this.emit("nextValidId", 1)); }
      disconnect() { this.emit("disconnected"); }
      reqHistoricalData(...args: unknown[]) {
        this.calls.push(args);
        const reqId = args[0] as number;
        if (this.calls.length === 1) {
          queueMicrotask(() => this.emit("disconnected"));
          return;
        }
        queueMicrotask(() => {
          this.emit("historicalData", reqId, "1750000000", 6000, 6000.25, 5999.75, 6000, 123);
          this.emit("historicalData", reqId, "finished", 0, 0, 0, 0, 0);
        });
      }
    }
    const ib = new DisconnectOnceIb();
    const client = new HistoricalClient({ host: "127.0.0.1", port: 4002, clientId: 1,
      securityType: "FUT", exchange: "CME", currency: "USD" }, () => {}, ib);
    await client.connect();
    const pending = client.fetchExactHistorical1mChunk(
      { symbol: "ES", conid: "637533641", contract: { conId: 637533641 } },
      new Date("2025-09-05T12:34:00.000Z"),
      "5 D",
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ib.calls.length, 1);
    ib.emit("connected");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ib.calls.length, 1);
    ib.emit("nextValidId", 3);
    assert.equal((await pending).length, 1);
    assert.equal(ib.calls.length, 2);
  });
});
