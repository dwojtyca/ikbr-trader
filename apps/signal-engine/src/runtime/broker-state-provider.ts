import type { MarketContextProvider, ProviderLoadInput, SectionLoadResult } from '@ikbr/shared';
import type { ReadyProbe } from './execution/paper-guard.js';
import type { TradingExposureReader } from './trading-loop/types.js';

export class BrokerStateContextProvider implements MarketContextProvider<'brokerState'> {
  readonly id = 'execution-engine:ready-and-exposure';
  readonly section = 'brokerState' as const;
  readonly freshnessTtlMs = 5_000;
  readonly timeoutMs = 5_000;
  constructor(private readonly options: { probe: ReadyProbe; exposure: Pick<TradingExposureReader, "readExposure">; now?: () => Date }) {}
  supports(): boolean { return true; }
  async load(input: ProviderLoadInput): Promise<SectionLoadResult<'brokerState'>> {
    const observedAt = (this.options.now ?? (() => new Date()))();
    const ready = await this.options.probe.probeReady();
    if (ready.kind !== 'ok' || !ready.ready || ready.environment !== 'paper' || !ready.accountMatchesEnvironment || ready.tradingEnabled !== true)
      throw new Error('BROKER_STATE_NOT_READY');
    const exposure = await this.options.exposure.readExposure({instrumentId:input.instrument.id,brokerSymbol:input.instrument.brokerSymbol});
    if (exposure.hasOpenPosition || exposure.hasActiveOrder || exposure.hasPendingProposal || exposure.hasAmbiguousSubmission ||
        (exposure.quantity !== undefined && exposure.quantity !== 0)) throw new Error('BROKER_EXPOSURE_BLOCKED');
    return {observedAt,source:this.id,data:{accountEnvironment:ready.environment,openOrders:[]}};
  }
}
