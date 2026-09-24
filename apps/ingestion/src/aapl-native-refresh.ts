import { AAPL_REQUIRED_CANDLES, validClosedAaplCandle, aaplCandleEnd, type Candle, type AaplTimeframe } from "@ikbr/shared";
import type { InstrumentSubscription } from "./types.js";

export function isAaplSubscription(sub: InstrumentSubscription | undefined): boolean {
  return sub?.instrumentId === "aapl_nasdaq" && sub.conid === "265598" && sub.symbol === "AAPL"
    && sub.contract?.secType === "STK" && sub.contract?.exchange === "SMART" && sub.contract?.currency === "USD"
    && (sub.contract.conId === undefined || sub.contract.conId === 265598)
    && (sub.contract.symbol === undefined || sub.contract.symbol === "AAPL");
}
const intervals: Record<AaplTimeframe, number> = { "1m": 60000, "5m": 300000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };
const freshness: Record<AaplTimeframe, number> = { "1m": 180000, "5m": 600000, "1h": 5400000, "4h": 21600000, "1d": 259200000, "1w": 864000000 };
export interface AaplWarmupStatus {
  conid: string; timeframe: AaplTimeframe; required: number; available: number; nativeClosed: number;
  latest: string | null; latestEnd: string | null; checkedAt: string; error?: string;
}
export class AaplNativeRefresh {
  private running: Promise<void> | undefined;
  private checked = new Map<string, number>();
  readonly status = new Map<string, AaplWarmupStatus>();
  constructor(private readonly dependencies: {
    read(conid: string, tf: AaplTimeframe, limit: number): Promise<Candle[]>;
    fetch(sub: InstrumentSubscription, tf: AaplTimeframe, count: number): Promise<Candle[]>;
    write(candle: Candle): Promise<void>;
    now?: () => number;
  }) {}
  idle(): Promise<void> { return this.running ?? Promise.resolve(); }
  run(subscriptions: readonly InstrumentSubscription[], force = false): Promise<void> {
    if (this.running) return this.running;
    const work = this.refresh(subscriptions, force);
    this.running = work.finally(() => { this.running = undefined; });
    return this.running;
  }
  private async refresh(subscriptions: readonly InstrumentSubscription[], force: boolean): Promise<void> {
    const now = () => this.dependencies.now?.() ?? Date.now();
    for (const sub of subscriptions.filter(isAaplSubscription)) for (const tf of Object.keys(AAPL_REQUIRED_CANDLES) as AaplTimeframe[]) {
      const key = `${sub.conid}:${tf}`, started = now(), required = AAPL_REQUIRED_CANDLES[tf];
      // Forced bootstrap rechecks source counts but cannot bypass request backoff.
      const lastAttempt = this.checked.get(key);
      if (!force && lastAttempt !== undefined && started - lastAttempt < Math.min(intervals[tf], 300000)) continue;
      const valid = (rows: Candle[], at: number) => rows.filter(c => c.timeframe === tf && validClosedAaplCandle(c, at));
      try {
        const current = valid(await this.dependencies.read(sub.conid, tf, required + 10), started);
        const latest = current.at(-1)?.ts;
        const nextClosedAt = latest ? aaplCandleEnd(new Date(aaplCandleEnd(latest, tf)), tf) : NaN;
        if ((current.length < required || !Number.isFinite(nextClosedAt) || started >= nextClosedAt)
          && (lastAttempt === undefined || started - lastAttempt >= Math.min(intervals[tf], 300000))) {
          this.checked.set(key, started);
          const fetched = await this.dependencies.fetch(sub, tf, required + 10);
          for (const candle of valid(fetched, now())) await this.dependencies.write(candle);
        }
        const checkedAt = now(), rows = await this.dependencies.read(sub.conid, tf, required + 10);
        const closed = valid(rows, checkedAt), last = closed.at(-1)?.ts, end = last ? aaplCandleEnd(last, tf) : NaN;
        this.status.set(key, { conid: sub.conid, timeframe: tf, required, available: rows.length, nativeClosed: closed.length,
          latest: last?.toISOString() ?? null, latestEnd: Number.isFinite(end) ? new Date(end).toISOString() : null,
          checkedAt: new Date(checkedAt).toISOString(),
          ...(closed.length < required ? { error: "insufficient_native_closed_candles" } :
            checkedAt - end > freshness[tf] ? { error: "stale_native_closed_candles" } : {}) });
      } catch (error) {
        this.checked.set(key, now());
        this.status.set(key, { conid: sub.conid, timeframe: tf, required, available: 0, nativeClosed: 0, latest: null, latestEnd: null,
          checkedAt: new Date(now()).toISOString(), error: error instanceof Error ? error.message : "aapl_native_refresh_failed" });
      }
    }
  }
}
