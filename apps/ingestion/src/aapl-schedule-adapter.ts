import { IBApi, BarSizeSetting, WhatToShow, SecType } from "@stoqey/ib";
import { parseBrokerAaplSchedule, type AaplSchedule } from "@ikbr/shared";

const contract = Object.freeze({ conId: 265598, symbol: "AAPL", secType: SecType.STK, exchange: "SMART", primaryExch: "NASDAQ", currency: "USD" });
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
export class AaplScheduleAdapter {
  constructor(private readonly options: {
    host: string; port: number; clientId: number;
    acquirePacing(): Promise<void>;
    socket?: () => ScheduleSocket;
    timeoutMs?: number;
    now?: () => number;
  }) {}
  async fetch(): Promise<AaplSchedule> {
    await this.options.acquirePacing();
    const ib = this.options.socket?.() ?? new IBApi({ host: this.options.host, port: this.options.port, clientId: this.options.clientId }) as unknown as ScheduleSocket;
    // SDK socket errors may arrive asynchronously after disconnect. Keep a harmless listener on this retired connection.
    ib.on("error", () => {});
    const requestedAt = new Date(this.options.now?.() ?? Date.now()).toISOString();
    return new Promise((resolve, reject) => {
      const detailsId = 91001, historyId = 91002;
      let done = false, requested = false, detailsRequested = false;
      const details: any[] = [];
      const listeners: Array<[string, (...args: any[]) => void]> = [];
      const listen = (event: string, handler: (...args: any[]) => void) => { listeners.push([event, handler]); ib.on(event, handler); };
      const finish = (error?: Error, schedule?: AaplSchedule) => {
        if (done) return;
        done = true; clearTimeout(timer);
        for (const [event, handler] of listeners) ib.off(event, handler);
        if (requested) { try { ib.cancelHistoricalData(historyId); } catch { /* disconnected */ } }
        try { ib.disconnect(); } catch { /* disconnected */ }
        if (error) reject(error); else resolve(schedule!);
      };
      const timer = setTimeout(() => finish(new Error("aapl_schedule_timeout")), this.options.timeoutMs ?? 25000);
      listen("nextValidId", () => {
        if (detailsRequested) return;
        if (!Number.isFinite(ib.serverVersion) || ib.serverVersion < 165) return finish(new Error("aapl_schedule_unsupported_server"));
        detailsRequested = true;
        try { ib.reqContractDetails(detailsId, contract); } catch { finish(new Error("aapl_schedule_contract_request_failed")); }
      });
      listen("contractDetails", (id, detail) => {
        if (id !== detailsId) return;
        if (requested) return finish(new Error("aapl_schedule_late_contract_details"));
        details.push(detail);
      });
      listen("contractDetailsEnd", (id) => {
        if (id !== detailsId || requested) return;
        const c = details[0]?.contract;
        if (!detailsRequested || details.length !== 1 || c?.conId !== 265598 || c?.symbol !== "AAPL" || c?.secType !== "STK"
          || c?.exchange !== "SMART" || c?.currency !== "USD" || c?.primaryExch !== "NASDAQ")
          return finish(new Error("aapl_schedule_contract_identity_mismatch"));
        requested = true;
        try { ib.reqHistoricalData(historyId, contract, "", "14 D", BarSizeSetting.DAYS_ONE, WhatToShow.SCHEDULE, true, 1, false); }
        catch { finish(new Error("aapl_schedule_request_failed")); }
      });
      listen("historicalSchedule", (id, startDateTime, endDateTime, timeZone, sessions) => {
        if (id !== historyId || !requested) return;
        try {
          const schedule = parseBrokerAaplSchedule({ startDateTime, endDateTime, timeZone, sessions }, requestedAt, new Date(this.options.now?.() ?? Date.now()).toISOString());
          finish(undefined, schedule);
        } catch (error) { finish(error instanceof Error ? error : new Error("aapl_schedule_invalid")); }
      });
      listen("error", (_error, code, id) => {
        if (id === detailsId || id === historyId || [502, 503, 504, 1100, 1101, 1102, 1300].includes(code)) finish(new Error(`aapl_schedule_broker_error_${code}`));
      });
      listen("disconnected", () => finish(new Error("aapl_schedule_disconnected")));
      try { ib.connect(); } catch { finish(new Error("aapl_schedule_connect_failed")); }
    });
  }
}
