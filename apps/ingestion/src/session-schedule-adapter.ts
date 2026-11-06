import { IBApi, BarSizeSetting, WhatToShow } from "@stoqey/ib";
import { parseBrokerSessionSchedule, parseBrokerContractSessionHours, type ContractSessionHours, type SessionSchedule, type InstrumentSessionIdentity } from "@ikbr/shared";

interface ScheduleSocket {
  serverVersion: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  connect(): unknown; disconnect(): unknown;
  reqContractDetails(id: number, value: Record<string, unknown>): unknown;
  reqHistoricalData(...args: any[]): unknown;
  cancelHistoricalData(id: number): unknown;
}

/** Narrow schedule-only connection; no order API is exposed. */
export class SessionScheduleAdapter {
  constructor(private readonly options: {
    host: string; port: number; clientId: number;
    acquirePacing(signal?: AbortSignal): Promise<void>;
    current?: () => boolean;
    socket?: () => ScheduleSocket;
    timeoutMs?: number;
    now?: () => number;
  }) {}
  private tail: Promise<unknown> = Promise.resolve();
  private abort = new AbortController();
  invalidate(): void { this.abort.abort(); this.abort = new AbortController(); }
  fetch(identity: InstrumentSessionIdentity): Promise<SessionSchedule> {
    const signal = this.abort.signal;
    const result = this.tail.catch(() => undefined).then(() => this.request(identity, signal));
    this.tail = result;
    return result;
  }
  private async request(identity: InstrumentSessionIdentity, signal: AbortSignal): Promise<SessionSchedule> {
    const current = () => !signal.aborted && (this.options.current?.() ?? true) && !signal.aborted;
    const assertCurrent = () => { if (!current()) throw new Error('session_schedule_interrupted'); };
    assertCurrent();
    const contract = { conId: identity.conId, symbol: identity.symbol, secType: identity.secType, exchange: identity.exchange,
      currency: identity.currency, ...(identity.primaryExchange ? { primaryExch: identity.primaryExchange } : {}),
      ...(identity.localSymbol ? { localSymbol: identity.localSymbol } : {}), ...(identity.tradingClass ? { tradingClass: identity.tradingClass } : {}) };
    await this.options.acquirePacing(signal);
    assertCurrent();
    const ib = this.options.socket?.() ?? new IBApi({ host: this.options.host, port: this.options.port, clientId: this.options.clientId }) as unknown as ScheduleSocket;
    // SDK socket errors may arrive asynchronously after disconnect. Keep a harmless listener on this retired connection.
    ib.on("error", () => {});
    const requestedAt = new Date(this.options.now?.() ?? Date.now()).toISOString();
    return new Promise((resolve, reject) => {
      const detailsId = 91001, historyId = 91002;
      let done = false, requested = false, brokerCompleted = false, detailsRequested = false;
      const details: any[] = [];
      let currentHours: ContractSessionHours | undefined;
      const listeners: Array<[string, (...args: any[]) => void]> = [];
      const listen = (event: string, handler: (...args: any[]) => void) => {
        const guarded = (...args: any[]) => {
          if (!current()) return finish(new Error('session_schedule_interrupted'));
          const elapsed = (this.options.now?.() ?? Date.now()) - Date.parse(requestedAt);
          if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= (this.options.timeoutMs ?? 25000))
            return finish(new Error('session_schedule_timeout'));
          handler(...args);
        };
        listeners.push([event, guarded]); ib.on(event, guarded);
      };
      const finish = (error?: Error, schedule?: SessionSchedule) => {
        if (done) return;
        done = true; clearTimeout(timer); signal.removeEventListener("abort", aborted);
        for (const [event, handler] of listeners) ib.off(event, handler);
        if (requested && !brokerCompleted) { try { ib.cancelHistoricalData(historyId); } catch { /* disconnected */ } }
        try { ib.disconnect(); } catch { /* disconnected */ }
        if (error) reject(error); else resolve(schedule!);
      };
      const aborted = () => finish(new Error('session_schedule_interrupted'));
      const timer = setTimeout(() => finish(new Error("session_schedule_timeout")), this.options.timeoutMs ?? 25000);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      listen("nextValidId", () => {
        if (detailsRequested) return;
        if (!Number.isFinite(ib.serverVersion) || ib.serverVersion < 165) return finish(new Error("session_schedule_unsupported_server"));
        detailsRequested = true;
        try { ib.reqContractDetails(detailsId, contract); } catch { finish(new Error("session_schedule_contract_request_failed")); }
      });
      listen("contractDetails", (id, detail) => {
        if (id !== detailsId) return;
        if (requested) return finish(new Error("session_schedule_late_contract_details"));
        details.push(detail);
      });
      listen("contractDetailsEnd", (id) => {
        if (id !== detailsId || requested) return;
        const c = details[0]?.contract;
        if (!detailsRequested || details.length !== 1 || c?.conId !== identity.conId || c?.symbol !== identity.symbol || c?.secType !== identity.secType
          || c?.exchange !== identity.exchange || c?.currency !== identity.currency
          || (identity.primaryExchange !== undefined && c?.primaryExch !== identity.primaryExchange)
          || (identity.localSymbol !== undefined && c?.localSymbol !== identity.localSymbol)
          || (identity.tradingClass !== undefined && c?.tradingClass !== identity.tradingClass))
          return finish(new Error("session_schedule_contract_identity_mismatch"));
        try { currentHours = parseBrokerContractSessionHours(details[0], identity, requestedAt, new Date(this.options.now?.() ?? Date.now()).toISOString()); }
        catch { /* Unsupported optional hours cannot replace historical coverage. */ }
        requested = true;
        try { ib.reqHistoricalData(historyId, contract, "", "14 D", BarSizeSetting.DAYS_ONE, WhatToShow.SCHEDULE, identity.useRTH, 1, false); }
        catch { finish(new Error("session_schedule_request_failed")); }
      });
      listen("historicalSchedule", (id, startDateTime, endDateTime, timeZone, sessions) => {
        if (id !== historyId || !requested || done) return;
        brokerCompleted = true;
        try {
          const schedule = parseBrokerSessionSchedule({ startDateTime, endDateTime, timeZone, sessions }, identity, requestedAt, new Date(this.options.now?.() ?? Date.now()).toISOString());
          if (currentHours) schedule.currentHours = currentHours;
          finish(undefined, schedule);
        } catch (error) { finish(error instanceof Error ? error : new Error("session_schedule_invalid")); }
      });
      listen("error", (_error, code, id) => {
        if (id === detailsId || id === historyId || [502, 503, 504, 1100, 1101, 1102, 1300].includes(code)) finish(new Error(`session_schedule_broker_error_${code}`));
      });
      listen("disconnected", () => finish(new Error("session_schedule_disconnected")));
      try { ib.connect(); } catch { finish(new Error("session_schedule_connect_failed")); }
    });
  }
}
