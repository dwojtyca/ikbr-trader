import { Candle } from '@ikbr/shared';
import { TickEvent } from './types.js';

interface MutableCandle {
  conid: string;
  symbol: string;
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function floorToMinute(ts: Date): Date {
  return new Date(Math.floor(ts.getTime() / 60000) * 60000);
}

export class CandleAggregator {
  private readonly buckets = new Map<string, MutableCandle>();

  ingest(tick: TickEvent): Candle[] {
    const minuteTs = floorToMinute(tick.ts);
    const key = `${tick.conid}:${minuteTs.toISOString()}`;
    const ready: Candle[] = [];

    for (const [bucketKey, bucket] of this.buckets.entries()) {
      if (bucket.conid === tick.conid && bucket.ts.getTime() < minuteTs.getTime()) {
        ready.push({ ...bucket, timeframe: '1m' });
        this.buckets.delete(bucketKey);
      }
    }

    const existing = this.buckets.get(key);
    if (!existing) {
      this.buckets.set(key, {
        conid: tick.conid,
        symbol: tick.symbol,
        ts: minuteTs,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.size ?? 0
      });
      return ready;
    }

    existing.high = Math.max(existing.high, tick.price);
    existing.low = Math.min(existing.low, tick.price);
    existing.close = tick.price;
    existing.volume += tick.size ?? 0;

    return ready;
  }

  flushAll(): Candle[] {
    const candles = Array.from(this.buckets.values()).map((c) => ({ ...c, timeframe: '1m' as const }));
    this.buckets.clear();
    return candles;
  }
}
