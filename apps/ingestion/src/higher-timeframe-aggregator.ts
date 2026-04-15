import { Candle } from '@ikbr/shared';

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

type HigherTimeframe = '5m' | '1h';

function timeframeMs(timeframe: HigherTimeframe): number {
  return timeframe === '5m' ? 5 * 60_000 : 60 * 60_000;
}

function floorToTimeframe(ts: Date, timeframe: HigherTimeframe): Date {
  const ms = timeframeMs(timeframe);
  return new Date(Math.floor(ts.getTime() / ms) * ms);
}

export class HigherTimeframeAggregator {
  private readonly buckets = new Map<string, MutableCandle>();

  ingest(closedOneMinute: Candle): Candle[] {
    const out: Candle[] = [];
    out.push(...this.ingestFor('5m', closedOneMinute));
    out.push(...this.ingestFor('1h', closedOneMinute));
    return out;
  }

  flushAll(): Candle[] {
    const out: Candle[] = [];
    for (const [key, bucket] of this.buckets.entries()) {
      const timeframe = key.includes(':5m:') ? '5m' : '1h';
      out.push({ ...bucket, timeframe });
    }
    this.buckets.clear();
    return out;
  }

  private ingestFor(timeframe: HigherTimeframe, candle: Candle): Candle[] {
    const startTs = floorToTimeframe(candle.ts, timeframe);
    const key = `${candle.conid}:${timeframe}:${startTs.toISOString()}`;
    const ready: Candle[] = [];

    for (const [bucketKey, bucket] of this.buckets.entries()) {
      if (!bucketKey.startsWith(`${candle.conid}:${timeframe}:`)) continue;
      if (bucket.ts.getTime() < startTs.getTime()) {
        ready.push({ ...bucket, timeframe });
        this.buckets.delete(bucketKey);
      }
    }

    const existing = this.buckets.get(key);
    if (!existing) {
      this.buckets.set(key, {
        conid: candle.conid,
        symbol: candle.symbol,
        ts: startTs,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      });
      return ready;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;

    return ready;
  }
}
