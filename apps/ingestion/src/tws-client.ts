import { sessionNativeSource, sessionLocalMidnight, type InstrumentSessionIdentity, type SessionTimeframe } from "@ikbr/shared";
import { AAPL_NATIVE_SOURCE, AAPL_REQUIRED_CANDLES, newYorkMidnight, type AaplTimeframe } from "@ikbr/shared";
import { isAaplSubscription } from "./aapl-native-refresh.js";
import { WSE_NATIVE_SOURCE, validClosedWseCandle, warsawMidnight } from "@ikbr/shared";
import { isWseSubscription } from "./wse-native-refresh.js";
import IB from "ib";
import type { DiagnosticPrivacy } from "@ikbr/shared/diagnostics";
import { contractDiagnosticMessage, contractDiagnosticText, contractDiagnosticTimestamp, contractQueryDiagnostic,
  contractSourceError, emitContractDiagnostic, type ContractBootstrapFailures, type ContractDiagnosticEvent,
  type ContractResolutionDiagnostic, type ContractResolutionOutcome, type ContractTransportDiagnostic } from "./contract-resolution-diagnostics.js";
import { captureResearchSourceError } from "@ikbr/shared/instrument-research";
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
  bidObservedAt?: string;
  askObservedAt?: string;
  marketDataType?: number;
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
  readonly signal?: AbortSignal;
  readonly current?: () => boolean;
  readonly monotonicNow?: () => number;
  readonly now?: () => number;
  readonly privacy?: DiagnosticPrivacy;
  readonly instrumentId?: string;
  readonly bootstrapAttempt?: number;
  readonly transportGeneration?: number;
  readonly transportDiagnostic?: () => ContractTransportDiagnostic;
  readonly currentTransportGeneration?: () => number;
  readonly onDiagnostic?: (diagnostic: ContractResolutionDiagnostic) => void;
}

export interface TwsClientDependencies {
  /** Test seam for the installed ib client without opening a broker socket. */
  readonly ib?: any;
  readonly ibFactory?: () => any;
  readonly continuous?: () => boolean;
  readonly monotonicNow?: () => number;
  readonly now?: () => number;
  readonly onConnectionInvalidated?: () => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly privacy?: DiagnosticPrivacy;
  readonly onDiagnostic?: (event: ContractDiagnosticEvent) => void;
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
  return awaitContractDetails(input, true);
}

function awaitContractDetails(input: AwaitExactlyOneContractDetailsInput, exactlyOne: boolean): Promise<Record<string, unknown>> {
  const { ib, reqId, contract, timeoutMs } = input;
  const label = contractDiagnosticText(input.label, input.privacy);
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let first: Record<string, unknown> | undefined;
    let settled = false;
    const started = input.monotonicNow?.() ?? performance.now();
    const elapsed = () => {
      const value = (input.monotonicNow?.() ?? performance.now()) - started;
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
    const withinDeadline = () => { const value = elapsed(); return value !== null && value < timeoutMs; };
    const readDiagnostic = <T>(read: (() => T) | undefined): T | null => {
      try { return read ? structuredClone(read()) : null; } catch { return null; }
    };
    const diagnostic: ContractResolutionDiagnostic = {
      schemaVersion: 1, attemptId: `${input.transportGeneration ?? 'unknown'}:${reqId}`,
      bootstrapAttempt: input.bootstrapAttempt ?? null, requestId: reqId,
      transportGeneration: input.transportGeneration ?? null,
      instrumentId: input.instrumentId ? contractDiagnosticText(input.instrumentId, input.privacy) : null,
      label, query: contractQueryDiagnostic(contract, input.privacy),
      startedAt: contractDiagnosticTimestamp(input.now?.() ?? Date.now()), completedAt: null, elapsedMs: null,
      timeoutMs, detailCount: 0, endCount: 0, sdkInvocationAttempted: false, sdkInvocationReturned: false,
      wireTransmission: 'UNAVAILABLE', outcome: null, sourceError: null, brokerCause: 'UNKNOWN',
      transport: readDiagnostic(input.transportDiagnostic),
      currentTransportGeneration: readDiagnostic(input.currentTransportGeneration),
    };
    const publish = () => {
      try { input.onDiagnostic?.(structuredClone(diagnostic)); } catch { /* An observer cannot change read outcomes. */ }
    };
    const cleanup = () => {
      input.signal?.removeEventListener('abort', aborted);
      clearTimeout(timeout);
      ib.off('contractDetails', onDetails as (...args: unknown[]) => void);
      ib.off('contractDetailsEnd', onEnd as (...args: unknown[]) => void);
      ib.off('error', onError as (...args: unknown[]) => void);
    };
    const finish = (outcome: ContractResolutionOutcome, error?: Error, original?: unknown, originalCode?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      diagnostic.outcome = outcome;
      diagnostic.completedAt = contractDiagnosticTimestamp(input.now?.() ?? Date.now());
      diagnostic.elapsedMs = elapsed();
      diagnostic.transport = readDiagnostic(input.transportDiagnostic);
      diagnostic.currentTransportGeneration = readDiagnostic(input.currentTransportGeneration);
      if (original !== undefined) diagnostic.sourceError = contractSourceError(original, input.privacy, originalCode);
      if (outcome === 'BROKER_ERROR') diagnostic.brokerCause = 'REQUEST_ERROR_OBSERVED';
      publish();
      if (error) {
        if (diagnostic.sourceError) Object.assign(error, { sourceError: diagnostic.sourceError });
        reject(error);
      } else resolve(first!);
    };
    const timeout = setTimeout(() => finish('TIMEOUT', new Error(
      `Timed out waiting contractDetails for ${exactlyOne ? 'bound instrument ' : ''}${label}`)), timeoutMs);
    const aborted = () => finish('INTERRUPTED', new Error('INGESTION_READ_INTERRUPTED'));
    const onDetails = (id: number, details: Record<string, unknown>) => {
      if (input.current && !input.current()) return;
      if (!withinDeadline()) { finish('TIMEOUT', new Error('TWS_READ_TIMEOUT')); return; }
      if (id !== reqId || settled) return;
      diagnostic.detailCount++;
      first ??= details;
      publish();
    };
    const onEnd = (id: number) => {
      if (input.current && !input.current()) return;
      if (!withinDeadline()) { finish('TIMEOUT', new Error('TWS_READ_TIMEOUT')); return; }
      if (id !== reqId || settled) return;
      diagnostic.endCount++;
      if (diagnostic.detailCount === 0) return finish('NO_DETAILS', new Error(exactlyOne
        ? `No contract details for bound instrument ${label} (expected exactly one)` : `No contract details for ${label}`));
      if (exactlyOne && diagnostic.detailCount > 1) return finish('AMBIGUOUS_DETAILS', new Error(
        `Ambiguous contract details for bound instrument ${label}: IBKR returned ${diagnostic.detailCount} matches, expected exactly one`));
      finish('SUCCESS');
    };
    const onError = (error: Error, codeOrMeta?: unknown, legacyReqId?: number) => {
      if (input.current && !input.current()) return;
      if (!withinDeadline()) { finish('TIMEOUT', new Error('TWS_READ_TIMEOUT')); return; }
      const meta = ibErrorMeta(codeOrMeta, legacyReqId);
      if (!Number.isSafeInteger(meta.reqId) || meta.reqId !== reqId || settled) return;
      const rawCode = codeOrMeta && typeof codeOrMeta === 'object' ? (codeOrMeta as { code?: unknown }).code : codeOrMeta;
      const source = contractSourceError(error, input.privacy, rawCode);
      finish('BROKER_ERROR', new Error(`contractDetails error ${source.code ?? 'unknown'} for ${exactlyOne ? 'bound instrument ' : ''}${label}: ${source.message}`), error, rawCode);
    };
    publish();
    input.signal?.addEventListener('abort', aborted, { once: true });
    if (input.signal?.aborted) { aborted(); return; }
    ib.on('contractDetails', onDetails as (...args: unknown[]) => void);
    ib.on('contractDetailsEnd', onEnd as (...args: unknown[]) => void);
    ib.on('error', onError as (...args: unknown[]) => void);
    try {
      diagnostic.sdkInvocationAttempted = true;
      ib.reqContractDetails(reqId, contract);
      if (!settled) { diagnostic.sdkInvocationReturned = true; publish(); }
    } catch (error) {
      const source = contractSourceError(error, input.privacy);
      finish('SEND_THROW', new Error(`reqContractDetails threw synchronously for ${exactlyOne ? 'bound instrument ' : ''}${label}: ${source.message}`), error);
    }
  });
}

export class TwsClient {
  private ib: any;
  private transportAbort = new AbortController();
  private retired = false;
  private retirementError: Error | undefined;
  private connecting: Promise<void> | undefined;
  private probing: Promise<void> | undefined;
  private transportGeneration = 0;
  private connected = false;
  private transportDiagnostic: ContractTransportDiagnostic = this.newTransportDiagnostic();
  private contractHistory: ContractResolutionDiagnostic[] = [];
  private activeContract: ContractResolutionDiagnostic | null = null;
  private omittedContractRequests = 0;
  private bootstrapContractFailures: ContractBootstrapFailures = { attempt: 0, failures: [], omittedFailures: 0, truncated: false };
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
    this.ib = dependencies.ib ?? this.createIb();

    this.bindCoreListeners();
  }

  private diagnosticTimestamp(): string | null { return contractDiagnosticTimestamp(this.dependencies.now?.() ?? Date.now()); }

  private newTransportDiagnostic(): ContractTransportDiagnostic {
    return { generation: this.transportGeneration, connected: false, retired: false, aborted: false,
      socketConnectedAt: null, serverAt: null, serverVersion: null, nextValidIdAt: null,
      disconnectedAt: null, retiredAt: null, globalContext: [], omittedGlobalMessages: 0 };
  }

  beginBootstrapDiagnostics(): void {
    this.bootstrapContractFailures = { attempt: this.bootstrapContractFailures.attempt + 1, failures: [], omittedFailures: 0, truncated: false };
  }

  contractFailures(): ContractBootstrapFailures { return structuredClone(this.bootstrapContractFailures); }

  contractResolutionDiagnostics() {
    return { transport: structuredClone(this.transportDiagnostic), active: structuredClone(this.activeContract),
      history: structuredClone(this.contractHistory), omittedRequests: this.omittedContractRequests,
      truncated: this.omittedContractRequests > 0, bootstrapFailures: this.contractFailures() };
  }

  private recordContractDiagnostic(diagnostic: ContractResolutionDiagnostic): void {
    const updating = diagnostic.outcome === null && this.activeContract?.attemptId === diagnostic.attemptId;
    if (diagnostic.outcome === null) this.activeContract = structuredClone(diagnostic);
    else {
      this.activeContract = null;
      this.contractHistory.push(structuredClone(diagnostic));
      if (this.contractHistory.length > 20) { this.contractHistory.shift(); this.omittedContractRequests++; }
      if (diagnostic.outcome !== 'SUCCESS' && diagnostic.bootstrapAttempt === this.bootstrapContractFailures.attempt) {
        if (this.bootstrapContractFailures.failures.length < 20) this.bootstrapContractFailures.failures.push(structuredClone(diagnostic));
        else { this.bootstrapContractFailures.omittedFailures++; this.bootstrapContractFailures.truncated = true; }
      }
    }
    if (updating) return;
    emitContractDiagnostic(this.dependencies.onDiagnostic, { event: diagnostic.outcome === null ? 'contract_resolution_started' : 'contract_resolution_finished',
      message: contractDiagnosticMessage(diagnostic), diagnostic });
  }

  private contractDiagnosticInput(instrumentId?: string) {
    const transport = this.transportDiagnostic;
    return { now: this.dependencies.now, privacy: this.dependencies.privacy, instrumentId,
      bootstrapAttempt: this.bootstrapContractFailures.attempt, transportGeneration: transport.generation,
      transportDiagnostic: () => structuredClone(transport), currentTransportGeneration: () => this.transportGeneration,
      onDiagnostic: (diagnostic: ContractResolutionDiagnostic) => this.recordContractDiagnostic(diagnostic) };
  }

  private createIb(): any {
    return this.dependencies.ibFactory?.() ?? new IB({
      host: this.config.host, port: this.config.port, clientId: this.config.clientId,
    });
  }

  private capture() {
    const ib = this.ib, signal = this.transportAbort.signal;
    const current = () => !signal.aborted && !this.retired && ib === this.ib
      && (this.dependencies.continuous?.() ?? true) && !signal.aborted;
    return { ib, signal, current, assert: () => {
      if (!current()) throw new Error('INGESTION_READ_INTERRUPTED');
    } };
  }

  private deadline(timeoutMs: number): () => boolean {
    const started = this.dependencies.monotonicNow?.() ?? performance.now();
    return () => {
      const elapsed = (this.dependencies.monotonicNow?.() ?? performance.now()) - started;
      return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < timeoutMs;
    };
  }

  readSignal(): AbortSignal { return this.transportAbort.signal; }
  generation(): number { return this.transportGeneration; }

  connect(): Promise<void> {
    if (this.retirementError) return Promise.reject(this.retirementError);
    if (this.connecting) return this.connecting;
    if (this.connected) return Promise.resolve();
    if (this.retired) {
      this.ib = this.createIb();
      this.transportAbort = new AbortController();
      this.retired = false;
      this.transportDiagnostic = this.newTransportDiagnostic();
      this.bindCoreListeners();
    }
    const scope = this.capture(), { ib, signal } = scope;
    this.connecting = new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); ib.off('nextValidId', ready); ib.off('error', error);
        signal.removeEventListener('abort', aborted); };
      const fail = (cause: Error) => { cleanup(); reject(cause); };
      const aborted = () => fail(new Error('INGESTION_READ_INTERRUPTED'));
      const deadline = (this.dependencies.monotonicNow?.() ?? performance.now()) + 12_000;
      const timeout = setTimeout(() => fail(new Error('TWS connect timeout waiting for nextValidId')), 12_000);
      const ready = (orderId: number) => {
        if (!scope.current()) return;
        if ((this.dependencies.monotonicNow?.() ?? performance.now()) >= deadline) return fail(new Error('TWS connect timeout waiting for nextValidId'));
        this.connected = true;
        this.transportDiagnostic.connected = true;
        this.transportDiagnostic.nextValidIdAt = this.diagnosticTimestamp();
        this.nextReqId = Math.max(this.nextReqId, Number(orderId) + 1);
        cleanup(); resolve();
      };
      const error = (cause: Error, codeOrMeta?: unknown) => {
        const { code } = ibErrorMeta(codeOrMeta);
        if ([502, 503, 504].includes(code ?? 0)) fail(Object.assign(new Error('TWS_CONNECT_FAILED'), {
          sourceError: { ...captureResearchSourceError(cause), code },
        }));
      };
      signal.addEventListener('abort', aborted, { once: true });
      ib.once('nextValidId', ready); ib.on('error', error);
      try { scope.assert(); ib.connect(); } catch (cause) { fail(cause instanceof Error ? cause : new Error('TWS_CONNECT_FAILED')); }
    }).then(() => {
      scope.assert();
      ib.reqMarketDataType(this.config.marketDataType);
      this.onLog('TWS: połączenie odczytu gotowe');
    }).catch(error => { this.disconnect(); throw error; }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  probe(): Promise<void> {
    if (this.probing) return this.probing;
    if (!this.connected) return Promise.reject(new Error('TWS_NOT_CONNECTED'));
    const scope = this.capture(), { ib, signal } = scope;
    const started = this.dependencies.monotonicNow?.() ?? performance.now();
    this.probing = new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); ib.off('currentTime', received); signal.removeEventListener('abort', aborted); };
      const finish = (error?: Error) => { cleanup(); if (error) reject(error); else resolve(); };
      const aborted = () => finish(new Error('INGESTION_READ_INTERRUPTED'));
      const timer = setTimeout(() => finish(new Error('TWS_LIVENESS_TIMEOUT')), 15_000);
      const received = (value: unknown) => {
        if (!scope.current()) return;
        const elapsed = (this.dependencies.monotonicNow?.() ?? performance.now()) - started;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 15_000) return finish(new Error('TWS_LIVENESS_TIMEOUT'));
        if (!Number.isSafeInteger(value) || Number(value) <= 0) return finish(new Error('TWS_LIVENESS_INVALID_REPLY'));
        finish();
      };
      signal.addEventListener('abort', aborted, { once: true }); ib.on('currentTime', received);
      try { scope.assert(); ib.reqCurrentTime(); } catch (cause) { finish(cause instanceof Error ? cause : new Error('TWS_LIVENESS_SEND_FAILED')); }
    }).catch(error => { this.disconnect(); throw error; }).finally(() => { this.probing = undefined; });
    return this.probing;
  }

  disconnect(): void {
    if (this.retired) return;
    this.retired = true;
    this.transportGeneration++;
    this.connected = false;
    this.transportDiagnostic.connected = false;
    this.transportDiagnostic.retired = true;
    this.transportDiagnostic.aborted = true;
    this.transportDiagnostic.retiredAt = this.diagnosticTimestamp();
    this.subscriptionsByConid.clear();
    this.tickerStates.clear();
    this.transportAbort.abort();
    const ib = this.ib;
    // ib 0.2.9 queues disconnect behind handshake; destroy the actual socket instead.
    if (!this.dependencies.ib && !this.dependencies.ibFactory) {
      const controller = ib._controller, socket = controller?._socket, commands = controller?._commands;
      if (!socket || !commands || typeof commands.pause !== 'function' || !Array.isArray(commands._commands) || !Array.isArray(commands._commandsCurrent)
        || (socket._client !== null && typeof socket._client?.destroy !== 'function')) {
        this.retirementError = new Error('TWS_TRANSPORT_RETIREMENT_UNSUPPORTED');
        this.onLog(this.retirementError.message);
        return;
      }
      commands.pause(); commands._commands.length = 0; commands._commandsCurrent.length = 0;
      socket._connected = false;
      // Late close handlers resume the command buffer, which has been emptied.
      if (socket._client) { socket._client.on('error', () => {}); socket._client.destroy(); }
    } else {
      try { ib.disconnect?.(); } catch { /* Test/adapter transport is already invalidated. */ }
    }
  }

  async confirmFinalEsMinute(
    sub: InstrumentSubscription,
    minute: Date,
  ): Promise<Candle | null> {
    const scope = this.capture(), { ib, signal } = scope;
    scope.assert();
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
    await this.acquireHistoricalPacingToken(signal);
    scope.assert();
    const reqId = this.allocReqId();
    const withinDeadline = this.deadline(30000);
    return new Promise<Candle | null>((resolve, reject) => {
      const matches: Candle[] = [];
      const aborted = () => { cleanup(); reject(new Error("INGESTION_READ_INTERRUPTED")); };
      const cleanup = () => {
        signal.removeEventListener("abort", aborted);
        clearTimeout(timeout);
        ib.off("historicalData", onHistoricalData);
        ib.off("error", onError);
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
        if (!scope.current()) return;
        if (!withinDeadline()) { cleanup(); reject(new Error('TWS_READ_TIMEOUT')); return; }
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
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      ib.on("historicalData", onHistoricalData);
      ib.on("error", onError);
      try {
        ib.reqHistoricalData(reqId, contract,
          formatIbUtcEndDateTime(new Date(minute.getTime() + 60_000)), "120 S",
          IBKR_ES_BAR_REQUEST.barSize, IBKR_ES_BAR_REQUEST.whatToShow,
          IBKR_ES_BAR_REQUEST.useRTH, IBKR_ES_BAR_REQUEST.formatDate,
          IBKR_ES_BAR_REQUEST.keepUpToDate);
      } catch {
        cleanup(); reject(new Error("Native FUT final-bar request could not be sent"));
      }
    });
  }

  async acquireHistoricalPacingToken(signal: AbortSignal = this.transportAbort.signal): Promise<void> {
    const windowMs = 10 * 60_000;
    while (true) {
      if (signal.aborted || !(this.dependencies.continuous?.() ?? true)) throw new Error('INGESTION_READ_INTERRUPTED');
      const now = this.dependencies.now?.() ?? Date.now();
      if (!Number.isFinite(now)) throw new Error('INGESTION_CLOCK_INVALID');
      while (this.finalBarRequestTimes.length && now - this.finalBarRequestTimes[0] >= windowMs)
        this.finalBarRequestTimes.shift();
      if (this.finalBarRequestTimes.length < 50) {
        this.finalBarRequestTimes.push(now);
        return;
      }
      const wait = windowMs - (now - this.finalBarRequestTimes[0]) + 50;
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', aborted); };
        const aborted = () => { cleanup(); reject(new Error('INGESTION_READ_INTERRUPTED')); };
        const done = () => { cleanup(); resolve(); };
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) return aborted();
        if (this.dependencies.sleep) void this.dependencies.sleep(Math.min(wait, 30_000)).then(done, error => { cleanup(); reject(error); });
        else timer = setTimeout(done, Math.min(wait, 30_000));
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getManagedAccounts(): Promise<string[]> {
    const scope = this.capture(), { ib, signal } = scope;
    scope.assert();
    const withinDeadline = this.deadline(8000);
    const accounts = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for managedAccounts from TWS"));
      }, 8_000);

      const aborted = () => { cleanup(); reject(new Error("INGESTION_READ_INTERRUPTED")); };
      const cleanup = () => {
        signal.removeEventListener("abort", aborted);
        clearTimeout(timeout);
        ib.off("managedAccounts", onManagedAccounts);
      };

      const onManagedAccounts = (accountsList: string) => {
        if (!scope.current()) return;
        if (!withinDeadline()) { cleanup(); reject(new Error('TWS_READ_TIMEOUT')); return; }
        cleanup();
        resolve(accountsList);
      };

      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      ib.once("managedAccounts", onManagedAccounts);
      try { ib.reqManagedAccts(); } catch (error) { cleanup(); reject(error); }
    });

    return accounts
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  async resolveContracts(
    instruments: WatchlistInstrument[],
  ): Promise<InstrumentSubscription[]> {
    const scope = this.capture();
    const out: InstrumentSubscription[] = [];

    for (const instrument of instruments) {
      scope.assert();
      try {
        const contract = await this.resolveContract(instrument);
        out.push(contract);
      } catch (error) {
        this.onLog(`Nie udało się ustalić kontraktu ${contractDiagnosticText(instrument.symbol, this.dependencies.privacy)}: ${contractSourceError(error, this.dependencies.privacy).message}`);
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
  async fetchSessionCandles(sub: InstrumentSubscription, identity: InstrumentSessionIdentity, timeframe: SessionTimeframe, count: number): Promise<Candle[]> {
    if (sub.instrumentId !== identity.instrumentId || sub.conid !== String(identity.conId) || sub.symbol !== identity.symbol
      || !['1m', '5m', '1h', '4h', '1d', '1w'].includes(timeframe) || !Number.isSafeInteger(count) || count < 1)
      throw new Error("session_native_request_invalid");
    return this.requestHistorical(sub, timeframe, count, { sessionIdentity: identity });
  }

  async fetchNativeAaplCandles(sub: InstrumentSubscription, timeframe: AaplTimeframe, count: number): Promise<Candle[]> {
    if (!isAaplSubscription(sub) || !Object.hasOwn(AAPL_REQUIRED_CANDLES, timeframe) || !Number.isSafeInteger(count) || count <= 0)
      throw new Error("aapl_native_request_invalid");
    return this.requestHistorical(sub, timeframe, count);
  }

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
    const scope = this.capture();
    const total = subscriptions.length;
    let index = 0;
    for (const sub of subscriptions) {
      scope.assert();
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
        instrument.instrumentId,
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
          `contractDetails unavailable for ${contractDiagnosticText(symbol, this.dependencies.privacy)}; using WATCHLIST_CONTRACT_OVERRIDES fallback: ${contractSourceError(error, this.dependencies.privacy).message}`,
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
    const scope = this.capture(), { ib, signal } = scope;
    scope.assert();
    const reqId = this.allocReqId();
    const contract = this.withDefaults(contractLike);

    return awaitContractDetails({ ib, signal, current: scope.current, monotonicNow: this.dependencies.monotonicNow,
      reqId, contract, label: symbol, timeoutMs: 8_000, ...this.contractDiagnosticInput() }, false);
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
    instrumentId?: string,
  ): Promise<ContractDetailsShape> {
    const reqId = this.allocReqId();
    const contract = this.withDefaults(contractLike);
    const scope = this.capture(); scope.assert();
    return awaitExactlyOneContractDetails({
      ib: scope.ib as IbEventPort, signal: scope.signal, current: scope.current, monotonicNow: this.dependencies.monotonicNow,
      reqId,
      contract,
      label,
      timeoutMs: 8_000,
      ...this.contractDiagnosticInput(instrumentId),
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
    options: { progressPrefix?: string; sessionIdentity?: InstrumentSessionIdentity } = {},
  ): Promise<Candle[]> {
    const scope = this.capture(), { ib, signal } = scope;
    scope.assert();
    if (isAaplSubscription(sub) && !Object.hasOwn(AAPL_REQUIRED_CANDLES, timeframe)) throw new Error("aapl_timeframe_unsupported");
    await this.acquireHistoricalPacingToken(signal);
    scope.assert();
    const reqId = this.allocReqId();
    if (isWseSubscription(sub) && timeframe === "12h") throw new Error("wse_12h_unsupported");
    const { barSize, durationStr } = this.historicalParamsFor(
      timeframe,
      candlesPerSymbol,
    );
    const identity = options.sessionIdentity;
    const contract = identity ? { conId: identity.conId, symbol: identity.symbol, secType: identity.secType,
      exchange: identity.exchange, currency: identity.currency, ...(identity.localSymbol ? { localSymbol: identity.localSymbol } : {}),
      ...(identity.tradingClass ? { tradingClass: identity.tradingClass } : {}), ...(identity.primaryExchange ? { primaryExch: identity.primaryExchange } : {}) }
      : this.withDefaults(sub.contract ?? { symbol: sub.symbol, conId: Number(sub.conid) });

    const withinDeadline = this.deadline(30000);
    return new Promise<Candle[]>((resolve, reject) => {
      const bars: Candle[] = [];
      let settled = false;
      let brokerCompleted = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `Timed out waiting historicalData (${timeframe}) for ${sub.symbol}`,
          ),
        );
      }, 30_000);

      const aborted = () => { cleanup(); reject(new Error("INGESTION_READ_INTERRUPTED")); };
      const cleanup = () => {
        signal.removeEventListener("abort", aborted);
        clearTimeout(timeout);
        ib.off("historicalData", onHistoricalData);
        ib.off("error", onError);
        if (options.sessionIdentity && !brokerCompleted) { try { ib.cancelHistoricalData?.(reqId); } catch { /* broker may already be disconnected */ } }
      };

      const finalize = () => {
        if (settled) return;
        brokerCompleted = true;
        settled = true;
        cleanup();
        if (options.sessionIdentity && bars.length === 0) { reject(new Error('session_native_history_empty')); return; }
        const uniqueByTs = new Map<number, Candle>();
        for (const candle of bars) {
          if (options.sessionIdentity && uniqueByTs.has(candle.ts.getTime())) {
            reject(new Error('session_native_duplicate_timestamp')); return;
          }
          uniqueByTs.set(candle.ts.getTime(), candle);
        }
        const ordered = Array.from(uniqueByTs.values()).sort(
          (a, b) => a.ts.getTime() - b.ts.getTime(),
        );
        const finalized = !options.sessionIdentity && isWseSubscription(sub) ? ordered.filter(c => validClosedWseCandle(c, Date.now())) : ordered;
        const sliced = finalized.slice(
          Math.max(0, finalized.length - candlesPerSymbol),
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
        if (!scope.current()) return;
        if (!withinDeadline()) { cleanup(); reject(new Error('TWS_READ_TIMEOUT')); return; }
        if (incomingReqId !== reqId) return;

        if (
          typeof date === "string" &&
          date.toLowerCase().startsWith("finished")
        ) {
          finalize();
          return;
        }

        let ts: Date | undefined;
        if (options.sessionIdentity) {
          if (typeof date !== 'string') return;
          if (timeframe === '1d' || timeframe === '1w') {
            if (!/^\d{8}$/.test(date)) return;
            try { ts = new Date(sessionLocalMidnight(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, options.sessionIdentity.timeZone)); }
            catch { return; }
          } else {
            if (!/^\d{9,10}$/.test(date)) return;
            ts = new Date(Number(date) * 1000);
            if (ts.getUTCFullYear() < 2000 || ts.getUTCFullYear() > 2100) return;
          }
        } else if (isAaplSubscription(sub)) {
          if (typeof date !== "string") return;
          if (timeframe === "1d" || timeframe === "1w") {
            if (!/^\d{8}$/.test(date)) return;
            try { ts = newYorkMidnight(+date.slice(0, 4), +date.slice(4, 6), +date.slice(6, 8)); }
            catch { return; }
          } else {
            if (!/^\d{9,10}$/.test(date)) return;
            ts = new Date(Number(date) * 1000);
            if (ts.getUTCFullYear() < 2000 || ts.getUTCFullYear() > 2100) return;
          }
        } else if (isWseSubscription(sub) && /^\d{8}$/.test(date)) {
          const year = +date.slice(0, 4), month = +date.slice(4, 6), day = +date.slice(6, 8);
          const check = new Date(Date.UTC(year, month - 1, day));
          if (year < 2000 || year > 2100 || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return;
          ts = warsawMidnight(year, month, day);
        } else ts = this.parseHistoricalDate(date);
        if (!ts) return;

        bars.push({
          ...(options.sessionIdentity ? { source: sessionNativeSource(options.sessionIdentity) } : isWseSubscription(sub) ? { source: WSE_NATIVE_SOURCE } : isAaplSubscription(sub) ? { source: AAPL_NATIVE_SOURCE } : {}),
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

      const onError = (err: Error, codeOrMeta?: unknown, incomingReqId?: number) => {
        const meta = options.sessionIdentity || isAaplSubscription(sub) ? ibErrorMeta(codeOrMeta, incomingReqId) : { code: toNum(codeOrMeta), reqId: incomingReqId };
        if (meta.reqId !== reqId || settled) return;
        settled = true;
        const message = err?.message ?? "unknown historical data error";
        cleanup();
        reject(
          new Error(
            `historicalData error ${meta.code ?? "unknown"} for ${sub.symbol}: ${message}`,
          ),
        );
      };

      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      ib.on("historicalData", onHistoricalData);
      ib.on("error", onError);
      try {
        ib.reqHistoricalData(
          reqId,
          contract,
          "",
          durationStr,
          barSize,
          options.sessionIdentity?.secType === "CASH" ? "MIDPOINT" : "TRADES",
          options.sessionIdentity ? (options.sessionIdentity.useRTH ? 1 : 0) : isWseSubscription(sub) || isAaplSubscription(sub) ? 1 : 0,
          2,
          false,
        );
      } catch (error) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      }
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
    const scope = this.capture();
    const listen = (event: string, handler: (...args: any[]) => void) => {
      scope.ib.on(event, (...args: any[]) => { if (scope.current()) handler(...args); });
    };
    listen("connected", () => {
      this.transportDiagnostic.socketConnectedAt = this.diagnosticTimestamp();
      this.onLog("TWS socket connected event received");
    });

    listen("server", (version: unknown) => {
      this.transportDiagnostic.serverAt = this.diagnosticTimestamp();
      this.transportDiagnostic.serverVersion = Number.isSafeInteger(version) ? Number(version) : null;
    });

    listen("disconnected", () => {
      this.transportDiagnostic.disconnectedAt = this.diagnosticTimestamp();
      this.onLog("TWS socket disconnected");
      this.disconnect();
      this.dependencies.onConnectionInvalidated?.();
      for (const state of this.tickerStates.values()) {
        state.bidObservedAt = undefined;
        state.askObservedAt = undefined;
        state.marketDataType = undefined;
      }
    });

    listen("error", (arg1: unknown, arg2?: unknown, arg3?: unknown) => {
      const parsed = this.parseIbErrorArgs(arg1, arg2, arg3);
      const sourceError = contractSourceError(arg1, this.dependencies.privacy, parsed.code);
      const context = { observedAt: this.diagnosticTimestamp(), generation: this.transportGeneration, sourceError };
      const global = parsed.reqId === undefined || Number(parsed.reqId) === -1;
      if (global) {
        this.transportDiagnostic.globalContext.push(context);
        if (this.transportDiagnostic.globalContext.length > 8) {
          this.transportDiagnostic.globalContext.shift(); this.transportDiagnostic.omittedGlobalMessages++;
        }
      }
      emitContractDiagnostic(this.dependencies.onDiagnostic, { event: 'broker_context',
        message: global ? 'Komunikat połączenia TWS; nie stanowi przyczyny błędu konkretnego żądania' : 'Komunikat TWS przypisany do żądania',
        context: { ...context, requestId: parsed.reqId !== undefined && Number.isSafeInteger(Number(parsed.reqId)) ? Number(parsed.reqId) : null, scope: global ? 'GLOBAL' : 'REQUEST' } });
      if (parsed.code !== undefined && [1100, 1101, 1102, 1300].includes(Number(parsed.code))) {
        this.disconnect(); this.dependencies.onConnectionInvalidated?.();
      }
      if (!this.dependencies.onDiagnostic) this.onLog(`TWS: ${sourceError.code ?? 'brak kodu'}; ${sourceError.message}`);
    });

    listen("marketDataType", (tickerId: number, type: number) => {
      const state = this.tickerStates.get(tickerId);
      if (!state) return;
      if (state.marketDataType !== type) {
        state.bidObservedAt = undefined;
        state.askObservedAt = undefined;
      }
      state.marketDataType = type;
      this.emitTick(state);
    });

    listen(
      "tickPrice",
      (tickerId: number, field: number, price: number) => {
        const state = this.tickerStates.get(tickerId);
        if (!state) return;
        if (!Number.isFinite(price)) {
          if (field === 1 || field === 66) state.bidObservedAt = undefined;
          if (field === 2 || field === 67) state.askObservedAt = undefined;
          this.emitTick(state);
          return;
        }

        // Live: 1/2/4, Delayed: 66/67/68, Close fallback: 9/75
        if (field === 1 || field === 66) {
          state.bid = price;
          state.bidObservedAt = field === 1 && state.marketDataType === 1
            ? new Date(this.dependencies.now?.() ?? Date.now()).toISOString() : undefined;
        } else if (field === 2 || field === 67) {
          state.ask = price;
          state.askObservedAt = field === 2 && state.marketDataType === 1
            ? new Date(this.dependencies.now?.() ?? Date.now()).toISOString() : undefined;
        }
        else if (field === 4 || field === 68) state.price = price;
        else if (field === 9 || field === 75) state.close = price;

        this.emitTick(state);
      },
    );

    listen("tickSize", (tickerId: number, field: number, size: number) => {
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

    listen(
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

    try { void Promise.resolve(this.onTick({
      conid: state.conid,
      symbol: state.symbol,
      price,
      bid: state.bid,
      ask: state.ask,
      bidObservedAt: state.bidObservedAt,
      askObservedAt: state.askObservedAt,
      marketDataType: state.marketDataType,
      size: state.size,
      ts: new Date(this.dependencies.now?.() ?? Date.now()),
    })).catch(() => this.onLog('INGESTION_TICK_PUBLICATION_FAILED')); }
    catch { this.onLog('INGESTION_TICK_PUBLICATION_FAILED'); }
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
