import { IBApi, type Contract } from "@stoqey/ib";
import type { TradingInstrumentV1 } from "@ikbr/shared";
import {
  configurationMarketRuleId,
  type ConfigurationMetadataUnavailableReason,
  type TradingConfigurationBrokerObservation,
} from "@ikbr/shared/trading-config";

export interface ConfigurationMetadataSocket {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
  reqManagedAccts(): unknown;
  reqContractDetails(id: number, contract: Contract): unknown;
  reqMarketRule?(id: number): unknown;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function candidate(value: unknown): unknown {
  const detail = record(value);
  if (!detail) return value;
  return {
    contract: detail.contract,
    minTick: detail.minTick,
    validExchanges: typeof detail.validExchanges === "string" ? detail.validExchanges.split(",").map(s => s.trim()) : detail.validExchanges,
    marketRuleIds: typeof detail.marketRuleIds === "string" ? detail.marketRuleIds.split(",").map(s => /^[1-9]\d*$/.test(s.trim()) ? Number(s.trim()) : null) : detail.marketRuleIds,
  };
}

export class ConfigurationMetadataClient {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly connection: { host: string; port: number; clientId: number }, private readonly deps: {
    createSocket?: () => ConfigurationMetadataSocket; now?: () => number; timeoutMs?: number;
  } = {}) {}

  load(instrument: TradingInstrumentV1, accountId: string): Promise<TradingConfigurationBrokerObservation> {
    const result = this.queue.then(() => this.read(instrument, accountId));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private read(instrument: TradingInstrumentV1, accountId: string): Promise<TradingConfigurationBrokerObservation> {
    const now = this.deps.now ?? Date.now;
    const requestStartedAt = new Date(now()).toISOString();
    return new Promise(resolve => {
      let socket: ConfigurationMetadataSocket | undefined;
      let done = false, connected = false, accountReady = false, requested = false, ended = false;
      let selectedRule: number | undefined;
      const candidates: unknown[] = [];
      const listeners: Array<[string, (...args: unknown[]) => void]> = [];
      const finish = (reason?: ConfigurationMetadataUnavailableReason, marketRule?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const [event, listener] of listeners) socket?.off(event, listener);
        try { socket?.disconnect(); } catch { /* The result still records the unavailable request. */ }
        resolve(Object.freeze({ requestStartedAt, observedAt: new Date(now()).toISOString(), candidates: Object.freeze(candidates),
          ...(reason ? { unavailableReason: reason } : {}), ...(marketRule === undefined ? {} : { marketRule }) }));
      };
      const timer = setTimeout(() => finish("BROKER_METADATA_TIMEOUT"), this.deps.timeoutMs ?? 10_000);
      const listen = (event: string, action: (...args: unknown[]) => void) => {
        const listener = (...args: unknown[]) => {
          if (done) return;
          try { action(...args); } catch { finish("BROKER_METADATA_ERROR"); }
        };
        listeners.push([event, listener]); socket!.on(event, listener);
      };
      const start = () => {
        if (!connected || !accountReady || requested) return;
        requested = true;
        const c = instrument.contract;
        socket!.reqContractDetails(1, { conId: c.conId, symbol: c.symbol, secType: "STK" as Contract["secType"],
          exchange: c.exchange, primaryExch: c.primaryExchange, currency: c.currency, localSymbol: c.localSymbol, tradingClass: c.tradingClass });
      };
      try {
        socket = this.deps.createSocket?.() ?? new IBApi(this.connection) as unknown as ConfigurationMetadataSocket;
        // IB's socket may report a final asynchronous error after listeners are released.
        socket.on("error", () => {});
        listen("nextValidId", id => {
          if (connected || typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return finish("BROKER_METADATA_ERROR");
          connected = true; socket!.reqManagedAccts(); start();
        });
        listen("managedAccounts", value => {
          if (!accountId || typeof value !== "string" || !value.split(",").map(x => x.trim()).includes(accountId))
            return finish("BROKER_METADATA_ACCOUNT_MISMATCH");
          accountReady = true; start();
        });
        listen("contractDetails", (id, details) => {
          if (id !== 1) return;
          if (!requested || ended) return finish("BROKER_METADATA_ERROR");
          candidates.push(candidate(details));
        });
        listen("contractDetailsEnd", id => {
          if (id !== 1) return;
          if (!requested || ended) return finish("BROKER_METADATA_ERROR");
          ended = true;
          if (candidates.length !== 1) return finish();
          selectedRule = configurationMarketRuleId(candidates[0], instrument.contract.exchange);
          if (selectedRule === undefined) return finish();
          if (!socket!.reqMarketRule) return finish("BROKER_METADATA_API_UNAVAILABLE");
          socket!.reqMarketRule(selectedRule);
        });
        listen("marketRule", (id, bands) => {
          if (id !== selectedRule || selectedRule === undefined) return;
          if (!ended) return finish("BROKER_METADATA_ERROR");
          finish(undefined, { id, bands });
        });
        listen("error", (_error, code) => {
          if (code === 2104 || code === 2106 || code === 2158) return;
          finish("BROKER_METADATA_ERROR");
        });
        listen("disconnected", () => finish("BROKER_METADATA_DISCONNECTED"));
        socket.connect();
      } catch { finish("BROKER_METADATA_CONNECT_FAILED"); }
    });
  }
}
