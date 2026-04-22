export interface TickEvent {
  conid: string;
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  size?: number;
  ts: Date;
}

export interface WatchlistInstrument {
  symbol: string;
  conid?: string;
  secType?: string;
  exchange?: string;
  primaryExchange?: string;
  currency?: string;
}

export interface InstrumentSubscription {
  symbol: string;
  conid: string;
  contract?: Record<string, unknown>;
  displayName?: string;
}
