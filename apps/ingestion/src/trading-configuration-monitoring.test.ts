import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTradingConfiguration, buildTradingConfigurationProjection } from "@ikbr/shared/trading-config";
import { buildMergedWatchlist } from "./bound-watchlist.js";
import { verifyBoundSubscriptions } from "./binding-verification.js";
import type { InstrumentSubscription } from "./types.js";

const parsed = parseTradingConfiguration(readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8"));
if (!parsed.ok) throw new Error("fixture invalid");
const { authority } = buildTradingConfigurationProjection(parsed.configuration);
const { mergedWatchlist } = buildMergedWatchlist({ authority, legacyWatchlist: [] });
test("bundle monitoring carries primary listing and requires returned listing identity", () => {
  const watch = mergedWatchlist.find(item => item.instrumentId === "xyz_nyse")!;
  assert.equal(watch.primaryExchange, "NYSE");
  const bound = authority.getBoundInstrument("xyz_nyse")!;
  const base = { symbol: "QZXP", conid: String(bound.conId), contract: { symbol: "QZXP", conId: bound.conId,
    exchange: "SMART", currency: "USD", localSymbol: "QZXP", tradingClass: "QZXP", primaryExch: "NYSE" },
    instrumentContract: { minTick: bound.minTick } } as unknown as InstrumentSubscription;
  assert.equal(verifyBoundSubscriptions({ authority, watchlist: mergedWatchlist, subscriptions: [base] }).accepted.length, 1);
  for (const primaryExch of [undefined, "NASDAQ"]) {
    const changed = { ...base, contract: { ...(base.contract as object), primaryExch } };
    const result = verifyBoundSubscriptions({ authority, watchlist: mergedWatchlist, subscriptions: [changed] });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0]!.reason, /primaryExchange/);
  }
});

test("actual TWS contract builder preserves the bundle primary listing", async () => {
  const { TwsClient } = await import("./tws-client.js");
  const client = Object.create(TwsClient.prototype) as {
    buildContractFromInstrument(instrument: typeof mergedWatchlist[number], conId: number): Record<string, unknown>;
  };
  for (const entry of mergedWatchlist) {
    const request = client.buildContractFromInstrument(entry, Number(entry.conid));
    assert.equal(request.primaryExch, entry.primaryExchange);
    assert.equal(request.conId, Number(entry.conid));
  }
});
