import type { Instrument } from "@ikbr/shared";

export function legacyProducerOwnsSymbol(instruments: readonly Instrument[], symbol: string): boolean {
  return !instruments.some((instrument) => instrument.trading.executionEnabled &&
    instrument.brokerSymbol.toUpperCase() === symbol.toUpperCase());
}
