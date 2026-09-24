import { WSE_REQUIRED_CANDLES, validClosedWseCandle, wseCandleEnd, type Candle, type WseTimeframe } from "@ikbr/shared";
import type { InstrumentSubscription } from "./types.js";

export function isWseSubscription(sub: InstrumentSubscription | undefined): boolean {
  return sub?.instrumentId === "pko_wse" && sub.conid === "35146360" && sub.symbol === "PKO"
    && sub.contract?.secType === "STK" && sub.contract?.exchange === "WSE" && sub.contract?.currency === "PLN";
}
const intervals: Record<WseTimeframe, number> = { "1m": 60000, "5m": 300000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };
export interface WseWarmupStatus {
  conid: string; timeframe: WseTimeframe; required: number; available: number; nativeClosed: number;
  latest: string | null; checkedAt: string; error?: string;
}
export class WseNativeRefresh {
  private running: Promise<void> | undefined;
  private checked = new Map<string, number>();
  readonly status = new Map<string, WseWarmupStatus>();
  constructor(private readonly dependencies: {
    read(conid: string, tf: WseTimeframe, limit: number): Promise<Candle[]>;
    fetch(sub: InstrumentSubscription, tf: WseTimeframe, count: number): Promise<Candle[]>;
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
    for (const sub of subscriptions.filter(isWseSubscription)) for (const tf of Object.keys(WSE_REQUIRED_CANDLES) as WseTimeframe[]) {
      const now = this.dependencies.now?.() ?? Date.now();
      const key = `${sub.conid}:${tf}`;
      if (!force && now - (this.checked.get(key) ?? 0) < Math.min(intervals[tf], 300000)) continue;
      const required = WSE_REQUIRED_CANDLES[tf];
      try {
        const current = await this.dependencies.read(sub.conid, tf, required + 10);
        const valid = current.filter(c => c.conid === sub.conid && c.symbol === sub.symbol && c.timeframe === tf && validClosedWseCandle(c, now));
        const latest = valid.at(-1)?.ts;
        const nextClosedAt = latest ? wseCandleEnd(new Date(wseCandleEnd(latest, tf)), tf) : NaN;
        if (valid.length < required || !Number.isFinite(nextClosedAt) || now >= nextClosedAt) {
          this.checked.set(key, now);
          const fetched = await this.dependencies.fetch(sub, tf, required + 10);
          for (const c of fetched) if (c.conid === sub.conid && c.symbol === sub.symbol && c.timeframe === tf && validClosedWseCandle(c, now)) await this.dependencies.write(c);
        }
        const rows = await this.dependencies.read(sub.conid, tf, required + 10);
        const closed = rows.filter(c => c.conid === sub.conid && c.symbol === sub.symbol && c.timeframe === tf && validClosedWseCandle(c, now));
        this.status.set(key, { conid: sub.conid, timeframe: tf, required, available: rows.length, nativeClosed: closed.length,
          latest: closed.at(-1)?.ts.toISOString() ?? null, checkedAt: new Date(now).toISOString(),
          ...(closed.length < required ? { error: "insufficient_native_closed_candles" } : {}) });
      } catch (error) {
        this.status.set(key, { conid: sub.conid, timeframe: tf, required, available: 0, nativeClosed: 0, latest: null,
          checkedAt: new Date(now).toISOString(), error: error instanceof Error ? error.message : "wse_native_refresh_failed" });
      }
    }
  }
}
