import IB from "ib";
import type { Candle, InstrumentContract } from "@ikbr/shared";
import type { WatchlistInstrument } from "./config.js";

interface HistoricalClientConfig {
  host: string;
  port: number;
  clientId: number;
  securityType: string;
  exchange: string;
  primaryExchange?: string;
  currency: string;
  /** Max historical requests per 10-minute sliding window (IB pacing). */
  pacingPer10Min?: number;
  /** Max concurrent in-flight requests on the socket. */
  maxConcurrency?: number;
}

export interface InstrumentSubscription {
  symbol: string;
  conid: string;
  contract?: Record<string, unknown>;
  displayName?: string;
  instrumentContract?: InstrumentContract;
}

type ContractShape = Record<string, unknown>;
type ContractDetailsShape = {
  contract?: ContractShape;
  summary?: ContractShape;
  longName?: string;
  marketName?: string;
  minTick?: number | string;
};

function toNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function pickContract(details: ContractDetailsShape): ContractShape {
  return details.contract ?? details.summary ?? {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatIbEndDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join(
      "",
    ) +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export class HistoricalClient {
  private readonly ib: any;
  private connected = false;
  private nextReqId = 70_000;
  /** Timestamps (ms) of recent historicalData requests, used for IB pacing. */
  private readonly requestTimes: number[] = [];
  /** Number of in-flight historicalData requests. */
  private inFlight = 0;
  /** Resolvers awaiting a free concurrency slot. */
  private readonly slotWaiters: Array<() => void> = [];
  private readonly pacingPer10Min: number;
  private readonly maxConcurrency: number;

  constructor(
    private readonly config: HistoricalClientConfig,
    private readonly onLog: (line: string) => void,
  ) {
    this.ib = new IB({
      host: config.host,
      port: config.port,
      clientId: config.clientId,
    });
    this.pacingPer10Min = Math.max(1, config.pacingPer10Min ?? 50);
    this.maxConcurrency = Math.max(1, config.maxConcurrency ?? 3);
    this.bindListeners();
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("TWS connect timeout waiting for nextValidId"));
      }, 12_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("nextValidId", onNextValidId);
        this.ib.off("error", onError);
      };

      const onNextValidId = (orderId: number) => {
        this.connected = true;
        this.nextReqId = Math.max(this.nextReqId, Number(orderId) + 1);
        cleanup();
        resolve();
      };

      const onError = (err: Error, code?: number) => {
        if (code === 502 || code === 503 || code === 504) {
          cleanup();
          reject(
            new Error(`TWS socket connection failed (${code}): ${err.message}`),
          );
        }
      };

      this.ib.once("nextValidId", onNextValidId);
      this.ib.on("error", onError);
      this.ib.connect();
    });
  }

  disconnect(): void {
    if (!this.connected) return;
    this.ib.disconnect();
    this.connected = false;
  }

  async resolveContracts(
    instruments: WatchlistInstrument[],
  ): Promise<InstrumentSubscription[]> {
    const out: InstrumentSubscription[] = [];
    for (const instrument of instruments) {
      out.push(await this.resolveContract(instrument));
      await sleep(150);
    }
    return out;
  }

  async fetchHistorical1mRange(
    sub: InstrumentSubscription,
    dateFrom: Date,
    dateTo: Date,
    onChunk?: (candles: Candle[]) => Promise<void>,
  ): Promise<Candle[]> {
    const all: Candle[] = [];
    const chunkMs = 5 * 24 * 60 * 60 * 1000;
    let end = new Date(dateTo);

    while (end.getTime() > dateFrom.getTime()) {
      const chunkStart = new Date(
        Math.max(dateFrom.getTime(), end.getTime() - chunkMs),
      );
      const durationDays = Math.max(
        1,
        Math.ceil(
          (end.getTime() - chunkStart.getTime()) / (24 * 60 * 60 * 1000),
        ),
      );
      const candles = await this.requestHistorical1mChunkWithRetry(
        sub,
        end,
        `${durationDays} D`,
      );
      const filtered = candles.filter(
        (candle) => candle.ts >= dateFrom && candle.ts <= dateTo,
      );
      all.push(...filtered);
      if (filtered.length > 0) await onChunk?.(filtered);
      this.onLog(
        `historical ${sub.symbol}: ${candles.length} candles for chunk ending ${end.toISOString()}`,
      );
      end = new Date(chunkStart.getTime() - 1000);
    }

    const unique = new Map<number, Candle>();
    for (const candle of all) unique.set(candle.ts.getTime(), candle);
    return Array.from(unique.values()).sort(
      (a, b) => a.ts.getTime() - b.ts.getTime(),
    );
  }

  private async requestHistorical1mChunkWithRetry(
    sub: InstrumentSubscription,
    end: Date,
    durationStr: string,
  ): Promise<Candle[]> {
    const attempts = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.acquireRateLimit();
      try {
        return await this.requestHistorical1mChunk(sub, end, durationStr);
      } catch (error) {
        lastError = error as Error;
        if (attempt === attempts) break;
        this.onLog(
          `historical ${sub.symbol}: retry ${attempt}/${attempts - 1} after ${(error as Error).message} for chunk ending ${end.toISOString()}`,
        );
        await sleep(5000 * attempt);
      } finally {
        this.releaseRateLimit();
      }
    }

    throw lastError ?? new Error(`historicalData failed for ${sub.symbol}`);
  }

  /**
   * Block until both a concurrency slot is free AND a pacing token is
   * available. Concurrency limits in-flight requests on the single TWS
   * socket; pacing keeps us below IBKR's documented 60 historicalData
   * requests per 10 minutes (we default to 50 for safety margin).
   */
  private async acquireRateLimit(): Promise<void> {
    while (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
    const windowMs = 10 * 60 * 1000;
    while (true) {
      const now = Date.now();
      while (
        this.requestTimes.length > 0 &&
        now - this.requestTimes[0] > windowMs
      ) {
        this.requestTimes.shift();
      }
      if (this.requestTimes.length < this.pacingPer10Min) {
        this.requestTimes.push(now);
        this.inFlight += 1;
        return;
      }
      const waitMs = windowMs - (now - this.requestTimes[0]) + 50;
      this.onLog(
        `historical pacing wait ${Math.round(waitMs / 1000)}s (${this.requestTimes.length}/${this.pacingPer10Min} in 10min window)`,
      );
      await sleep(Math.min(waitMs, 30_000));
    }
  }

  private releaseRateLimit(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const waiter = this.slotWaiters.shift();
    if (waiter) waiter();
  }

  private async resolveContract(
    instrument: WatchlistInstrument,
  ): Promise<InstrumentSubscription> {
    const symbol = instrument.symbol;
    const directConid = toNum(instrument.conid);
    const directContract = this.buildContractFromInstrument(
      instrument,
      directConid,
    );

    if (directConid) {
      try {
        const details = await this.requestContractDetails(
          symbol,
          directContract,
        );
        const summary = pickContract(details);
        const conid =
          toNum(summary.conId) ?? toNum(summary.conid) ?? directConid;
        if (!conid)
          throw new Error(`No conId in contract details for ${symbol}`);

        return {
          symbol,
          conid: String(conid),
          contract: summary,
          displayName: this.pickDisplayName(symbol, details),
          instrumentContract: this.buildInstrumentContract(
            symbol,
            String(conid),
            summary,
            details,
            "ibkr",
          ),
        };
      } catch (error) {
        if (
          !instrument.secType ||
          !instrument.exchange ||
          !instrument.currency
        ) {
          throw error;
        }
        this.onLog(
          `contractDetails unavailable for ${symbol}; using WATCHLIST_CONTRACT_OVERRIDES fallback: ${(error as Error).message}`,
        );
        const fallbackContract = this.withDefaults(directContract);
        return {
          symbol,
          conid: String(directConid),
          contract: fallbackContract,
          instrumentContract: this.buildInstrumentContract(
            symbol,
            String(directConid),
            fallbackContract,
            undefined,
            "override_fallback",
          ),
        };
      }
    }

    const details = await this.requestContractDetails(symbol, directContract);
    const summary = pickContract(details);
    const conid = toNum(summary.conId) ?? toNum(summary.conid) ?? directConid;
    if (!conid) throw new Error(`No conId in contract details for ${symbol}`);

    return {
      symbol,
      conid: String(conid),
      contract: summary,
      displayName: this.pickDisplayName(symbol, details),
      instrumentContract: this.buildInstrumentContract(
        symbol,
        String(conid),
        summary,
        details,
        "ibkr",
      ),
    };
  }

  private buildInstrumentContract(
    symbol: string,
    conid: string,
    contract: ContractShape,
    details: ContractDetailsShape | undefined,
    source: InstrumentContract["source"],
  ): InstrumentContract {
    const displayName = details
      ? this.pickDisplayName(symbol, details)
      : undefined;
    return {
      symbol: symbol.toUpperCase(),
      conid,
      secType: toStr(contract.secType) ?? this.config.securityType,
      exchange: toStr(contract.exchange),
      primaryExchange:
        toStr(contract.primaryExch) ?? toStr(contract.primaryExchange),
      currency: toStr(contract.currency) ?? this.config.currency,
      localSymbol: toStr(contract.localSymbol),
      tradingClass: toStr(contract.tradingClass),
      minTick: toNum(details?.minTick),
      displayName,
      contractJson: contract,
      detailsJson: details as Record<string, unknown> | undefined,
      source,
    };
  }

  private async requestContractDetails(
    symbol: string,
    contractLike: ContractShape,
  ): Promise<ContractDetailsShape> {
    const reqId = this.allocReqId();
    const contract = this.withDefaults(contractLike);

    return new Promise<ContractDetailsShape>((resolve, reject) => {
      let firstDetails: ContractDetailsShape | undefined;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting contractDetails for ${symbol}`));
      }, 10_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("contractDetails", onContractDetails);
        this.ib.off("contractDetailsEnd", onContractDetailsEnd);
        this.ib.off("error", onError);
      };

      const onContractDetails = (
        incomingReqId: number,
        details: ContractDetailsShape,
      ) => {
        if (incomingReqId === reqId && !firstDetails) firstDetails = details;
      };

      const onContractDetailsEnd = (incomingReqId: number) => {
        if (incomingReqId !== reqId) return;
        cleanup();
        firstDetails
          ? resolve(firstDetails)
          : reject(new Error(`No contract details for ${symbol}`));
      };

      const onError = (err: Error, code?: number, incomingReqId?: number) => {
        if (incomingReqId !== reqId) return;
        cleanup();
        reject(
          new Error(
            `contractDetails error ${code ?? "unknown"} for ${symbol}: ${err.message}`,
          ),
        );
      };

      this.ib.on("contractDetails", onContractDetails);
      this.ib.on("contractDetailsEnd", onContractDetailsEnd);
      this.ib.on("error", onError);
      this.ib.reqContractDetails(reqId, contract);
    });
  }

  private async requestHistorical1mChunk(
    sub: InstrumentSubscription,
    end: Date,
    durationStr: string,
  ): Promise<Candle[]> {
    const reqId = this.allocReqId();
    const contract = this.withDefaults(
      sub.contract ?? { symbol: sub.symbol, conId: Number(sub.conid) },
    );

    return new Promise<Candle[]>((resolve, reject) => {
      const bars: Candle[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting historicalData for ${sub.symbol}`));
      }, 90_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("historicalData", onHistoricalData);
        this.ib.off("error", onError);
      };

      const finalize = () => {
        cleanup();
        resolve(bars.sort((a, b) => a.ts.getTime() - b.ts.getTime()));
      };

      const onHistoricalData = (
        incomingReqId: number,
        date: string,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number,
      ) => {
        if (incomingReqId !== reqId) return;
        if (
          typeof date === "string" &&
          date.toLowerCase().startsWith("finished")
        ) {
          finalize();
          return;
        }

        const ts = this.parseHistoricalDate(date);
        if (!ts) return;
        bars.push({
          conid: sub.conid,
          symbol: sub.symbol,
          timeframe: "1m",
          ts,
          open: Number(open),
          high: Number(high),
          low: Number(low),
          close: Number(close),
          volume: Number(volume),
        });
      };

      const onError = (err: Error, code?: number, incomingReqId?: number) => {
        if (incomingReqId !== reqId) return;
        cleanup();
        reject(
          new Error(
            `historicalData error ${code ?? "unknown"} for ${sub.symbol}: ${err?.message ?? "unknown"}`,
          ),
        );
      };

      this.ib.on("historicalData", onHistoricalData);
      this.ib.on("error", onError);
      this.ib.reqHistoricalData(
        reqId,
        contract,
        formatIbEndDateTime(end),
        durationStr,
        "1 min",
        "TRADES",
        0,
        2,
        false,
      );
    });
  }

  private buildContractFromInstrument(
    instrument: WatchlistInstrument,
    directConid?: number,
  ): ContractShape {
    return {
      symbol: instrument.symbol,
      ...(directConid ? { conId: directConid } : {}),
      ...(instrument.secType ? { secType: instrument.secType } : {}),
      ...(instrument.exchange ? { exchange: instrument.exchange } : {}),
      ...(instrument.primaryExchange
        ? { primaryExch: instrument.primaryExchange }
        : {}),
      ...(instrument.currency ? { currency: instrument.currency } : {}),
    };
  }

  private withDefaults(contract: ContractShape): ContractShape {
    return {
      secType: this.config.securityType,
      exchange: this.config.exchange,
      currency: this.config.currency,
      ...(this.config.primaryExchange
        ? { primaryExch: this.config.primaryExchange }
        : {}),
      ...contract,
    };
  }

  private pickDisplayName(
    symbol: string,
    details: ContractDetailsShape,
  ): string | undefined {
    const longName =
      typeof details.longName === "string" ? details.longName.trim() : "";
    if (longName && longName.toUpperCase() !== symbol.toUpperCase())
      return longName;
    const marketName =
      typeof details.marketName === "string" ? details.marketName.trim() : "";
    if (marketName && marketName.toUpperCase() !== symbol.toUpperCase())
      return marketName;
    return undefined;
  }

  private parseHistoricalDate(value: string): Date | undefined {
    const raw = String(value ?? "").trim();
    if (!raw) return undefined;
    if (/^\d+$/.test(raw)) {
      const num = Number(raw);
      const ms = num > 1_000_000_000_000 ? num : num * 1000;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? undefined : date;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  private allocReqId(): number {
    this.nextReqId += 1;
    return this.nextReqId;
  }

  private bindListeners(): void {
    this.ib.on("connected", () =>
      this.onLog("TWS socket connected event received"),
    );
    this.ib.on("disconnected", () => {
      this.connected = false;
      this.onLog("TWS socket disconnected");
    });
    this.ib.on("error", (err: Error, code?: number, reqId?: number) => {
      this.onLog(
        `TWS error code=${code ?? "n/a"} reqId=${reqId ?? "n/a"}: ${err?.message ?? err}`,
      );
    });
  }
}
