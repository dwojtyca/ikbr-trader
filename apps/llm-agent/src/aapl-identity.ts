import type { Pool } from 'pg';
import { buildConfiguredInstrumentRegistry, buildInstrumentBindingAuthority, isAaplBound, tickSizesEqual, type InstrumentBindingAuthority } from '@ikbr/shared';
import type { BoundClaim } from './bound-review-repository.js';

export interface VerifiedAaplIdentity {
  instrumentId: 'aapl_nasdaq'; symbol: 'AAPL'; conid: '265598'; secType: 'STK';
  exchange: 'SMART'; primaryExchange: 'NASDAQ'; currency: 'USD'; localSymbol: 'AAPL'; tradingClass: 'NMS';
  source: 'ibkr'; resolvedAt: string; bindingVerified: true;
}
export type AaplIdentityResult = { ok: true; evidence: VerifiedAaplIdentity } | { ok: false; reason: string };
export type AaplIdentityResolver = (claim: BoundClaim) => Promise<AaplIdentityResult>;
export function needsAaplIdentity(claim: BoundClaim): boolean {
  const snapshot = claim.proposalSnapshot;
  return [claim.identity.instrumentId, claim.order.instrumentId, snapshot?.instrument_id].some(x => typeof x === 'string' && x.trim().toLowerCase() === 'aapl_nasdaq') ||
    [claim.identity.conid, claim.order.conid, snapshot?.conid].some(x => Number(x) === 265598) ||
    [claim.order.instrument, snapshot?.instrument].some(x => typeof x === 'string' && x.trim().toUpperCase() === 'AAPL');
}
export function exactAaplClaim(claim: BoundClaim): boolean {
  if (claim.identity.instrumentId !== 'aapl_nasdaq' || claim.identity.conid !== '265598' ||
      claim.order.instrumentId !== 'aapl_nasdaq' || claim.order.instrument !== 'AAPL' || claim.order.conid !== '265598') return false;
  const row = claim.proposalSnapshot;
  return !row || (row.instrument_id === 'aapl_nasdaq' && row.instrument === 'AAPL' && row.conid === '265598' &&
    Number(row.id) === claim.order.id && row.client_order_hash === claim.identity.clientOrderHash);
}
export function createAaplIdentityResolver(input: { pool: Pick<Pool, 'query'>; env: Record<string, unknown>; now?: () => number }): AaplIdentityResolver {
  let authority: InstrumentBindingAuthority | undefined;
  try {
    const built = buildInstrumentBindingAuthority(input.env.INSTRUMENT_BINDINGS_JSON ?? '', buildConfiguredInstrumentRegistry(input.env));
    if (built.ok) authority = built.authority;
  } catch { /* Configuration failure is a durable rejected review, never a fallback. */ }
  return async claim => {
    const reject = (reason: string): AaplIdentityResult => ({ ok: false, reason });
    if (!exactAaplClaim(claim)) return reject('AAPL_IDENTITY_CLAIM_MISMATCH');
    if (!authority) return reject('AAPL_IDENTITY_CONFIG_INVALID');
    const bound = authority.getBoundInstrument('aapl_nasdaq');
    if (!bound || !isAaplBound(bound) || bound.localSymbol !== 'AAPL' || bound.tradingClass !== 'NMS' || !bound.instrument.trading.aiAnalysisEnabled) return reject('AAPL_IDENTITY_BINDING_UNAVAILABLE');
    let row: Record<string, unknown> | undefined;
    try {
      const result = await input.pool.query('SELECT symbol,conid,sec_type,exchange,primary_exchange,currency,local_symbol,trading_class,min_tick,source,resolved_at FROM instrument_contracts WHERE conid=$1', ['265598']);
      if (result.rows.length !== 1) return reject('AAPL_IDENTITY_METADATA_MISSING');
      row = result.rows[0];
    } catch { return reject('AAPL_IDENTITY_LOOKUP_FAILED'); }
    if (!row || row.symbol !== 'AAPL' || row.conid !== '265598' || row.sec_type !== 'STK' || row.exchange !== 'SMART' || row.primary_exchange !== 'NASDAQ' || row.currency !== 'USD' || row.local_symbol !== bound.localSymbol || row.trading_class !== bound.tradingClass || typeof row.min_tick !== 'number' || !tickSizesEqual(row.min_tick, bound.minTick)) return reject('AAPL_IDENTITY_METADATA_MISMATCH');
    if (row.source !== 'ibkr') return reject('AAPL_IDENTITY_PROVENANCE_INVALID');
    const resolvedAt = row.resolved_at instanceof Date ? row.resolved_at.getTime() : typeof row.resolved_at === 'string' ? Date.parse(row.resolved_at) : NaN;
    const now = (input.now ?? Date.now)();
    if (!Number.isFinite(resolvedAt) || !Number.isFinite(now) || resolvedAt > now) return reject('AAPL_IDENTITY_TIMESTAMP_INVALID');
    return { ok: true, evidence: { instrumentId: 'aapl_nasdaq', symbol: 'AAPL', conid: '265598', secType: 'STK', exchange: 'SMART', primaryExchange: 'NASDAQ', currency: 'USD', localSymbol: 'AAPL', tradingClass: 'NMS', source: 'ibkr', resolvedAt: new Date(resolvedAt).toISOString(), bindingVerified: true } };
  };
}
