import type { Candle } from "@ikbr/shared";
import type { InstrumentSubscription } from "./types.js";

export type ConfirmNativeMinute = (
  subscription: InstrumentSubscription,
  minute: Date,
) => Promise<Candle | null>;

export type PersistCanonicalMinute = (candle: Candle) => Promise<void>;

export interface FuturesFinalBarOptions {
  settlementDelayMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  isOpenMinute?: (minute: Date) => boolean;
  isTerminalError?: (error: unknown) => boolean;
}

export function isFuturesSubscription(subscription: InstrumentSubscription | undefined): boolean {
  return subscription?.instrumentContract?.secType === "FUT" || subscription?.contract?.secType === "FUT";
}

export class FuturesFinalBarCoordinator {
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly finalized = new Set<string>();

  constructor(
    private readonly confirm: ConfirmNativeMinute,
    private readonly persist: PersistCanonicalMinute,
    private readonly options: FuturesFinalBarOptions = {},
  ) {}

  private validNative(native: Candle, provisional: Candle): boolean {
    const prices = [native.open, native.high, native.low, native.close];
    return native.symbol === "ES" && native.conid === provisional.conid &&
      native.timeframe === "1m" && native.ts.getTime() === provisional.ts.getTime() &&
      native.ts.getTime() % 60_000 === 0 &&
      prices.every((price) => Number.isFinite(price) && Number.isInteger(price * 4)) &&
      native.low <= native.high && native.open >= native.low && native.open <= native.high &&
      native.close >= native.low && native.close <= native.high &&
      Number.isSafeInteger(native.volume) && native.volume >= 0 &&
      (this.options.isOpenMinute?.(native.ts) ?? true);
  }

  route(
    provisional: Candle,
    subscription: InstrumentSubscription | undefined,
  ): Promise<boolean> {
    if (!isFuturesSubscription(subscription))
      return this.persist(provisional).then(() => true);
    if (!subscription || subscription.symbol !== "ES") return Promise.resolve(false);
    const key = `${provisional.conid}:${provisional.ts.toISOString()}`;
    if (this.finalized.has(key)) return Promise.resolve(false);
    const running = this.inFlight.get(key);
    if (running) return running;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const work = (async () => {
      await sleep(this.options.settlementDelayMs ?? 2_000);
      const attempts = Math.max(1, this.options.maxAttempts ?? 3);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const native = await this.confirm(subscription, provisional.ts);
          if (native && this.validNative(native, provisional) && !this.finalized.has(key)) {
            await this.persist(native);
            this.finalized.add(key);
            return true;
          }
        } catch (error) {
          if (this.options.isTerminalError?.(error) ?? false) return false;
        }
        if (attempt < attempts) await sleep(this.options.retryDelayMs ?? 2_000);
      }
      return false;
    })()
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }
}
