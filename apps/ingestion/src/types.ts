import type { InstrumentContract } from '@ikbr/shared';

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
  /**
   * PR15.2 — authoritative disambiguators forwarded to the
   * `reqContractDetails` request for bound instruments so IBKR
   * returns exactly the operator-selected contract. Not used by
   * the legacy stock watchlist.
   */
  localSymbol?: string;
  tradingClass?: string;
  /**
   * PR15.2 — logical registry id (present only for bound
   * instruments). Ingestion tags the resolved subscription with
   * this id so the `/watchlist` endpoint can surface bound
   * identity read-only.
   */
  instrumentId?: string;
}

export interface InstrumentSubscription {
  symbol: string;
  conid: string;
  contract?: Record<string, unknown>;
  displayName?: string;
  instrumentContract?: InstrumentContract;
  /**
   * PR15.2 — logical registry id populated by the binding
   * verification pass for bound subscriptions. Absent for the
   * legacy stock watchlist.
   */
  instrumentId?: string;
}
