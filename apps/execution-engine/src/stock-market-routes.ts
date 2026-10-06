import type { FastifyInstance } from 'fastify';
import { getSupportedStockCapability, type BoundInstrument, type StockMarketMetadata } from '@ikbr/shared';

export function registerStockMarketRoutes(app: FastifyInstance, deps: {
  currentAccountId(): string | null;
  boundInstrument(id: string): BoundInstrument | null | undefined;
  assertAccountAllowed(accountId: string): void;
  loadMetadata(bound: BoundInstrument, accountId: string): Promise<StockMarketMetadata>;
}): void {
  app.get('/execution/instruments/:instrumentId/stock-market-rules', async (request, reply) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const bound = deps.boundInstrument(instrumentId), accountId = deps.currentAccountId();
    if (!bound || !getSupportedStockCapability(bound)) return reply.code(404).send({error: 'stock_binding_unavailable'});
    if (!accountId) return reply.code(503).send({error: 'active_account_unavailable'});
    try {
      deps.assertAccountAllowed(accountId);
      const metadata = await deps.loadMetadata(bound, accountId);
      if (deps.currentAccountId() !== accountId) return reply.code(503).send({error: 'account_changed'});
      return {accountId, metadata};
    } catch { return reply.code(503).send({error: 'stock_metadata_unavailable'}); }
  });
}
