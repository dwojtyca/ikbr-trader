import IB from "ib";
import {
  buildExactIbkrEsHistoricalContract,
  formatIbUtcEndDateTime,
  IBKR_ES_BAR_REQUEST,
  Candle,
  CandleTimeframe,
  InstrumentContract,
} from "@ikbr/shared";
import {
  InstrumentSubscription,
  TickEvent,
  WatchlistInstrument,
} from "./types.js";

interface TwsClientConfig {
  host: string;
  port: number;
  clientId: number;
  securityType: string;
  exchange: string;
  primaryExchange?: string;
  currency: string;
  marketDataType: number;
}

interface TickerState {
  conid: string;
  symbol: string;
  price?: number;
  bid?: number;
  ask?: number;
  size?: number;
  close?: number;
}

type ContractShape = Record<string, unknown>;
type ContractDetailsShape = {
  contract?: ContractShape;
  summary?: ContractShape;
  longName?: string;
  marketName?: string;
  minTick?: number | string;
};

export interface HistoricalBackfillResult {
  symbol: string;
  conid: string;
  candles: Candle[];
}

export class NativeFinalBarRequestError extends Error {
  constructor(message: string, readonly terminal: boolean) { super(message); }
}

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

function ibErrorMeta(codeOrMeta: unknown, legacyReqId?: number): { code?: number; reqId?: number } {
  if (codeOrMeta && typeof codeOrMeta === "object") {
    const value = codeOrMeta as { code?: unknown; id?: unknown };
    return { code: toNum(value.code), reqId: toNum(value.id) };
  }
  return { code: toNum(codeOrMeta), reqId: legacyReqId };
}

function pickContract(details: ContractDetailsShape): ContractShape {
  return details.contract ?? details.summary ?? {};
}

function parseRtVolumeTick(
  raw: string,
): { price?: number; size?: number } | undefined {
  if (typeof raw !== "string") return undefined;
  const parts = raw.split(";");
  if (parts.length < 2) return undefined;

  const price = Number(parts[0]);
  const size = Number(parts[1]);

  return {
    price: Number.isFinite(price) ? price : undefined,
    size: Number.isFinite(size) ? size : undefined,
  };
}

/**
 * PR15.2 hostile-review round-3 — minimal port over the subset
 * of `IB` we consume for the strict `contractDetails` path.
 * Kept structural (not `import IB`) so unit tests can inject an
 * in-memory `EventEmitter` without pulling in the real network
 * client.
 */
export interface IbEventPort {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
  reqContractDetails(reqId: number, contract: Record<string, unknown>): unknown;
}

export interface AwaitExactlyOneContractDetailsInput {
  readonly ib: IbEventPort;
  readonly reqId: number;
  readonly contract: Record<string, unknown>;
  readonly label: string;
  readonly timeoutMs: number;
}

export interface TwsClientDependencies {
  /** Test seam for the installed ib client without opening a broker socket. */
  readonly ib?: any;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * PR15.2 hostile-review round-3 — pure event-wiring helper that
 * awaits a single `contractDetails` response for `reqId`.
 *
 * Semantics (fail-closed):
 *   - Zero responses before `contractDetailsEnd` → reject.
 *   - Exactly one response before `contractDetailsEnd` → resolve.
 *   - More than one response before `contractDetailsEnd` →
 *     reject (do NOT pick the first).
 *   - Any error event carrying the same `reqId` → reject.
 *   - Events for a DIFFERENT `reqId` → ignored (concurrent
 *     resolutions can share one IB connection).
 *   - Every listener is removed on both fulfilment and
 *     rejection so no listener leaks.
 *   - Timeout after `timeoutMs` ms rejects and cleans up.
 *
 * The IB client is invoked exactly once via `reqContractDetails`.
 */
export function awaitExactlyOneContractDetails(
  input: AwaitExactlyOneContractDetailsInput,
): Promise<Record<string, unknown>> {
  const { ib, reqId, contract, label, timeoutMs } = input;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const collected: Record<string, unknown>[] = [];

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting contractDetails for bound instrument ${label}`,
        ),
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ib.off("contractDetails", onContractDetails as (...args: unknown[]) => void);
      ib.off(
        "contractDetailsEnd",
        onContractDetailsEnd as (...args: unknown[]) => void,
      );
      ib.off("error", onError as (...args: unknown[]) => void);
    };

    const onContractDetails = (
      incomingReqId: number,
      details: Record<string, unknown>,
    ) => {
      if (incomingReqId !== reqId) return;
      collected.push(details);
    };

    const onContractDetailsEnd = (incomingReqId: number) => {
      if (incomingReqId !== reqId) return;
      cleanup();
      if (collected.length === 0) {
        reject(
          new Error(
            `No contract details for bound instrument ${label} (expected exactly one)`,
          ),
        );
        return;
      }
      if (collected.length > 1) {
        reject(
          new Error(
            `Ambiguous contract details for bound instrument ${label}: ` +
              `IBKR returned ${collected.length} matches, expected exactly one`,
          ),
        );
        return;
      }
      resolve(collected[0]);
    };

    const onError = (err: Error, code?: number, incomingReqId?: number) => {
      if (incomingReqId !== reqId) return;
      cleanup();
      reject(
        new Error(
          `contractDetails error ${code ?? "unknown"} for bound instrument ${label}: ${err.message}`,
        ),
      );
    };

    ib.on("contractDetails", onContractDetails as (...args: unknown[]) => void);
    ib.on(
      "contractDetailsEnd",
      onContractDetailsEnd as (...args: unknown[]) => void,
    );
    ib.on("error", onError as (...args: unknown[]) => void);
    // PR15.2 hostile-review round-4 — a synchronous throw from
    // `reqContractDetails` (e.g. socket-not-connected, marshaling
    // failure, or a fake IB in tests) would otherwise leave the
    // three listeners AND the timeout registered until the timeout
    // fires. Fail-closed: clean up immediately, reject once, and
    // never retry / fall back to symbol-based resolution.
    try {
      ib.reqContractDetails(reqId, contract);
    } catch (err) {
      cleanup();
      const msg = err instanceof Error ? err.message : String(err);
      reject(
        new Error(
          `reqContractDetails threw synchronously for bound instrument ${label}: ${msg}`,
        ),
      );
    }
  });
}

export class TwsClient {
  private readonly ib: any;
  private connected = false;
  private nextReqId = 10_000;
  private readonly tickerStates = new Map<number, TickerState>();
  private readonly subscriptionsByConid = new Map<string, number>();
  private readonly finalBarRequestTimes: number[] = [];

  constructor(
    private readonly config: TwsClientConfig,
    private readonly onTick: (tick: TickEvent) => Promise<void> | void,
    private readonly onLog: (line: string) => void,
    private readonly dependencies: TwsClientDependencies = {},
  ) {
    this.ib =
      dependencies.ib ??
      new IB({
        host: config.host,
        port: config.port,
        clientId: config.clientId,
      });

    this.bindCoreListeners();
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

    this.onLog(
      `TWS socket connected ${this.config.host}:${this.config.port}, clientId=${this.config.clientId}`,
    );
    try {
      this.ib.reqMarketDataType(this.config.marketDataType);
      this.onLog(`TWS market data type set to ${this.config.marketDataType}`);
    } catch (error) {
      this.onLog(`failed to set market data type: ${(error as Error).message}`);
    }
  }

  disconnect(): void {
    if (!this.connected) return;
    this.ib.disconnect();
    this.connected = false;
  }

  async confirmFinalEsMinute(
    sub: InstrumentSubscription,
    minute: Date,
  ): Promise<Candle | null> {
    if (minute.getTime() % 60_000 !== 0) throw new Error("FUT confirmation minute is off-grid");
    const raw = sub.contract ?? {};
    const minTick = sub.instrumentContract?.minTick;
    const contract = buildExactIbkrEsHistoricalContract({
      conId: Number(sub.conid),
      localSymbol: toStr(raw.localSymbol) ?? sub.instrumentContract?.localSymbol ?? "",
      lastTradeDateOrContractMonth: toStr(raw.expiry) ?? toStr(raw.lastTradeDateOrContractMonth) ?? "",
      minTick: typeof minTick === "number" ? minTick : 0,
      symbol: toStr(raw.symbol) ?? sub.symbol,
      secType: toStr(raw.secType) ?? sub.instrumentContract?.secType ?? "",
      tradingClass: toStr(raw.tradingClass) ?? sub.instrumentContract?.tradingClass ?? "",
      exchange: toStr(raw.exchange) ?? sub.instrumentContract?.exchange ?? "",
      currency: toStr(raw.currency) ?? sub.instrumentContract?.currency ?? "",
      multiplier: toStr(raw.multiplier) ?? "",
    });
    await this.acquireFinalBarPacingToken();
    const reqId = this.allocReqId();
    return new Promise<Candle | null>((resolve, reject) => {
      const matches: Candle[] = [];
      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("historicalData", onHistoricalData);
        this.ib.off("error", onError);
      };
      const finish = () => {
        cleanup();
        if (matches.length > 1) reject(new Error("Ambiguous native FUT final bar"));
        else resolve(matches[0] ?? null);
      };
      const onHistoricalData = (
        incomingReqId: number, date: string, open: number, high: number,
        low: number, close: number, volume: number,
      ) => {
        if (incomingReqId !== reqId) return;
        if (String(date).toLowerCase().startsWith("finished")) return finish();
        const ts = this.parseHistoricalDate(date);
        if (!ts || ts.getTime() !== minute.getTime()) return;
        matches.push({ conid: sub.conid, symbol: sub.symbol, timeframe: "1m", ts,
          open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) });
      };
      const onError = (_error: Error, codeOrMeta?: unknown, legacyReqId?: number) => {
        const meta = ibErrorMeta(codeOrMeta, legacyReqId);
        if (meta.reqId !== reqId) return;
        cleanup();
        reject(new NativeFinalBarRequestError(
          `Native FUT final-bar request failed (IBKR ${meta.code ?? "unknown"})`,
          meta.code === 162 || meta.code === 166,
        ));
      };
      const timeout = setTimeout(() => { cleanup(); reject(new Error("Native FUT final-bar request timed out")); }, 30_000);
      this.ib.on("historicalData", onHistoricalData);
      this.ib.on("error", onError);
      try {
        this.ib.reqHistoricalData(reqId, contract,
          formatIbUtcEndDateTime(new Date(minute.getTime() + 60_000)), "120 S",
          IBKR_ES_BAR_REQUEST.barSize, IBKR_ES_BAR_REQUEST.whatToShow,
          IBKR_ES_BAR_REQUEST.useRTH, IBKR_ES_BAR_REQUEST.formatDate,
          IBKR_ES_BAR_REQUEST.keepUpToDate);
      } catch {
        cleanup(); reject(new Error("Native FUT final-bar request could not be sent"));
      }
    });
  }

  private async acquireFinalBarPacingToken(): Promise<void> {
    const windowMs = 10 * 60_000;
    while (true) {
      const now = this.dependencies.now?.() ?? Date.now();
      while (this.finalBarRequestTimes.length && now - this.finalBarRequestTimes[0] >= windowMs)
        this.finalBarRequestTimes.shift();
      if (this.finalBarRequestTimes.length < 50) {
        this.finalBarRequestTimes.push(now);
        return;
      }
      const wait = windowMs - (now - this.finalBarRequestTimes[0]) + 50;
      await (this.dependencies.sleep?.(Math.min(wait, 30_000)) ??
        new Promise((resolve) =>
          setTimeout(resolve, Math.min(wait, 30_000)),
        ));
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getManagedAccounts(): Promise<string[]> {
    const accounts = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for managedAccounts from TWS"));
      }, 8_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("managedAccounts", onManagedAccounts);
      };

      const onManagedAccounts = (accountsList: string) => {
        cleanup();
        resolve(accountsList);
      };

      this.ib.once("managedAccounts", onManagedAccounts);
      this.ib.reqManagedAccts();
    });

    return accounts
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  async resolveContracts(
    instruments: WatchlistInstrument[],
  ): Promise<InstrumentSubscription[]> {
    const out: InstrumentSubscription[] = [];

    for (const instrument of instruments) {
      try {
        const contract = await this.resolveContract(instrument);
        out.push(contract);
      } catch (error) {
        this.onLog(
          `resolve contract failed for ${instrument.symbol}: ${(error as Error).message}`,
        );
      }
    }

    return out;
  }

  addSubscriptions(subscriptions: InstrumentSubscription[]): void {
    for (const sub of subscriptions) {
      if (this.subscriptionsByConid.has(sub.conid)) {
        continue;
      }

      const tickerId = this.allocReqId();
      this.subscriptionsByConid.set(sub.conid, tickerId);
      this.tickerStates.set(tickerId, {
        conid: sub.conid,
        symbol: sub.symbol,
      });

      const contract = this.withDefaults(
        sub.contract ?? { symbol: sub.symbol, conId: Number(sub.conid) },
      );

      this.ib.reqMktData(tickerId, contract, "", false, false);

      this.onLog(
        `subscribed market data ${sub.symbol} (${sub.conid}) tickerId=${tickerId}`,
      );
    }
  }

  clearSubscriptions(): void {
    for (const [conid, tickerId] of this.subscriptionsByConid.entries()) {
      try {
        this.ib.cancelMktData(tickerId);
        this.onLog(`cancelled market data ${conid} tickerId=${tickerId}`);
      } catch (error) {
        this.onLog(
          `failed to cancel market data ${conid} tickerId=${tickerId}: ${(error as Error).message}`,
        );
      }
    }

    this.subscriptionsByConid.clear();
    this.tickerStates.clear();
  }

  async backfillRecentCandles1m(
    subscriptions: InstrumentSubscription[],
    candlesPerSymbol: number,
  ): Promise<HistoricalBackfillResult[]> {
    return this.backfillRecentCandles(subscriptions, "1m", candlesPerSymbol);
  }

  /**
   * Fetch up to `candlesPerSymbol` native bars of the given timeframe from
   * IBKR via reqHistoricalData. Unlike backfillRecentCandles1m → aggregator,
   * the returned candles ARE the native TWS bars (open/high/low/close/volume
   * aligned to IBKR's session-aware buckets). Used to seed candles_5m /
   * candles_1h / candles_4h / candles_1d / candles_1w tables at startup so
   * indicators that depend on EMA50/EMA200 / regimeScore work from the
   * first tick rather than after weeks of accumulating bars from live 1m.
   *
   * Calls are sequential per symbol to respect IB pacing limits.
   */
  async backfillRecentCandles(
    subscriptions: InstrumentSubscription[],
    timeframe: CandleTimeframe,
    candlesPerSymbol: number,
    onSymbolProgress?: (info: {
      symbol: string;
      index: number;
      total: number;
    }) => void,
  ): Promise<HistoricalBackfillResult[]> {
    if (candlesPerSymbol <= 0) return [];

    const out: HistoricalBackfillResult[] = [];
    const total = subscriptions.length;
    let index = 0;
    for (const sub of subscriptions) {
      index += 1;
      onSymbolProgress?.({ symbol: sub.symbol, index, total });
      try {
        const candles = await this.requestHistorical(
          sub,
          timeframe,
          candlesPerSymbol,
          { progressPrefix: `[${index}/${total}]` },
        );
        out.push({
          symbol: sub.symbol,
          conid: sub.conid,
          candles,
        });
      } catch (error) {
        this.onLog(
          `historical backfill [${index}/${total}] (${timeframe}) failed for ${sub.symbol} (${sub.conid}): ${(error as Error).message}`,
        );
        out.push({
          symbol: sub.symbol,
          conid: sub.conid,
          candles: [],
        });
      }
    }

    return out;
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
    // PR15.2 hostile-review fix — bound instruments (identified
    // by `instrumentId`) MUST resolve through
    // `requestContractDetailsExactlyOne`. Zero or >1 result is
    // a fail-closed error; `firstDetails` fallback is forbidden
    // because it could publish market state under a substituted
    // identity. Legacy watchlist entries keep the existing
    // permissive behavior.
    if (instrument.instrumentId && directConid) {
      const details = await this.requestContractDetailsExactlyOne(
        `${symbol} (${instrument.instrumentId})`,
        directContract,
      );
      const summary = pickContract(details);
      const conid =
        toNum(summary.conId) ?? toNum(summary.conid) ?? directConid;
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
    if (directConid) {
      try {
        const details = await this.requestContractDetails(
          symbol,
          directContract,
        );
        const summary = pickContract(details);
        const conid =
          toNum(summary.conId) ?? toNum(summary.conid) ?? directConid;

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

    const details = await this.requestContractDetails(
      symbol,
      this.buildContractFromInstrument(instrument),
    );
    const summary = pickContract(details);
    const conId = toNum(summary.conId) ?? toNum(summary.conid);
    if (!conId) {
      throw new Error(`No conId in contract details for ${symbol}`);
    }

    return {
      symbol,
      conid: String(conId),
      contract: summary,
      displayName: this.pickDisplayName(symbol, details),
      instrumentContract: this.buildInstrumentContract(
        symbol,
        String(conId),
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
      }, 8_000);

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
        if (incomingReqId !== reqId) return;
        if (!firstDetails) firstDetails = details;
      };

      const onContractDetailsEnd = (incomingReqId: number) => {
        if (incomingReqId !== reqId) return;
        cleanup();

        if (!firstDetails) {
          reject(new Error(`No contract details for ${symbol}`));
          return;
        }

        resolve(firstDetails);
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

  /**
   * PR15.2 hostile-review fix — strict resolution for bound
   * instruments. Delegates to the pure, unit-testable
   * `awaitExactlyOneContractDetails` helper so the event-wiring
   * logic can be exercised without a real IBKR socket.
   */
  private async requestContractDetailsExactlyOne(
    label: string,
    contractLike: ContractShape,
  ): Promise<ContractDetailsShape> {
    const reqId = this.allocReqId();
    const contract = this.withDefaults(contractLike);
    return awaitExactlyOneContractDetails({
      ib: this.ib as IbEventPort,
      reqId,
      contract,
      label,
      timeoutMs: 8_000,
    });
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
      // PR15.2 — pass the bound disambiguators so IBKR narrows
      // to the exact contract. `reqContractDetails` accepts them
      // as filters on the returned set; combined with a positive
      // `conId` the response should contain exactly one entry.
      ...(instrument.localSymbol ? { localSymbol: instrument.localSymbol } : {}),
      ...(instrument.tradingClass
        ? { tradingClass: instrument.tradingClass }
        : {}),
    };
  }

  private async requestHistorical1m(
    sub: InstrumentSubscription,
    candlesPerSymbol: number,
  ): Promise<Candle[]> {
    return this.requestHistorical(sub, "1m", candlesPerSymbol);
  }

  /**
   * IB barSize literals + a "safe" duration window per timeframe. The
   * window must be wide enough to return `candlesPerSymbol` bars but stay
   * inside IBKR's per-barSize duration limits (e.g. intraday < 1 Y).
   */
  private historicalParamsFor(
    timeframe: CandleTimeframe,
    candlesPerSymbol: number,
  ): { barSize: string; durationStr: string } {
    switch (timeframe) {
      case "1m": {
        const days = Math.max(
          1,
          Math.min(30, Math.ceil(candlesPerSymbol / 390) + 1),
        );
        return { barSize: "1 min", durationStr: `${days} D` };
      }
      case "5m": {
        const days = Math.max(
          2,
          Math.min(60, Math.ceil((candlesPerSymbol * 5) / 390) + 3),
        );
        return { barSize: "5 mins", durationStr: `${days} D` };
      }
      case "1h": {
        const days = Math.max(
          5,
          Math.min(365, Math.ceil(candlesPerSymbol / 6) + 10),
        );
        return { barSize: "1 hour", durationStr: `${days} D` };
      }
      case "4h": {
        const days = Math.max(
          10,
          Math.min(365, Math.ceil((candlesPerSymbol * 4) / 6) + 20),
        );
        return { barSize: "4 hours", durationStr: `${days} D` };
      }
      case "12h": {
        const days = Math.max(20, Math.min(365, candlesPerSymbol + 30));
        return { barSize: "8 hours", durationStr: `${days} D` };
      }
      case "1d": {
        const years = Math.max(
          1,
          Math.min(10, Math.ceil(candlesPerSymbol / 250) + 1),
        );
        return { barSize: "1 day", durationStr: `${years} Y` };
      }
      case "1w": {
        const years = Math.max(
          2,
          Math.min(20, Math.ceil(candlesPerSymbol / 52) + 1),
        );
        return { barSize: "1 W", durationStr: `${years} Y` };
      }
      default:
        return { barSize: "1 min", durationStr: "1 D" };
    }
  }

  private async requestHistorical(
    sub: InstrumentSubscription,
    timeframe: CandleTimeframe,
    candlesPerSymbol: number,
    options: { progressPrefix?: string } = {},
  ): Promise<Candle[]> {
    await this.acquireFinalBarPacingToken();
    const reqId = this.allocReqId();
    const { barSize, durationStr } = this.historicalParamsFor(
      timeframe,
      candlesPerSymbol,
    );
    const contract = this.withDefaults(
      sub.contract ?? { symbol: sub.symbol, conId: Number(sub.conid) },
    );

    return new Promise<Candle[]>((resolve, reject) => {
      const bars: Candle[] = [];

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting historicalData (${timeframe}) for ${sub.symbol}`,
          ),
        );
      }, 30_000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib.off("historicalData", onHistoricalData);
        this.ib.off("error", onError);
      };

      const finalize = () => {
        cleanup();
        const uniqueByTs = new Map<number, Candle>();
        for (const candle of bars) {
          uniqueByTs.set(candle.ts.getTime(), candle);
        }
        const ordered = Array.from(uniqueByTs.values()).sort(
          (a, b) => a.ts.getTime() - b.ts.getTime(),
        );
        const sliced = ordered.slice(
          Math.max(0, ordered.length - candlesPerSymbol),
        );
        this.onLog(
          `historical backfill ${options.progressPrefix ? options.progressPrefix + " " : ""}${sub.symbol} (${sub.conid}) [${timeframe}] fetched ${sliced.length}/${candlesPerSymbol} candles`,
        );
        resolve(sliced);
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
          timeframe,
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
        const message = err?.message ?? "unknown historical data error";
        cleanup();
        reject(
          new Error(
            `historicalData error ${code ?? "unknown"} for ${sub.symbol}: ${message}`,
          ),
        );
      };

      this.ib.on("historicalData", onHistoricalData);
      this.ib.on("error", onError);
      this.ib.reqHistoricalData(
        reqId,
        contract,
        "",
        durationStr,
        barSize,
        "TRADES",
        0,
        2,
        false,
      );
    });
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

  private bindCoreListeners(): void {
    this.ib.on("connected", () => {
      this.onLog("TWS socket connected event received");
    });

    this.ib.on("disconnected", () => {
      this.onLog("TWS socket disconnected");
      this.connected = false;
    });

    this.ib.on("error", (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
      const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
      const prefix =
        parsed.reqId !== undefined ? `reqId=${parsed.reqId}` : "reqId=n/a";
      this.onLog(
        `TWS error code=${parsed.code ?? "n/a"} ${prefix}: ${parsed.message}`,
      );
    });

    this.ib.on(
      "tickPrice",
      (tickerId: number, field: number, price: number) => {
        const state = this.tickerStates.get(tickerId);
        if (!state || !Number.isFinite(price)) return;

        // Live: 1/2/4, Delayed: 66/67/68, Close fallback: 9/75
        if (field === 1 || field === 66) state.bid = price;
        else if (field === 2 || field === 67) state.ask = price;
        else if (field === 4 || field === 68) state.price = price;
        else if (field === 9 || field === 75) state.close = price;

        this.emitTick(state);
      },
    );

    this.ib.on("tickSize", (tickerId: number, field: number, size: number) => {
      const state = this.tickerStates.get(tickerId);
      if (!state || !Number.isFinite(size)) return;

      // Live last size: 5, Delayed last size: 71.
      if (
        field === 0 ||
        field === 3 ||
        field === 5 ||
        field === 69 ||
        field === 70 ||
        field === 71
      ) {
        state.size = size;
      }

      if ((field === 5 || field === 71) && state.price !== undefined) {
        this.emitTick(state);
      }
    });

    this.ib.on(
      "tickString",
      (tickerId: number, field: number, value: string) => {
        const state = this.tickerStates.get(tickerId);
        if (!state) return;

        // Live RT Volume: 48, Delayed RT Volume: 77.
        if (field !== 48 && field !== 77) return;

        const parsed = parseRtVolumeTick(value);
        if (!parsed) return;
        if (parsed.price !== undefined) state.price = parsed.price;
        if (parsed.size !== undefined) state.size = parsed.size;
        if (state.price !== undefined) {
          this.emitTick(state);
        }
      },
    );
  }

  private emitTick(state: TickerState): void {
    const fallbackPrice = state.bid ?? state.ask ?? state.close;
    const price = state.price ?? fallbackPrice;
    if (price === undefined) return;

    void this.onTick({
      conid: state.conid,
      symbol: state.symbol,
      price,
      bid: state.bid,
      ask: state.ask,
      size: state.size,
      ts: new Date(),
    });
  }

  private allocReqId(): number {
    const id = this.nextReqId;
    this.nextReqId += 1;
    return id;
  }

  private parseIbErrorArgs(
    arg1: unknown,
    arg2?: unknown,
    arg3?: unknown,
  ): { code?: number | string; reqId?: number | string; message: string } {
    let code: number | string | undefined;
    let reqId: number | string | undefined;
    let message = "unknown IB error";

    if (typeof arg1 === "string") {
      message = arg1;
    } else if (arg1 instanceof Error) {
      message = arg1.message;
    } else if (arg1 && typeof arg1 === "object") {
      const obj = arg1 as Record<string, unknown>;
      if (obj.message !== undefined) message = String(obj.message);
      if (obj.code !== undefined) code = String(obj.code);
      if (obj.reqId !== undefined) reqId = String(obj.reqId);
      if (obj.id !== undefined && reqId === undefined) reqId = String(obj.id);
    }

    if (typeof arg2 === "number" || typeof arg2 === "string") {
      code = arg2;
    } else if (arg2 && typeof arg2 === "object") {
      const obj = arg2 as Record<string, unknown>;
      if (obj.code !== undefined) code = String(obj.code);
      if (obj.errorCode !== undefined && code === undefined)
        code = String(obj.errorCode);
      if (obj.reqId !== undefined && reqId === undefined)
        reqId = String(obj.reqId);
      if (obj.id !== undefined && reqId === undefined) reqId = String(obj.id);
    }

    if (typeof arg3 === "number" || typeof arg3 === "string") {
      reqId = arg3;
    }

    return { code, reqId, message };
  }

  private parseHistoricalDate(value: string): Date | undefined {
    if (typeof value !== "string") return undefined;
    const raw = value.trim();
    if (!raw) return undefined;

    if (/^\d+$/.test(raw)) {
      const num = Number(raw);
      if (!Number.isFinite(num)) return undefined;
      const ms = num > 1_000_000_000_000 ? num : num * 1000;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? undefined : date;
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
}
