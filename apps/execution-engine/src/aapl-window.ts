import type { PoolClient, Pool } from 'pg';

export interface AaplWindow { runId: string; accountId: string; startsAt: string; endsAt: string; tradeDate: string }
export function isAaplIdentity(order: { instrumentId?: string | null; instrument?: string; conid?: string | null }): boolean {
  return order.instrumentId === 'aapl_nasdaq' || order.conid === '265598' || order.instrument?.toUpperCase() === 'AAPL';
}
export function isExactAaplIdentity(order: { instrumentId?: string | null; instrument?: string; conid?: string | null }): boolean {
  return order.instrumentId === 'aapl_nasdaq' && order.conid === '265598' && order.instrument === 'AAPL';
}
export function parseAaplWindow(env: Record<string, unknown>): AaplWindow | undefined {
  const keys = ['AAPL_RUN_ID','AAPL_RUN_ACCOUNT','AAPL_RUN_START','AAPL_RUN_END'] as const;
  if (keys.every(k => env[k] === undefined || env[k] === '')) return undefined;
  if (keys.some(k => typeof env[k] !== 'string' || !(env[k] as string).trim())) throw new Error('AAPL window requires all four AAPL_RUN fields');
  const [runId,accountId,start,end] = keys.map(k => (env[k] as string).trim());
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(accountId)) throw new Error('Invalid AAPL run identity');
  const explicit = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
  const a=Date.parse(start),b=Date.parse(end);
  const calendarValid=(value:string)=>{const day=value.slice(0,10);const ms=Date.parse(day+"T00:00:00Z");return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===day;};
  if (!explicit.test(start)||!explicit.test(end)||!calendarValid(start)||!calendarValid(end)||!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b-a>3600000) throw new Error('Invalid AAPL window timestamps or duration');
  const parts=(ms:number)=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(ms).map(x=>[x.type,x.value]));
  const x=parts(a),y=parts(b);const date=(p:Record<string,string>)=>`${p.year}-${p.month}-${p.day}`;
  const seconds=(p:Record<string,string>)=>Number(p.hour)*3600+Number(p.minute)*60+Number(p.second);
  if(date(x)!==date(y)||['Sat','Sun'].includes(x.weekday)||seconds(x)<34500||seconds(y)+(b%1000)/1000>56700) throw new Error('AAPL window must fit one New York weekday 09:35–15:45');
  return Object.freeze({runId,accountId,startsAt:new Date(a).toISOString(),endsAt:new Date(b).toISOString(),tradeDate:date(x)});
}

type Db = Pick<PoolClient | Pool,'query'>;
export async function checkAaplWindow(db: Db, config: AaplWindow | undefined, accountId: string,
  proposalId?: number, dispatch=false): Promise<{ok:true;endsAtMs:number}|{ok:false;reason:string}> {
  const deny=(reason:string)=>({ok:false as const,reason:`aapl_window_${reason}`});
  if (!config) return deny('unconfigured');
  if(config.accountId!==accountId) return deny('account_mismatch');
  const result=await db.query(`SELECT clock_timestamp() AS now, w.* FROM (SELECT 1) anchor
    LEFT JOIN aapl_windows w ON w.run_id=$1`,[config.runId]);
  const row=result.rows[0];const now=new Date(row.now).getTime();
  if(now<Date.parse(config.startsAt)||now>=Date.parse(config.endsAt)) return deny('outside_window');
  if(row.run_id && (row.account_id!==accountId||new Date(row.starts_at).toISOString()!==config.startsAt||new Date(row.ends_at).toISOString()!==config.endsAt)) return deny('configuration_changed');
  if(proposalId!==undefined) {
    const binding=await db.query('SELECT run_id FROM aapl_proposals WHERE proposed_order_id=$1',[proposalId]);
    if(binding.rows[0]?.run_id!==config.runId) return deny('proposal_run_mismatch');
  }
  const consumed=await db.query(`SELECT run_id,consumed_proposal_id FROM aapl_windows
    WHERE account_id=$1 AND trade_date=$2 AND consumed_proposal_id IS NOT NULL`,[accountId,config.tradeDate]);
  if(dispatch) {
    if(consumed.rows.length!==1||consumed.rows[0].run_id!==config.runId||Number(consumed.rows[0].consumed_proposal_id)!==proposalId) return deny('claim_missing');
  } else if(consumed.rows.length) return deny('consumed');
  return {ok:true,endsAtMs:Date.parse(config.endsAt)};
}
export async function bindAaplProposal(client:PoolClient,config:AaplWindow,proposalId:number):Promise<void> {
  await client.query(`INSERT INTO aapl_windows(run_id,account_id,trade_date,starts_at,ends_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id) DO NOTHING`,[config.runId,config.accountId,config.tradeDate,config.startsAt,config.endsAt]);
  await client.query('INSERT INTO aapl_proposals(proposed_order_id,run_id) VALUES($1,$2)',[proposalId,config.runId]);
}
