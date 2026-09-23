import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TwsClient } from "./tws-client.js";
import type { TickEvent } from "./types.js";
import { MarketRepository } from "./db.js";

class FakeIb extends EventEmitter {
  tickerId = 0;
  reqMktData(id: number): void { this.tickerId = id; }
}

test("quote evidence requires live confirmation and independent side observations", () => {
  const ib = new FakeIb();
  const ticks: TickEvent[] = [];
  let now = 1_000;
  const client = new TwsClient({ host: "unused", port: 0, clientId: 1,
    securityType: "STK", exchange: "SMART", currency: "USD", marketDataType: 1 },
  tick => { ticks.push(tick); }, () => {}, { ib, now: () => now });
  client.addSubscriptions([{ symbol: "TEST", conid: "1" }]);
  const price = (field: number, value: number) => ib.emit("tickPrice", ib.tickerId, field, value);
  price(1, 100);
  assert.equal(ticks.at(-1)?.bidObservedAt, undefined);
  ib.emit("marketDataType", ib.tickerId, 1);
  price(1, 100);
  now = 2_000;
  price(2, 101);
  now = 3_000;
  price(4, 100.5);
  assert.equal(ticks.at(-1)?.bidObservedAt, new Date(1_000).toISOString());
  assert.equal(ticks.at(-1)?.askObservedAt, new Date(2_000).toISOString());
  for (const type of [2, 3, 4]) {
    ib.emit("marketDataType", ib.tickerId, type);
    price(1, 100);
    price(2, 101);
    assert.equal(ticks.at(-1)?.bidObservedAt, undefined);
    assert.equal(ticks.at(-1)?.askObservedAt, undefined);
  }
  ib.emit("marketDataType", ib.tickerId, 1);
  price(66, 99);
  price(67, 100);
  assert.equal(ticks.at(-1)?.bidObservedAt, undefined);
  assert.equal(ticks.at(-1)?.askObservedAt, undefined);
  price(1, 100);
  price(2, 101);
  ib.emit("disconnected");
  price(4, 100.5);
  assert.equal(ticks.at(-1)?.marketDataType, undefined);
  assert.equal(ticks.at(-1)?.bidObservedAt, undefined);
});

test("market state cache preserves side provenance; old caches do not invent it", async () => {
  const repo = Object.create(MarketRepository.prototype) as MarketRepository;
  let stored = "";
  const state = { conid: "1", symbol: "TEST", lastPrice: 100, bid: 99, ask: 101,
    ts: new Date(), bidObservedAt: new Date(1_000).toISOString(),
    askObservedAt: new Date(2_000).toISOString(), marketDataType: 1 };
  await repo.writeMarketState({ set: async (_key, value) => { stored = value; } }, state);
  assert.deepEqual(await repo.readMarketState({ get: async () => stored }, "1"), { ...state, spread: undefined });
  stored = JSON.stringify({ conid: "1", symbol: "TEST", lastPrice: 100, ts: state.ts });
  assert.equal((await repo.readMarketState({ get: async () => stored }, "1"))?.bidObservedAt, undefined);
});
