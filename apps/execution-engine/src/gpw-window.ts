import type { PoolClient, Pool } from 'pg';

export interface GpwWindow { runId: string; accountId: string; startsAt: string; endsAt: string; tradeDate: string }
export function isPkoIdentity(order: { instrumentId?: string | null; instrument?: string; conid?: string | null }): boolean {
  return order.instrumentId === 'pko_wse' || order.conid === '35146360' || order.instrument?.toUpperCase() === 'PKO';
}
export function parseGpwWindow(env: Record<string, unknown>): GpwWindow | undefined {
  const keys = ['GPW_RUN_ID','GPW_RUN_ACCOUNT','GPW_RUN_START','GPW_RUN_END'] as const;
  if (keys.every(k => env[k] === undefined || env[k] === '')) return undefined;
  if (keys.some(k => typeof env[k] !== 'string' || !(env[k] as string).trim())) throw new Error('GPW window requires all four GPW_RUN fields');
  const [runId,accountId,start,end] = keys.map(k => (env[k] as string).trim());
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(accountId)) throw new Error('Invalid GPW run identity');
  const explicit = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
  const a=Date.parse(start),b=Date.parse(end);
  const calendarValid=(value:string)=>{const day=value.slice(0,10);const ms=Date.parse(day+"T00:00:00Z");return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===day;};
  if (!explicit.test(start)||!explicit.test(end)||!calendarValid(start)||!calendarValid(end)||!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b-a>3600000) throw new Error('Invalid GPW window timestamps or duration');
  const parts=(ms:number)=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(ms).map(x=>[x.type,x.value]));
  const x=parts(a),y=parts(b);const date=(p:Record<string,string>)=>`${p.year}-${p.month}-${p.day}`;
  const seconds=(p:Record<string,string>)=>Number(p.hour)*3600+Number(p.minute)*60+Number(p.second);
  if(date(x)!==date(y)||['Sat','Sun'].includes(x.weekday)||seconds(x)<32700||seconds(y)+(b%1000)/1000>60300) throw new Error('GPW window must fit one Warsaw weekday 09:05–16:45');
  return Object.freeze({runId,accountId,startsAt:new Date(a).toISOString(),endsAt:new Date(b).toISOString(),tradeDate:date(x)});
}

type Db = Pick<PoolClient | Pool,'query'>;
export async function checkGpwWindow(db: Db, config: GpwWindow | undefined, accountId: string,
  proposalId?: number, dispatch=false): Promise<{ok:true;endsAtMs:number}|{ok:false;reason:string}> {
  const deny=(reason:string)=>({ok:false as const,reason:`gpw_window_${reason}`});
  if (!config) return deny('unconfigured');
  if(config.accountId!==accountId) return deny('account_mismatch');
  const result=await db.query(`SELECT clock_timestamp() AS now, w.* FROM (SELECT 1) anchor
    LEFT JOIN gpw_windows w ON w.run_id=$1`,[config.runId]);
  const row=result.rows[0];const now=new Date(row.now).getTime();
  if(now<Date.parse(config.startsAt)||now>=Date.parse(config.endsAt)) return deny('outside_window');
  if(row.run_id && (row.account_id!==accountId||new Date(row.starts_at).toISOString()!==config.startsAt||new Date(row.ends_at).toISOString()!==config.endsAt)) return deny('configuration_changed');
  if(proposalId!==undefined) {
    const binding=await db.query('SELECT run_id FROM gpw_proposals WHERE proposed_order_id=$1',[proposalId]);
    if(binding.rows[0]?.run_id!==config.runId) return deny('proposal_run_mismatch');
  }
  const consumed=await db.query(`SELECT run_id,consumed_proposal_id FROM gpw_windows
    WHERE account_id=$1 AND trade_date=$2 AND consumed_proposal_id IS NOT NULL`,[accountId,config.tradeDate]);
  if(dispatch) {
    if(consumed.rows.length!==1||consumed.rows[0].run_id!==config.runId||Number(consumed.rows[0].consumed_proposal_id)!==proposalId) return deny('claim_missing');
  } else if(consumed.rows.length) return deny('consumed');
  return {ok:true,endsAtMs:Date.parse(config.endsAt)};
}
export async function bindGpwProposal(client:PoolClient,config:GpwWindow,proposalId:number):Promise<void> {
  await client.query(`INSERT INTO gpw_windows(run_id,account_id,trade_date,starts_at,ends_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id) DO NOTHING`,[config.runId,config.accountId,config.tradeDate,config.startsAt,config.endsAt]);
  await client.query('INSERT INTO gpw_proposals(proposed_order_id,run_id) VALUES($1,$2)',[proposalId,config.runId]);
}
