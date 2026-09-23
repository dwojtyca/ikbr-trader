import { IBApi, type Contract } from "@stoqey/ib";
import type { BoundInstrument } from "@ikbr/shared";
import { isWseBound, type WseMarketMetadata } from "./wse-market-rules.js";

export interface WseMetadataSocket {
  on(event: string, callback: (...args: unknown[]) => void): unknown;
  removeAllListeners(): unknown;
  connect(): unknown;
  disconnect(): unknown;
  reqManagedAccts(): unknown;
  reqContractDetails(id: number, contract: Contract): unknown;
  reqMarketRule(id: number): unknown;
}
interface Dependencies { createSocket?: () => WseMetadataSocket; now?: () => number; timeoutMs?: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export class WseMetadataClient {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: { host: string; port: number; clientId: number }, private readonly deps: Dependencies = {}) {}
  load(bound: BoundInstrument, accountId: string): Promise<WseMarketMetadata> {
    const run = this.queue.then(() => this.read(bound, accountId));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private read(bound: BoundInstrument, accountId: string): Promise<WseMarketMetadata> {
    if (!isWseBound(bound) || !accountId) return Promise.reject(new Error("wse_metadata_identity_invalid"));
    const now = this.deps.now ?? Date.now;
    const requestStartedAtMs = now();
    return new Promise((resolve, reject) => {
      const socket = this.deps.createSocket?.() ?? new IBApi(this.config) as unknown as WseMetadataSocket;
      let done = false, ready = false, accountReady = false, requested = false, contractEnded = false;
      let detail: Record<string, unknown> | undefined, count = 0, ruleId: number | undefined;
      const timer = setTimeout(() => finish(new Error("wse_metadata_timeout")), this.deps.timeoutMs ?? 10000);
      const finish = (error?: Error, result?: WseMarketMetadata) => {
        if (done) return;
        done = true; clearTimeout(timer);
        try { socket.disconnect(); } catch { /* Always release this request's listeners. */ }
        socket.removeAllListeners();
        if (error) reject(error); else resolve(result!);
      };
      const listen = (event: string, callback: (...args: unknown[]) => void) => socket.on(event, (...args) => {
        if (done) return;
        try { callback(...args); } catch (error) { finish(error instanceof Error ? error : new Error("wse_metadata_invalid")); }
      });
      const start = () => {
        if (!ready || !accountReady || requested) return;
        requested = true;
        socket.reqContractDetails(1, { conId: bound.conId, symbol: bound.brokerSymbol, secType: "STK" as Contract["secType"],
          exchange: "WSE", currency: "PLN", localSymbol: bound.localSymbol, tradingClass: bound.tradingClass });
      };
      listen("nextValidId", id => {
        if (ready || typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) throw new Error("wse_metadata_readiness_invalid");
        ready = true; socket.reqManagedAccts(); start();
      });
      listen("managedAccounts", accounts => {
        if (typeof accounts !== "string" || !accounts.split(",").map(x => x.trim()).includes(accountId)) throw new Error("wse_metadata_account_mismatch");
        accountReady = true; start();
      });
      listen("contractDetails", (id, value) => {
        if (!requested || contractEnded || id !== 1 || ++count !== 1 || !object(value) || !object(value.contract)) throw new Error("wse_metadata_contract_invalid");
        const contract = value.contract;
        const expected = { conId: bound.conId, symbol: bound.brokerSymbol, secType: "STK", exchange: "WSE", currency: "PLN", localSymbol: bound.localSymbol, tradingClass: bound.tradingClass };
        if (Object.entries(expected).some(([key, v]) => !v || contract[key] !== v)) throw new Error("wse_metadata_contract_mismatch");
        detail = value;
      });
      listen("contractDetailsEnd", id => {
        if (!requested || contractEnded || id !== 1 || count !== 1 || !detail) throw new Error("wse_metadata_contract_invalid");
        contractEnded = true;
        if (typeof detail.validExchanges !== "string" || typeof detail.marketRuleIds !== "string") throw new Error("wse_metadata_rule_mapping_invalid");
        const exchanges = detail.validExchanges.split(",").map(x => x.trim()), ids = detail.marketRuleIds.split(",").map(x => x.trim());
        if (exchanges.length !== ids.length || exchanges.filter(x => x === "WSE").length !== 1) throw new Error("wse_metadata_rule_mapping_invalid");
        const raw = ids[exchanges.indexOf("WSE")];
        if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("wse_metadata_rule_mapping_invalid");
        ruleId = Number(raw); socket.reqMarketRule(ruleId);
      });
      listen("marketRule", (id, bands) => {
        if (!contractEnded || ruleId === undefined || id !== ruleId || !detail || !Array.isArray(bands) || bands.length === 0 || bands.length > 256) throw new Error("wse_metadata_rule_invalid");
        let last = -1;
        const priceIncrements = bands.map(band => {
          if (!object(band) || typeof band.lowEdge !== "number" || !Number.isFinite(band.lowEdge) || typeof band.increment !== "number" || !Number.isFinite(band.increment)
            || band.increment <= 0 || band.lowEdge < 0 || band.lowEdge <= last || (last === -1 && band.lowEdge !== 0)) throw new Error("wse_metadata_rule_invalid");
          last = band.lowEdge; return { lowEdge: band.lowEdge, increment: band.increment };
        });
        if (typeof detail.timeZoneId !== "string" || typeof detail.liquidHours !== "string" || !detail.liquidHours || detail.liquidHours.length > 65536 || !["Europe/Warsaw", "Poland"].includes(detail.timeZoneId)) throw new Error("wse_metadata_session_invalid");
        finish(undefined, Object.freeze({ accountId, instrumentId: bound.instrumentId, conId: bound.conId, symbol: bound.brokerSymbol,
          localSymbol: bound.localSymbol, tradingClass: bound.tradingClass, exchange: "WSE", currency: "PLN", secType: "STK",
          marketRuleId: ruleId, priceIncrements: Object.freeze(priceIncrements.map(band => Object.freeze(band))) as unknown as WseMarketMetadata["priceIncrements"], timeZoneId: detail.timeZoneId, liquidHours: detail.liquidHours, requestStartedAtMs, receivedAtMs: now() }));
      });
      listen("error", (_error, code) => {
        if (code === 2104 || code === 2106 || code === 2158) return;
        throw new Error(`wse_metadata_broker_error:${String(code)}`);
      });
      listen("disconnected", () => finish(new Error("wse_metadata_disconnected")));
      try { socket.connect(); } catch (error) { finish(error instanceof Error ? error : new Error("wse_metadata_connect_failed")); }
    });
  }
}
