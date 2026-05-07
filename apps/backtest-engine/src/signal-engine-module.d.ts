declare module '@ikbr/signal-engine/signal-engine' {
  import type { ProposedOrder } from '@ikbr/shared';

  export class SignalEngine {
    constructor(repo: any, options: any);
    runForSymbol(symbol: string, exposureSnapshot?: any, generatedFromCandleTs?: Date): Promise<ProposedOrder>;
  }
}
