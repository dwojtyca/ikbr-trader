import type { LifecycleEvidence, LifecycleOwnershipReport } from './ownership.js';
export function protectionFailure(evidence: LifecycleEvidence, facts: LifecycleOwnershipReport): string | null {
  if (facts.status !== 'OWNED_POSITION' && facts.status !== 'PENDING_ENTRY') return 'protection_ownership_unavailable';
  const snapshot = evidence.run?.broker_snapshot as { openOrders?: Array<Record<string, unknown>> } | undefined;
  if (!Array.isArray(snapshot?.openOrders)) return 'protection_snapshot_unavailable';
  const parent = evidence.links.find(link => link.role === 'PARENT');
  let group: string | null = null;
  for (const role of ['TP', 'SL']) {
    const link = evidence.links.find(l => l.role === role);
    const rows = snapshot.openOrders.filter(r => r.accountId === evidence.order.executionAccountId && r.conId === evidence.order.conid && r.brokerOrderId === link?.broker_order_id && r.orderRef === link?.order_ref);
    if (rows.length !== 1) return 'protection_missing';
    const row = rows[0]!;
    if (row.orderType !== (role === 'TP' ? 'LMT' : 'STP') || row.action !== 'SELL' || row.totalQuantity !== 1 || row.remaining !== 1 || row.filled !== 0 ||
      row.parentId !== parent?.broker_order_id || row.ocaType !== 2 || typeof row.ocaGroup !== 'string' || !row.ocaGroup.trim() || row.tif !== 'DAY' ||
      (role === 'TP' ? row.limitPrice !== evidence.order.takeProfit : row.stopPrice !== evidence.order.stop) || (group !== null && group !== row.ocaGroup)) return 'protection_shape_invalid';
    group = row.ocaGroup;
  }
  return null;
}

export function activeStockEvidenceFailure(evidence: import('./round-trip-evidence.js').RoundTripEvidence, currency: string): string | null {
  const lifecycle=evidence.lifecycle;
  const snapshot=lifecycle.run?.broker_snapshot as {openOrders?:Array<Record<string,unknown>>;executions?:Array<Record<string,unknown>>}|null;
  if(!Array.isArray(snapshot?.openOrders)||!Array.isArray(snapshot?.executions))return 'stock_evidence_unavailable';
  const owned=(row:Record<string,unknown>)=>row.accountId===lifecycle.order.executionAccountId&&row.conId===lifecycle.order.conid;
  const executions=snapshot.executions.filter(owned),orders=snapshot.openOrders.filter(owned);
  if([...executions,...orders].some(row=>row.secType!=='STK'||row.currency!==currency))return 'stock_broker_type_or_currency_mismatch';
  const unique=new Map<unknown,Record<string,unknown>>();
  for(const row of executions){
    if(typeof row.execId!=='string'||!row.execId)return 'stock_execution_identity_missing';
    const prior=unique.get(row.execId);
    if(prior&&['brokerOrderId','orderRef','permId','side','shares','price','executedAt'].some(key=>prior[key]!==row[key]))return 'stock_conflicting_execution';
    unique.set(row.execId,row);
  }
  if(evidence.fills.length!==unique.size||new Set(evidence.fills.map(fill=>fill.exec_id)).size!==evidence.fills.length)return 'stock_local_fills_incomplete';
  for(const fill of evidence.fills){
    const broker=unique.get(fill.exec_id);
    const link=[...lifecycle.links,...(evidence.close?.links??[])].find(row=>row.broker_order_id===fill.broker_order_id);
    if(!broker||!link||(fill.proposed_order_id!==null&&fill.proposed_order_id!==link.proposed_order_id)||fill.sec_type!=='STK'||fill.sec_type_conflict===true||fill.currency!==currency||fill.account_id!==lifecycle.order.executionAccountId||fill.conid!==lifecycle.order.conid||
      fill.broker_order_id!==broker.brokerOrderId||fill.shares!==broker.shares||fill.price!==broker.price||!Number.isFinite(fill.shares)||!Number.isFinite(fill.price)||
      new Date(fill.executed_at!).getTime()!==new Date(String(broker.executedAt)).getTime()||
      (['BUY','BOT'].includes(fill.side)?'BUY':['SELL','SLD'].includes(fill.side)?'SELL':null)!==(['BUY','BOT'].includes(String(broker.side))?'BUY':['SELL','SLD'].includes(String(broker.side))?'SELL':null))return 'stock_local_fill_identity_mismatch';
  }
  return null;
}
