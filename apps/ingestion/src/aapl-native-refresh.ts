import { AAPL_REQUIRED_CANDLES, evaluateAaplCandles, aaplExpectedSlot, filterClosedAaplCandles, requireAaplSchedule, type AaplScheduleEvidence, type Candle, type AaplTimeframe } from "@ikbr/shared";
import type { InstrumentSubscription } from "./types.js";

export function isAaplSubscription(sub: InstrumentSubscription | undefined): boolean {
  return sub?.instrumentId === "aapl_nasdaq" && sub.conid === "265598" && sub.symbol === "AAPL"
    && sub.contract?.secType === "STK" && sub.contract?.exchange === "SMART" && sub.contract?.currency === "USD"
    && (sub.contract.conId === undefined || sub.contract.conId === 265598)
    && (sub.contract.symbol === undefined || sub.contract.symbol === "AAPL");
}
export interface AaplWarmupStatus {
  conid: string; timeframe: AaplTimeframe; required: number; available: number; nativeClosed: number;
  latest: string | null; latestEnd: string | null; expectedStart?: string; expectedEnd?: string;
  sessionDate?: string; scheduleGeneration?: number; scheduleStatus?: string; coverageStart?: string; coverageEnd?: string; scheduleReceivedAt?: string;
  checkedAt: string; error?: string;
}
export class AaplNativeRefresh {
  private running: Promise<void> | undefined;
  private checked = new Map<string, number>();
  readonly status = new Map<string, AaplWarmupStatus>();
  constructor(private readonly dependencies: {
    read(conid: string, tf: AaplTimeframe, limit: number): Promise<Candle[]>;
    fetch(sub: InstrumentSubscription, tf: AaplTimeframe, count: number): Promise<Candle[]>;
    write(candle: Candle): Promise<void>;
    schedule(): Promise<AaplScheduleEvidence | null>;
    readSchedule(): Promise<AaplScheduleEvidence | null>;
    now?: () => number;
  }) {}
  idle(): Promise<void> { return this.running ?? Promise.resolve(); }
  run(subscriptions: readonly InstrumentSubscription[], _force = false): Promise<void> {
    if (this.running) return this.running;
    const work = this.refresh(subscriptions);
    this.running = work.finally(() => { this.running = undefined; });
    return this.running;
  }
  private async refresh(subscriptions: readonly InstrumentSubscription[]): Promise<void> {
    const now = () => this.dependencies.now?.() ?? Date.now();
    const aapl = subscriptions.filter(isAaplSubscription);
    if (!aapl.length) return;
    let evidence: AaplScheduleEvidence | null;
    try { evidence = await this.dependencies.schedule(); }
    catch (error) {
      for (const sub of aapl) for (const tf of Object.keys(AAPL_REQUIRED_CANDLES) as AaplTimeframe[]) {
        this.status.set(`${sub.conid}:${tf}`, { conid: sub.conid, timeframe: tf, required: AAPL_REQUIRED_CANDLES[tf],
          available: 0, nativeClosed: 0, latest: null, latestEnd: null, scheduleStatus: 'FAILED',
          checkedAt: new Date(now()).toISOString(), error: error instanceof Error ? error.message : 'aapl_schedule_read_failed' });
      }
      return;
    }
    for (const sub of aapl) for (const tf of Object.keys(AAPL_REQUIRED_CANDLES) as AaplTimeframe[]) {
      const key = `${sub.conid}:${tf}`, started = now(), required = AAPL_REQUIRED_CANDLES[tf];
      const lastAttempt = this.checked.get(key);
      try {
        const schedule = requireAaplSchedule(evidence, started);
        const current = await this.dependencies.read(sub.conid, tf, required + 10);
        const currentClosed = filterClosedAaplCandles(current, tf, schedule, started);
        const expected = aaplExpectedSlot(tf, schedule, started);
        // Refresh each missing newly closed slot, including the publication-grace period.
        const missingExpected = expected !== undefined && expected.start !== currentClosed.at(-1)?.ts.toISOString();
        if ((currentClosed.length < required || missingExpected)
          && (lastAttempt === undefined || started - lastAttempt >= 60000)) {
          this.checked.set(key, started);
          const fetched = await this.dependencies.fetch(sub, tf, required + 10);
          const latestEvidence = await this.dependencies.readSchedule();
          requireAaplSchedule(latestEvidence, now());
          if (latestEvidence?.generation !== evidence?.generation) throw new Error("aapl_schedule_generation_changed");
          for (const candle of filterClosedAaplCandles(fetched, tf, schedule, now())) await this.dependencies.write(candle);
        }
        const checkedAt = now(), rows = await this.dependencies.read(sub.conid, tf, required + 10);
        const finalEvidence = await this.dependencies.readSchedule();
        requireAaplSchedule(finalEvidence, checkedAt);
        if (finalEvidence?.generation !== evidence?.generation) throw new Error("aapl_schedule_generation_changed");
        const evaluated = evaluateAaplCandles(rows, tf, finalEvidence, checkedAt);
        this.status.set(key, { conid: sub.conid, timeframe: tf, required, available: rows.length, nativeClosed: evaluated.candles.length,
          latest: evaluated.latestStart ?? null, latestEnd: evaluated.latestEnd ?? null,
          expectedStart: evaluated.expectedStart, expectedEnd: evaluated.expectedEnd,
          sessionDate: schedule.sessions.find(x => Date.parse(x.start) <= checkedAt && checkedAt < Date.parse(x.end))?.date,
          scheduleGeneration: finalEvidence?.generation, scheduleStatus: finalEvidence?.status,
          coverageStart: schedule.coverageStart, coverageEnd: schedule.coverageEnd, scheduleReceivedAt: schedule.receivedAt,
          checkedAt: new Date(checkedAt).toISOString(),
          ...(evaluated.candles.length < required ? { error: "insufficient_native_closed_candles" } :
            evaluated.reason ? { error: evaluated.reason } : {}) });
      } catch (error) {
        this.checked.set(key, now());
        this.status.set(key, { conid: sub.conid, timeframe: tf, required, available: 0, nativeClosed: 0, latest: null, latestEnd: null,
          scheduleGeneration: evidence?.generation, scheduleStatus: evidence?.status,
          checkedAt: new Date(now()).toISOString(), error: error instanceof Error ? error.message : "aapl_native_refresh_failed" });
      }
    }
  }
}
