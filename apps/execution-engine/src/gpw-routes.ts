import type { FastifyInstance } from 'fastify';
import type { BoundInstrument } from '@ikbr/shared';
import { isWseBound, type WseMarketMetadata } from './wse-market-rules.js';

export function registerGpwRoutes(app:FastifyInstance,deps:{
  currentAccountId():string|null;
  boundInstrument(id:string):BoundInstrument|null|undefined;
  assertAccountAllowed(accountId:string):void;
  loadMetadata(bound:BoundInstrument,accountId:string):Promise<WseMarketMetadata>;
  windowStatus(accountId:string|null):Promise<unknown>;
}):void {
  app.get('/execution/gpw-window',async()=>deps.windowStatus(deps.currentAccountId()));
  app.get('/execution/instruments/:instrumentId/market-rules',async(request,reply)=>{
    const {instrumentId}=request.params as {instrumentId:string};
    const bound=deps.boundInstrument(instrumentId),accountId=deps.currentAccountId();
    if(!bound||!isWseBound(bound)) return reply.code(404).send({error:'wse_binding_unavailable'});
    if(!accountId) return reply.code(503).send({error:'active_account_unavailable'});
    try {
      deps.assertAccountAllowed(accountId);
      const metadata=await deps.loadMetadata(bound,accountId);
      if(deps.currentAccountId()!==accountId) return reply.code(503).send({error:'account_changed'});
      return {accountId,metadata};
    } catch {return reply.code(503).send({error:'wse_metadata_unavailable'});}
  });
}
