import type { Pool } from 'pg';
import type { InstrumentSessionIdentity } from '@ikbr/shared';
import type { DiagnosticCoverage, DiagnosticEvent, DiagnosticField, DiagnosticQuery, DiagnosticReport, DiagnosticSection } from '@ikbr/shared/diagnostics';
import { projectDiagnosticEvent, type StoredDiagnosticRow } from './source-projections.js';
import type { RoundTripReport } from '../lifecycle/round-trip-evidence.js';
import { appendDiagnosticStatus } from './read-model-status.js';
import { appendDiagnosticTimeline } from './read-model-timeline.js';
import { appendDiagnosticSessionEconomics } from './read-model-session.js';

export interface DiagnosticInstrumentConfig {
  id: string; symbol: string | null; listing: string | null; conId: string | null;
  implementationId: string | null; instanceId: string | null; revision: number | null;
  entryEnabled?: boolean; monitoringEnabled?: boolean;
  instances?: readonly { implementationId: string; instanceId: string; revision: number; enabled?:boolean }[];
  sessionIdentity?: InstrumentSessionIdentity;
}
export interface DiagnosticReadModelDeps {
  pool: Pick<Pool,'query'>;
  currentAccountId(): string | null;
  currentSessionId(): string;
  configuration(): { configHash: string | null; instruments: readonly DiagnosticInstrumentConfig[] };
  runtimeControls?(): { tradingEnabled:boolean; entriesPaused:boolean; automationEnabled:boolean };
  readWatchlist?(): Promise<unknown>;
  roundTrip?(proposalId: number): Promise<RoundTripReport | null>;
}

type Raw = Record<string, unknown>;
const iso = (value: unknown): string | null => value instanceof Date ? value.toISOString() :
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const str = (value: unknown): string | null => typeof value === 'string' ? value : value == null ? null : String(value);
const fld = (key: string, label: string, value: string | number | boolean | null, sensitivity?: DiagnosticField['sensitivity']): DiagnosticField =>
  ({key,label,value,...(sensitivity ? {sensitivity} : {})});
const coverage = (source:string,status:DiagnosticCoverage['status'],reason?:string,observedAt:string|null=null,earliestAvailableAt:string|null=null):DiagnosticCoverage =>
  ({source,status,observedAt,earliestAvailableAt,reasons:reason?[reason]:[]});

function event(row: Raw): DiagnosticEvent {
  const fields:DiagnosticField[]=[];
  if(Array.isArray(row.reasons)) fields.push(fld('reasons','Powody',row.reasons.filter(x=>typeof x==='string').join(', '),'untrusted'));
  if(Array.isArray(row.entry_blockers)) fields.push(fld('entryBlockers','Blokady wejścia',row.entry_blockers.filter(x=>typeof x==='string').join(', '),'untrusted'));
  if(Array.isArray(row.assigned_instances)) fields.push(fld('assignedInstances','Przypisane instancje',
    row.assigned_instances.map(x=>x&&typeof x==='object'?`${(x as Raw).implementationId}/${(x as Raw).instanceId}@${(x as Raw).revision}`:'').join(', '),'untrusted'));
  return projectDiagnosticEvent({...row,fields:[...(Array.isArray(row.fields)?row.fields:[]),...fields]} as unknown as StoredDiagnosticRow);
}
function scoped(query: DiagnosticQuery, column: string, offset: number): {sql:string; values:unknown[]} {
  const where = [`${column} >= $${offset+1}::timestamptz`,`${column} <= $${offset+2}::timestamptz`];
  const values:unknown[]=[query.from,query.to];
  if (query.instrumentId) { where.push(`instrument_id = $${offset+values.length+1}`); values.push(query.instrumentId); }
  return {sql:where.join(' AND '),values};
}
function constrainEvent(where:string[], values:unknown[], query:DiagnosticQuery, reason:string, severity:string):void {
  if(query.reason){where.push(`${reason}=$${values.length+1}`);values.push(query.reason);}
  if(query.severity){where.push(`${severity}=$${values.length+1}`);values.push(query.severity);}
}

export function createDiagnosticReadModel(deps: DiagnosticReadModelDeps) {
  return { read: async (query: DiagnosticQuery): Promise<DiagnosticReport> => {
    const generatedAt = new Date().toISOString();
    const report:DiagnosticReport={schemaVersion:1,mode:query.mode,generatedAt,interval:{from:query.from,to:query.to},
      coverage:[],events:[],sections:[],counters:[],truncated:false,omissions:[]};
    const accountId=deps.currentAccountId();
    if (!accountId) {
      report.coverage.push(coverage('account','UNAVAILABLE','ACCOUNT_ID_UNAVAILABLE'));
      report.omissions.push('ACCOUNT_ID_UNAVAILABLE');
      return report;
    }
    const sessionId=deps.currentSessionId();
    const accountIntegrity=async():Promise<boolean>=>{
      let reason:string|null=null;
      try {
        const result=await deps.pool.query(`WITH own_references AS (
          SELECT id AS proposal_id FROM proposed_orders WHERE execution_account_id=$1
          UNION ALL SELECT proposed_order_id FROM proposal_ai_reviews WHERE account_id=$1
          UNION ALL SELECT proposed_order_id FROM paper_entry_attempts WHERE account_id=$1
          UNION ALL SELECT proposed_order_id FROM broker_execution_fills WHERE account_id=$1
          UNION ALL SELECT proposed_order_id FROM broker_order_links WHERE account_id=$1
          UNION ALL SELECT original_proposal_id FROM lifecycle_close_operations WHERE account_id=$1
          UNION ALL SELECT close_proposal_id FROM lifecycle_close_operations WHERE account_id=$1
          UNION ALL SELECT original_proposal_id FROM lifecycle_supervision WHERE account_id=$1
          UNION ALL SELECT original_proposal_id FROM lifecycle_faults WHERE account_id=$1
          UNION ALL SELECT f.original_proposal_id FROM lifecycle_alert_outbox o
            JOIN lifecycle_faults f ON f.id=o.fault_id WHERE o.account_id=$1
          UNION ALL SELECT proposal_id FROM diagnostic_evaluations WHERE account_id=$1
        ) SELECT EXISTS(SELECT 1 FROM own_references r JOIN proposed_orders p ON p.id=r.proposal_id
          LEFT JOIN proposal_ai_reviews ai ON ai.proposed_order_id=p.id
          WHERE (p.execution_account_id IS NOT NULL AND p.execution_account_id<>$1)
            OR (ai.account_id IS NOT NULL AND ai.account_id<>$1))
          OR EXISTS(SELECT 1 FROM lifecycle_alert_outbox o JOIN lifecycle_faults f ON f.id=o.fault_id
            WHERE o.account_id=$1 AND f.account_id<>o.account_id) AS account_proposal_mismatch`,[accountId]);
        if(result.rows[0]?.account_proposal_mismatch===true)reason='ACCOUNT_PROPOSAL_MISMATCH';
        else if(result.rows[0]?.account_proposal_mismatch!==false)reason='ACCOUNT_IDENTITY_CHECK_UNAVAILABLE';
      }catch{reason='ACCOUNT_IDENTITY_CHECK_UNAVAILABLE';}
      if(!reason)return true;
      report.interval={from:query.from,to:query.to};report.events=[];report.counters=[];report.truncated=false;
      report.coverage=[coverage('account_correlation','UNAVAILABLE',reason)];report.omissions=[reason];
      report.sections=[{id:'account-correlation-unavailable',title:'Nie można bezpiecznie odczytać historii konta',instrumentId:null,fields:[
        fld('reason','Powód',reason==='ACCOUNT_PROPOSAL_MISMATCH'
          ?'Zapisane powiązanie wskazuje propozycję innego konta.':'Nie udało się sprawdzić zgodności zapisanych powiązań konta.'),
        fld('impact','Wpływ','Diagnostyka konta pozostaje niedostępna; brak wyniku nie oznacza zera ani poprawnego stanu.'),
        fld('action','Reakcja','Sprawdź obsługiwane uzgodnienie PP5. Nie usuwaj dowodów ani nie ponawiaj nieznanych zleceń.')] }];
      return false;
    };
    if(!await accountIntegrity())return report;
    const exactTrace=query.mode==='timeline'&&Boolean(query.proposalId||query.evaluationId);
    const config=deps.configuration();
    const configured = query.instrumentId ? config.instruments.filter(i=>i.id===query.instrumentId) : config.instruments;
    const allEvents:DiagnosticEvent[]=[];
    const bound=query.limit+1;
    const collect=async(source:string,sql:string,values:unknown[],rowLimit=query.limit):Promise<Raw[]>=>{
      try {
        const result=await deps.pool.query(sql,values);
        const rows=result.rows as Raw[];
        const capped=rows.length>rowLimit;
        if(capped){report.truncated=true;report.omissions.push(`${source}:ROW_LIMIT`);}
        report.coverage.push(coverage(source,capped?'PARTIAL':'COMPLETE',capped?'ROW_LIMIT':undefined,generatedAt,
          capped?null:rows.length?iso(rows[rows.length-1].occurred_at):null));
        return rows.slice(0,rowLimit);
      }catch{
        report.coverage.push(coverage(source,'UNAVAILABLE','SOURCE_READ_FAILED'));
        report.omissions.push(`${source}:SOURCE_READ_FAILED`);
        return [];
      }
    };
    const links=query.mode==='timeline'&&query.evaluationId?await collect('evaluation_links',`
      SELECT DISTINCT proposal_id::text AS proposal_id FROM diagnostic_evaluations WHERE account_id=$1
      AND (cycle_id::text=$2 OR evaluation_id=$2) AND proposal_id IS NOT NULL
      ${query.instrumentId?'AND instrument_id=$3':''} LIMIT 2`,
      [accountId,query.evaluationId,...(query.instrumentId?[query.instrumentId]:[])],2):[];
    const traceProposalId=query.proposalId??(links.length===1?str(links[0].proposal_id):null);
    if(query.mode==='timeline'&&query.evaluationId&&!traceProposalId) {
      report.coverage.push(coverage('proposal_link','PARTIAL',links.length>1?'AMBIGUOUS_PROPOSAL_LINK':'NO_LINKED_PROPOSAL'));
      report.omissions.push('timeline:PROPOSAL_CHAIN_UNAVAILABLE');
    }
    const evalFilter=scoped(query,'occurred_at',1);
    const evalConditions=[`account_id=$1`,...(exactTrace?['$2::timestamptz IS NOT NULL','$3::timestamptz IS NOT NULL']:[evalFilter.sql])];
    const evalValues:unknown[]=[accountId,...evalFilter.values];
    if(exactTrace&&query.instrumentId)evalConditions.push('instrument_id=$4');
    if(query.evaluationId){evalConditions.push(`(evaluation_id=$${evalValues.length+1} OR cycle_id::text=$${evalValues.length+1})`);evalValues.push(query.evaluationId);}
    if(traceProposalId){evalConditions.push(`proposal_id=$${evalValues.length+1}::bigint`);evalValues.push(traceProposalId);}
    constrainEvent(evalConditions,evalValues,query,'reason',
      "CASE WHEN outcome IN ('ERROR','UNKNOWN') OR evaluation_kind='error' THEN 'CRITICAL' WHEN outcome='SKIPPED' THEN 'WARN' ELSE 'INFO' END");
    const evals=await collect('diagnostic_evaluations',`SELECT 'diagnostic_evaluations' AS source,id::text,occurred_at,recorded_at,
      outcome AS code,reason,reasons,entry_blockers,assigned_instances,
      CASE WHEN outcome IN ('ERROR','UNKNOWN') OR evaluation_kind='error' THEN 'CRITICAL' WHEN outcome='SKIPPED' THEN 'WARN' ELSE 'INFO' END AS severity,
      instrument_id,conid,symbol,listing,implementation_id,instance_id,revision,config_hash,
      COALESCE(evaluation_id,cycle_id::text) AS evaluation_id,cycle_id::text AS trace_id,
      proposal_id::text, ('/execution/diagnostics?mode=timeline&evaluationId='||cycle_id::text) AS audit_ref
      FROM diagnostic_evaluations WHERE ${evalConditions.join(' AND ')}
      ORDER BY occurred_at DESC,id DESC LIMIT ${bound}`, evalValues);
    allEvents.push(...evals.map(row=>{
      const projected=event(row),middle=Date.parse(projected.occurredAt);
      return {...projected,auditRef:`/execution/diagnostics?mode=timeline&evaluationId=${encodeURIComponent(projected.evaluationId??'')}`+
        `&from=${encodeURIComponent(new Date(middle-300000).toISOString())}`+
        `&to=${encodeURIComponent(new Date(Math.min(middle+300000,Date.parse(generatedAt))).toISOString())}`};
    }));

    const currentProposal=query.mode==='status'||query.mode==='timeline';
    const liveSnapshot=!currentProposal||exactTrace||Date.parse(query.to)>=Date.parse(generatedAt)-10000;
    const pWhere=['(p.execution_account_id=$1 OR a.account_id=$1 OR ai.account_id=$1)',
      '(p.execution_account_id IS NULL OR p.execution_account_id=$1)',
      '(a.account_id IS NULL OR a.account_id=$1)', '(ai.account_id IS NULL OR ai.account_id=$1)',
      ...(exactTrace?['$2::timestamptz IS NOT NULL','$3::timestamptz IS NOT NULL']:[currentProposal?"p.created_at >= $2::timestamptz - interval '31 days'":'p.created_at >= $2::timestamptz','p.created_at <= $3::timestamptz'])];
    const pValues:unknown[]=[accountId,query.from,exactTrace?generatedAt:query.to];
    if(query.instrumentId){pWhere.push(`p.instrument_id=$${pValues.length+1}`);pValues.push(query.instrumentId);}
    if(traceProposalId){pWhere.push(`p.id=$${pValues.length+1}::bigint`);pValues.push(traceProposalId);}
    if(query.evaluationId){pWhere.push(`p.id IN (SELECT proposal_id FROM diagnostic_evaluations WHERE account_id=$1 AND (cycle_id::text=$${pValues.length+1} OR evaluation_id=$${pValues.length+1}))`);pValues.push(query.evaluationId);}
    const proposalSeverity=currentProposal?"CASE WHEN p.status IN ('UNKNOWN','SUBMISSION_UNKNOWN') THEN 'CRITICAL' WHEN p.status IN ('REJECTED','CANCELLED') THEN 'WARN' ELSE 'INFO' END":"'INFO'";
    constrainEvent(pWhere,pValues,query,currentProposal?'p.status':"'PROPOSAL_RECORDED'",proposalSeverity);
    const proposals=liveSnapshot?await collect('proposed_orders',`SELECT 'proposed_orders' AS source,
      (p.id::text||':'||${currentProposal?'p.status':"'created'"}) AS id,
      ${currentProposal?'$3::timestamptz':'p.created_at'} AS occurred_at,${currentProposal?'$3::timestamptz':'p.created_at'} AS recorded_at,
      '${currentProposal?'CURRENT_PROPOSAL_SNAPSHOT':'PROPOSAL_RECORDED'}' AS code,
      ${currentProposal?'p.status':"'PROPOSAL_RECORDED'"} AS reason,${proposalSeverity} AS severity,
      p.instrument_id,p.conid,p.instrument AS symbol,
      p.strategy_attribution->>'implementationId' AS implementation_id,
      p.strategy_attribution->>'instanceId' AS instance_id,
      CASE WHEN (p.strategy_attribution->>'instanceRevision') ~ '^[0-9]+$' THEN (p.strategy_attribution->>'instanceRevision')::int END AS revision,
      p.strategy_configuration_hash AS config_hash,p.id::text AS proposal_id,p.broker_order_id,
      rb.snapshot_id::text AS research_snapshot_id,('/execution/orders/'||p.id::text||'/research') AS audit_ref
      FROM proposed_orders p LEFT JOIN paper_entry_attempts a ON a.proposed_order_id=p.id
      LEFT JOIN proposal_ai_reviews ai ON ai.proposed_order_id=p.id
      LEFT JOIN research_bindings rb ON rb.proposed_order_id=p.id
      WHERE ${pWhere.join(' AND ')} ORDER BY p.created_at DESC,p.id DESC LIMIT ${bound}`,pValues):[];
    allEvents.push(...proposals.map(row=>event({...row,fields:[fld('snapshot','Rodzaj zapisu',currentProposal?'CURRENT_STATUS_ONLY':'CREATION_RECORD_ONLY')]})));
    report.coverage.push(coverage('proposal_transitions',currentProposal&&liveSnapshot?'PARTIAL':'UNAVAILABLE',
      currentProposal&&liveSnapshot?'MUTABLE_SNAPSHOT_ONLY':'HISTORICAL_STATUS_TRANSITIONS_UNAVAILABLE'));
    const aiAt=`CASE WHEN ai.status='PENDING' THEN p.created_at ELSE COALESCE(ai.decided_at,ai.expires_at) END`;
    const aiWhere=['ai.account_id=$1','(p.execution_account_id IS NULL OR p.execution_account_id=$1)',
      ...(exactTrace?['$2::timestamptz IS NOT NULL','$3::timestamptz IS NOT NULL']:[`${aiAt} >= $2::timestamptz`,`${aiAt} <= $3::timestamptz`])];
    const aiValues:unknown[]=[accountId,query.from,query.to];
    if(query.instrumentId){aiWhere.push(`ai.instrument_id=$${aiValues.length+1}`);aiValues.push(query.instrumentId);}
    if(traceProposalId){aiWhere.push(`ai.proposed_order_id=$${aiValues.length+1}::bigint`);aiValues.push(traceProposalId);}
    if(query.evaluationId){aiWhere.push(`ai.proposed_order_id IN (SELECT proposal_id FROM diagnostic_evaluations WHERE account_id=$1 AND (cycle_id::text=$${aiValues.length+1} OR evaluation_id=$${aiValues.length+1}))`);aiValues.push(query.evaluationId);}
    constrainEvent(aiWhere,aiValues,query,'ai.status',"CASE WHEN ai.status IN ('REJECTED','EXPIRED') THEN 'WARN' ELSE 'INFO' END");
    const decisions=await collect('proposal_ai_reviews',`SELECT 'proposal_ai_reviews' AS source,ai.proposed_order_id::text AS id,
      ${aiAt} AS occurred_at,${aiAt} AS recorded_at,
      CASE ai.status WHEN 'APPROVED' THEN 'AI_EXECUTE' WHEN 'REJECTED' THEN 'AI_REJECT'
        WHEN 'EXPIRED' THEN 'AI_EXPIRED' ELSE 'AI_PENDING' END AS code,
      ai.status AS reason,CASE WHEN ai.status IN ('REJECTED','EXPIRED') THEN 'WARN' ELSE 'INFO' END AS severity,
      ai.instrument_id,ai.conid,p.strategy_attribution->>'implementationId' AS implementation_id,
      p.strategy_attribution->>'instanceId' AS instance_id,
      p.strategy_configuration_hash AS config_hash,
      ai.proposed_order_id::text AS proposal_id,rb.snapshot_id::text AS research_snapshot_id,
      ('/execution/orders/'||ai.proposed_order_id::text||'/research') AS audit_ref
      FROM proposal_ai_reviews ai JOIN proposed_orders p ON p.id=ai.proposed_order_id
      LEFT JOIN research_bindings rb ON rb.proposed_order_id=ai.proposed_order_id
      WHERE ${aiWhere.join(' AND ')} ORDER BY occurred_at DESC,ai.proposed_order_id DESC LIMIT ${bound}`,aiValues);
    allEvents.push(...decisions.map(event));
    const closeWhere=['c.account_id=$1',...(exactTrace?['$2::timestamptz IS NOT NULL','$3::timestamptz IS NOT NULL']:['c.updated_at >= $2::timestamptz','c.updated_at <= $3::timestamptz'])];
    const closeValues:unknown[]=[accountId,query.from,query.to];
    if(query.instrumentId){closeWhere.push(`c.instrument_id=$${closeValues.length+1}`);closeValues.push(query.instrumentId);}
    if(traceProposalId){closeWhere.push(`c.original_proposal_id=$${closeValues.length+1}::bigint`);closeValues.push(traceProposalId);}
    constrainEvent(closeWhere,closeValues,query,'COALESCE(c.failure_reason,c.state)',
      "CASE WHEN c.state IN ('SUBMISSION_UNKNOWN','CANCEL_UNKNOWN','BLOCKED') THEN 'CRITICAL' ELSE 'INFO' END");
    const closes=query.mode==='timeline'&&query.evaluationId&&!traceProposalId?[]:await collect('lifecycle_close_operations',`SELECT 'lifecycle_close_operations' AS source,
      (c.id::text||':'||c.state) AS id,c.updated_at AS occurred_at,c.updated_at AS recorded_at,c.state AS code,
      COALESCE(c.failure_reason,c.state) AS reason,
      CASE WHEN c.state IN ('SUBMISSION_UNKNOWN','CANCEL_UNKNOWN','BLOCKED') THEN 'CRITICAL' ELSE 'INFO' END AS severity,
      c.instrument_id,c.conid,c.original_proposal_id::text AS proposal_id,c.original_proposal_id::text AS lifecycle_id,
      c.id::text AS close_id,
      ('/execution/lifecycle/'||c.original_proposal_id::text||'/close') AS audit_ref
      FROM lifecycle_close_operations c WHERE ${closeWhere.join(' AND ')} ORDER BY c.updated_at DESC,c.id DESC LIMIT ${bound}`,closeValues);
    allEvents.push(...closes.map(row=>event({...row,fields:[fld('snapshot','Rodzaj zapisu','MUTABLE_CURRENT_STATE')]})));
    if(closes.length) report.coverage.push(coverage('close_transitions','PARTIAL','MUTABLE_SNAPSHOT_ONLY'));
    const fillWhere=['f.account_id=$1',...(exactTrace?['$2::timestamptz IS NOT NULL','$3::timestamptz IS NOT NULL']:['f.executed_at >= $2::timestamptz','f.executed_at <= $3::timestamptz'])];
    const fillValues:unknown[]=[accountId,query.from,query.to];
    if(query.instrumentId){fillWhere.push(`p.instrument_id=$${fillValues.length+1}`);fillValues.push(query.instrumentId);}
    if(traceProposalId){fillWhere.push(`f.proposed_order_id IN ($${fillValues.length+1}::bigint,
      (SELECT c.close_proposal_id FROM lifecycle_close_operations c WHERE c.account_id=$1
        AND c.original_proposal_id=$${fillValues.length+1}::bigint))`);fillValues.push(traceProposalId);}
    constrainEvent(fillWhere,fillValues,query,"'FILLED'","'INFO'");
    const fills=query.mode==='timeline'&&query.evaluationId&&!traceProposalId?[]:await collect('broker_execution_fills',`SELECT 'broker_execution_fills' AS source,f.exec_id AS id,
      f.executed_at AS occurred_at,f.created_at AS recorded_at,'FILLED' AS code,'FILLED' AS reason,'INFO' AS severity,
      p.instrument_id,f.conid,f.symbol,p.strategy_attribution->>'implementationId' AS implementation_id,
      p.strategy_attribution->>'instanceId' AS instance_id,p.strategy_configuration_hash AS config_hash,
      f.proposed_order_id::text AS proposal_id,f.broker_order_id,
      ('/execution/lifecycle/'||f.proposed_order_id::text) AS audit_ref
      FROM broker_execution_fills f LEFT JOIN proposed_orders p ON p.id=f.proposed_order_id
      WHERE ${fillWhere.join(' AND ')} ORDER BY f.executed_at DESC,f.exec_id DESC LIMIT ${bound}`,fillValues);
    allEvents.push(...fills.map(event));
    const legWhere=['l.account_id=$1',...(exactTrace?['$2::timestamptz IS NOT NULL','$3::timestamptz IS NOT NULL']:['l.observed_at >= $2::timestamptz','l.observed_at <= $3::timestamptz'])];
    const legValues:unknown[]=[accountId,query.from,query.to];
    if(query.instrumentId){legWhere.push(`p.instrument_id=$${legValues.length+1}`);legValues.push(query.instrumentId);}
    if(traceProposalId){legWhere.push(`l.proposed_order_id IN ($${legValues.length+1}::bigint,
      (SELECT c.close_proposal_id FROM lifecycle_close_operations c WHERE c.account_id=$1
        AND c.original_proposal_id=$${legValues.length+1}::bigint))`);legValues.push(traceProposalId);}
    constrainEvent(legWhere,legValues,query,"COALESCE(l.status,'BROKER_LEG_STATUS_UNKNOWN')",
      "CASE WHEN l.status IS NULL OR upper(l.status) LIKE '%UNKNOWN%' THEN 'WARN' ELSE 'INFO' END");
    const legs=query.mode==='timeline'&&query.evaluationId&&!traceProposalId?[]:await collect('broker_order_links',`SELECT 'broker_order_links' AS source,l.id::text AS id,
      l.observed_at AS occurred_at,l.updated_at AS recorded_at,'BROKER_LEG_OBSERVED' AS code,
      COALESCE(l.status,'BROKER_LEG_STATUS_UNKNOWN') AS reason,
      CASE WHEN l.status IS NULL OR upper(l.status) LIKE '%UNKNOWN%' THEN 'WARN' ELSE 'INFO' END AS severity,
      p.instrument_id,l.role,p.conid,p.instrument AS symbol,p.strategy_configuration_hash AS config_hash,
      l.proposed_order_id::text AS proposal_id,l.broker_order_id,
      ('/execution/lifecycle/'||l.proposed_order_id::text) AS audit_ref
      FROM broker_order_links l LEFT JOIN proposed_orders p ON p.id=l.proposed_order_id
      WHERE ${legWhere.join(' AND ')} ORDER BY l.observed_at DESC,l.id DESC LIMIT ${bound}`,legValues);
    allEvents.push(...legs.map(row=>event({...row,fields:[fld('role','Rola zlecenia',str(row.role)),
      fld('status','Status obserwacji',str(row.reason))]})));
    const deliveryWhere=['o.account_id=$1',...(exactTrace?['$2::timestamptz IS NOT NULL','$3::timestamptz IS NOT NULL']:['d.started_at >= $2::timestamptz','d.started_at <= $3::timestamptz'])];
    const deliveryValues:unknown[]=[accountId,query.from,query.to];
    if(traceProposalId){deliveryWhere.push(`f.original_proposal_id=$${deliveryValues.length+1}::bigint`);deliveryValues.push(traceProposalId);}
    if(query.instrumentId){deliveryWhere.push(`p.instrument_id=$${deliveryValues.length+1}`);deliveryValues.push(query.instrumentId);}
    constrainEvent(deliveryWhere,deliveryValues,query,'d.status',
      "CASE WHEN d.status IN ('FAILED','UNKNOWN') THEN 'CRITICAL' ELSE 'INFO' END");
    const deliveries=query.mode==='timeline'&&query.evaluationId&&!traceProposalId?[]:await collect('lifecycle_alert_delivery_attempts',`SELECT 'lifecycle_alert_delivery_attempts' AS source,
      (d.outbox_id::text||':'||d.attempt_number::text) AS id,d.started_at AS occurred_at,
      COALESCE(d.ended_at,d.started_at) AS recorded_at,('ALERT_DELIVERY_'||d.status) AS code,
      d.status AS reason,CASE WHEN d.status IN ('FAILED','UNKNOWN') THEN 'CRITICAL' ELSE 'INFO' END AS severity,
      p.instrument_id,f.original_proposal_id::text AS proposal_id,
      ('/execution/lifecycle/supervision') AS audit_ref,d.attempt_number
      FROM lifecycle_alert_delivery_attempts d JOIN lifecycle_alert_outbox o ON o.id=d.outbox_id
      LEFT JOIN lifecycle_faults f ON f.id=o.fault_id
      LEFT JOIN proposed_orders p ON p.id=f.original_proposal_id
      WHERE ${deliveryWhere.join(' AND ')} ORDER BY d.started_at DESC,d.id DESC LIMIT ${bound}`,deliveryValues);
    allEvents.push(...deliveries.map(row=>event({...row,fields:[fld('attempt','Próba dostarczenia',Number(row.attempt_number))]})));
    const controlWhere=['account_id=$1','created_at >= $2::timestamptz','created_at <= $3::timestamptz'];
    const controlValues:unknown[]=[accountId,query.from,query.to];
    constrainEvent(controlWhere,controlValues,query,
      "CASE WHEN paused THEN 'ENTRY_PAUSED' ELSE 'ENTRY_RESUMED' END","'INFO'");
    const controls=query.mode==='timeline'?[]:await collect('execution_entry_control_events',`SELECT 'execution_entry_control_events' AS source,
      id::text,created_at AS occurred_at,created_at AS recorded_at,
      CASE WHEN paused THEN 'ENTRY_PAUSED' ELSE 'ENTRY_RESUMED' END AS code,
      CASE WHEN paused THEN 'ENTRY_PAUSED' ELSE 'ENTRY_RESUMED' END AS reason,
      'INFO' AS severity,('/execution/entry-control') AS audit_ref
      FROM execution_entry_control_events WHERE ${controlWhere.join(' AND ')}
      ORDER BY created_at DESC,revision DESC LIMIT ${bound}`,controlValues);
    allEvents.push(...controls.map(event));
    const supervisionWhere=['account_id=$1',...(exactTrace?['$2::timestamptz IS NOT NULL','$3::timestamptz IS NOT NULL']:['observed_at >= $2::timestamptz','observed_at <= $3::timestamptz'])];
    const supervisionValues:unknown[]=[accountId,query.from,query.to];
    if(query.instrumentId){supervisionWhere.push(`instrument_id=$${supervisionValues.length+1}`);supervisionValues.push(query.instrumentId);}
    if(traceProposalId){supervisionWhere.push(`original_proposal_id=$${supervisionValues.length+1}::bigint`);supervisionValues.push(traceProposalId);}
    constrainEvent(supervisionWhere,supervisionValues,query,'status',
      "CASE WHEN status IN ('HOLD','UNAVAILABLE') THEN 'WARN' ELSE 'INFO' END");
    const observations=query.mode==='timeline'&&query.evaluationId&&!traceProposalId?[]:await collect('lifecycle_supervision',`SELECT 'lifecycle_supervision' AS source,
      (original_proposal_id::text||':'||status||':'||EXTRACT(EPOCH FROM observed_at)::text) AS id,
      observed_at AS occurred_at,updated_at AS recorded_at,
      status AS code,status AS reason,CASE WHEN status IN ('HOLD','UNAVAILABLE') THEN 'WARN' ELSE 'INFO' END AS severity,
      instrument_id,conid,config_hash,original_proposal_id::text AS proposal_id,
      original_proposal_id::text AS lifecycle_id,
      ('/execution/lifecycle/supervision') AS audit_ref
      FROM lifecycle_supervision WHERE ${supervisionWhere.join(' AND ')}
      ORDER BY observed_at DESC,original_proposal_id DESC LIMIT ${bound}`,supervisionValues);
    allEvents.push(...observations.map(row=>event({...row,fields:[fld('transitionCoverage','Pokrycie przejść','PARTIAL')]})));
    if(observations.length) report.coverage.push(coverage('lifecycle_transitions','PARTIAL','MUTABLE_SNAPSHOT_ONLY'));

    const hWhere=['h.account_id=$1','h.created_at <= $3::timestamptz',
      '(h.resolved_at IS NULL OR h.resolved_at >= $2::timestamptz)'];
    const hValues:unknown[]=[accountId,query.from,query.to];
    if(query.instrumentId){const boundId=config.instruments.find(i=>i.id===query.instrumentId)?.conId;
      hWhere.push(`(h.conid=$${hValues.length+1} OR h.conid IS NULL)`);hValues.push(boundId??'');}
    constrainEvent(hWhere,hValues,query,'h.reason',
      "CASE WHEN upper(h.severity)='CRITICAL' THEN 'CRITICAL' ELSE 'WARN' END");
    const holds=query.mode==='timeline'?[]:await collect('reconciliation_holds',`SELECT 'reconciliation_holds' AS source,h.id::text AS id,h.created_at AS occurred_at,h.created_at AS recorded_at,
      'RECONCILIATION_HOLD' AS code,h.reason,CASE WHEN upper(h.severity)='CRITICAL' THEN 'CRITICAL' ELSE 'WARN' END AS severity,
      h.conid,h.instrument AS symbol,h.active,h.resolved_at,('/execution/reconciliation/holds') AS audit_ref
      FROM reconciliation_holds h WHERE ${hWhere.join(' AND ')} ORDER BY h.created_at DESC,h.id DESC LIMIT ${bound}`,hValues);
    const configByConId=new Map<string,string|null>();
    for(const item of config.instruments) if(item.conId)
      configByConId.set(item.conId,configByConId.has(item.conId)?null:item.id);
    allEvents.push(...holds.map(row=>event({...row,instrument_id:configByConId.get(str(row.conid)??'')??null})));
    for(const row of holds.slice(0,20)) if(iso(row.resolved_at)===null||iso(row.resolved_at)! > (exactTrace?generatedAt:query.to))
      report.sections.push({id:`hold:${row.id}`,title:'Blokada aktywna na koniec przedziału',
        instrumentId:configByConId.get(str(row.conid)??'')??null,fields:[
          fld('reason','Powód',str(row.reason),'untrusted'),fld('firstObservedAt','Początek',iso(row.occurred_at)),
          fld('resolvedAt','Rozwiązanie',iso(row.resolved_at))]});
    const faultWhere=['f.account_id=$1',...(exactTrace?['$2::timestamptz IS NOT NULL','$3::timestamptz IS NOT NULL']:['f.first_observed_at <= $3::timestamptz',
      '(f.resolved_at IS NULL OR f.resolved_at >= $2::timestamptz)'])];
    const faultValues:unknown[]=[accountId,query.from,query.to];
    if(traceProposalId){faultWhere.push(`f.original_proposal_id=$${faultValues.length+1}::bigint`);faultValues.push(traceProposalId);}
    if(query.instrumentId){faultWhere.push(`p.instrument_id=$${faultValues.length+1}`);faultValues.push(query.instrumentId);}
    if(query.reason==='FAULT_RESOLVED'||query.severity==='INFO') {
      faultWhere.push('f.resolved_at IS NOT NULL');
      if(query.reason&&query.reason!=='FAULT_RESOLVED') faultWhere.push('false');
    } else constrainEvent(faultWhere,faultValues,query,'f.code',"'CRITICAL'");
    const faults=query.mode==='timeline'&&query.evaluationId&&!traceProposalId?[]:await collect('lifecycle_faults',`SELECT 'lifecycle_faults' AS source,f.id::text AS id,f.first_observed_at AS occurred_at,
      f.last_observed_at AS recorded_at,f.code,f.code AS reason,'CRITICAL' AS severity,
      f.original_proposal_id::text AS proposal_id,f.original_proposal_id::text AS lifecycle_id,f.resolved_at,f.active,
      ('/execution/lifecycle/supervision') AS audit_ref
      FROM lifecycle_faults f LEFT JOIN proposed_orders p ON p.id=f.original_proposal_id
      WHERE ${faultWhere.join(' AND ')} ORDER BY f.first_observed_at DESC,f.id DESC LIMIT ${bound}`,faultValues);
    allEvents.push(...faults.map(event));
    for(const row of faults.slice(0,20)) if(iso(row.resolved_at)===null||iso(row.resolved_at)! > (exactTrace?generatedAt:query.to))
      report.sections.push({id:`fault:${row.id}`,title:'Alarm aktywny na koniec przedziału',instrumentId:str(row.instrument_id),
        fields:[fld('code','Kod',str(row.code)),fld('firstObservedAt','Początek',iso(row.occurred_at)),
          fld('resolvedAt','Rozwiązanie',iso(row.resolved_at))]});
    for(const row of faults.filter(r=>r.resolved_at)) {
      const resolved=event({...row,id:`${row.id}:resolved`,occurred_at:row.resolved_at,recorded_at:row.resolved_at,
        code:'FAULT_RESOLVED',reason:'FAULT_RESOLVED',severity:'INFO'});
      allEvents.push(resolved);
    }
    const sorted=allEvents.filter(e=>(exactTrace||e.occurredAt>=query.from&&e.occurredAt<=query.to)&&
      (!query.reason||e.reason===query.reason)&&(!query.severity||e.severity===query.severity))
      .sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||a.id.localeCompare(b.id));
    const visibleEvents=sorted.slice(0,query.limit);
    if(exactTrace&&visibleEvents.length){
      const oldest=visibleEvents.at(-1)!.occurredAt,newest=visibleEvents[0].occurredAt;
      report.interval={from:oldest,to:newest};
      report.coverage.push(coverage('timeline','PARTIAL','EXACT_IDENTITY_TRACE_RETAINED_HISTORY'));
      if(Date.parse(report.interval.to)-Date.parse(report.interval.from)>31*86400000)
        report.omissions.push('TRACE_SPANS_MORE_THAN_31_DAYS');
    }
    report.events=visibleEvents;
    if(sorted.length>query.limit){report.truncated=true;report.omissions.push('events:ROW_LIMIT');}

    const meta=await collect('diagnostic_coverage',`SELECT pruned_through_at AS occurred_at,pruned_through_at,
      pruned_count FROM diagnostic_retention WHERE account_id=$1 LIMIT 1`,[accountId]);
    if(!meta.length) report.coverage.push(coverage('diagnostic_retention','UNAVAILABLE','RETENTION_METADATA_MISSING'));
    const watermark=iso(meta[0]?.pruned_through_at);
    if(watermark && Date.parse(query.from)<=Date.parse(watermark)) {
      report.coverage.push(coverage('diagnostic_retention','PARTIAL','PRUNED_INTERVAL',generatedAt,watermark));
      report.omissions.push('diagnostic_evaluations:PRUNED_INTERVAL');
    }
    const gapRows=await collect('diagnostic_coverage_gaps',`SELECT from_at AS occurred_at,kind,from_at,to_at FROM diagnostic_coverage_gaps
      WHERE account_id=$1 AND from_at <= $3::timestamptz AND to_at >= $2::timestamptz
      ORDER BY from_at DESC LIMIT ${bound}`,[accountId,query.from,query.to]);
    for(const gap of gapRows.slice(0,20)){report.coverage.push(coverage('scheduler','PARTIAL',str(gap.kind)??'OBSERVATION_GAP',
      iso(gap.to_at),iso(gap.from_at)));}
    if(gapRows.length>20){report.truncated=true;report.omissions.push('diagnostic_coverage_gaps:DISPLAY_LIMIT');}
    const heartbeats=await collect('diagnostic_process_heartbeats',`SELECT started_at AS occurred_at,started_at,last_seen_at,expected_interval_ms,
      enabled,failure_count,last_failure_at,process_id FROM diagnostic_process_heartbeats WHERE account_id=$1
      AND started_at <= $3::timestamptz AND last_seen_at >= $2::timestamptz ORDER BY started_at DESC LIMIT ${bound}`,
      [accountId,query.from,query.to]);
    if(!heartbeats.length) report.coverage.push(coverage('scheduler','UNAVAILABLE','HEARTBEAT_UNAVAILABLE'));
    else {
      const newest=heartbeats[0],last=iso(newest.last_seen_at),expected=Number(newest.expected_interval_ms);
      if(heartbeats.length>1) report.coverage.push(coverage('scheduler','PARTIAL','PROCESS_CHANGE',last,iso(heartbeats.at(-1)?.started_at)));
      if(last && (Date.parse(query.to)-Date.parse(last)>expected*2 || Date.parse(last)>Date.parse(generatedAt)+60000))
        report.coverage.push(coverage('scheduler','PARTIAL','HEARTBEAT_GAP_OR_CLOCK_SKEW',last));
      if(last && Date.parse(query.from)<Date.parse(iso(heartbeats.at(-1)?.started_at)??query.from))
        report.coverage.push(coverage('scheduler','PARTIAL','INTERVAL_BEFORE_PROCESS_START',last));
      if(heartbeats.some(row=>row.enabled===true)) {
        const lag=await collect('scheduler_interval_gaps',`WITH observed AS (
          SELECT e.process_id,e.instrument_id,e.occurred_at,
            lag(e.occurred_at) OVER(PARTITION BY e.process_id,e.instrument_id ORDER BY e.occurred_at,e.id) AS previous_at,
            h.expected_interval_ms FROM diagnostic_evaluations e JOIN diagnostic_process_heartbeats h
            ON h.process_id=e.process_id AND h.account_id=e.account_id
          WHERE e.account_id=$1 AND e.occurred_at >= $2::timestamptz AND e.occurred_at <= $3::timestamptz
        ) SELECT instrument_id,previous_at AS from_at,occurred_at AS to_at,occurred_at
          FROM observed WHERE previous_at IS NOT NULL AND
          EXTRACT(EPOCH FROM occurred_at-previous_at)*1000 > expected_interval_ms*2
          ORDER BY occurred_at DESC LIMIT ${bound}`,[accountId,query.from,query.to]);
        for(const gap of lag.slice(0,20)) report.coverage.push(coverage('scheduler','PARTIAL',`SCHEDULED_INTERVAL_GAP:${str(gap.instrument_id)??'unknown'}`,
          iso(gap.to_at),iso(gap.from_at)));
        if(lag.length>20){report.truncated=true;report.omissions.push('scheduler_interval_gaps:DISPLAY_LIMIT');}
        const present=await collect('scheduler_instrument_presence',`SELECT instrument_id,min(occurred_at) AS occurred_at,
          max(occurred_at) AS last_at FROM diagnostic_evaluations WHERE account_id=$1
          AND occurred_at >= $2::timestamptz AND occurred_at <= $3::timestamptz
          GROUP BY instrument_id ORDER BY instrument_id LIMIT ${bound}`,[accountId,query.from,query.to]);
        for(const item of configured.slice(0,20)) {
          const p=present.find(row=>row.instrument_id===item.id);
          if(!p) {report.coverage.push(coverage('scheduler','PARTIAL',`INSTRUMENT_INTERVAL_UNOBSERVED:${item.id}`));continue;}
          const start=Math.max(Date.parse(query.from),Date.parse(iso(newest.started_at)??query.from));
          const end=Math.min(Date.parse(query.to),Date.parse(last??query.to));
          const firstAt=Date.parse(iso(p.occurred_at)??query.to),lastAt=Date.parse(iso(p.last_at)??query.from);
          if(firstAt-start>expected*2) report.coverage.push(coverage('scheduler','PARTIAL',`INSTRUMENT_LEADING_GAP:${item.id}`,iso(p.occurred_at)));
          if(end-lastAt>expected*2) report.coverage.push(coverage('scheduler','PARTIAL',`INSTRUMENT_TRAILING_GAP:${item.id}`,iso(p.last_at)));
        }
        if(configured.length>20){report.truncated=true;report.omissions.push('scheduler_instruments:DISPLAY_LIMIT');}
        if(!evals.length && !configured.length) report.coverage.push(coverage('scheduler','PARTIAL','SCHEDULED_INTERVAL_COVERAGE_UNPROVEN'));
      }
    }

    if(query.mode==='status') {
      const latest=new Map<string,DiagnosticEvent>();
      for(const e of allEvents.sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt))) if(e.instrumentId&&!latest.has(e.instrumentId)) latest.set(e.instrumentId,e);
      for(const item of configured) {
        const last=latest.get(item.id);
        report.sections.push({id:`instrument:${item.id}`,title:item.symbol??item.id,instrumentId:item.id,fields:[
          fld('configHash','Konfiguracja',config.configHash),fld('conId','Kontrakt',item.conId,'identifier'),
          fld('listing','Rynek',item.listing),fld('strategyInstances','Instancje strategii',item.instances?.map(x=>`${x.implementationId}/${x.instanceId}@${x.revision}`).join(', ')??item.instanceId),
          fld('lastReason','Ostatni powód',last?.reason??null),fld('lastObservedAt','Ostatnia obserwacja',last?.occurredAt??null)]});
      }
      await appendDiagnosticStatus(deps,query,report);
    }
    if(query.mode==='timeline' && traceProposalId && deps.roundTrip) {
      try {
        const evaluated=await deps.roundTrip(Number(traceProposalId));
        const result=evaluated?.accountId===accountId&&evaluated.proposalId===Number(traceProposalId)&&
          (!query.instrumentId||evaluated.instrumentId===query.instrumentId)?evaluated:null;
        if(!result)report.coverage.push(coverage('round_trip','UNAVAILABLE','ROUND_TRIP_IDENTITY_OR_EVIDENCE_UNAVAILABLE'));
        report.sections.push({id:'round-trip',title:'Zapisany cykl transakcji',instrumentId:result?.instrumentId??null,
          fields:[fld('status','Stan cyklu',result?.status??null),
            fld('reasons','Powody',result?.reasons.join(', ')??null,'untrusted'),
            fld('accounting','Kompletność rozliczenia',result?.accounting??null),
            fld('closeState','Stan zamknięcia',result?.closeOperation?.state??null),
            fld('reconciliationRunId','Uzgodnienie',result?.reconciliationRunId===null||result?.reconciliationRunId===undefined?null:String(result.reconciliationRunId),'identifier'),
            fld('grossPnl','Wynik brutto',result?.grossPnl?.amount??null,'financial'),
            fld('grossCurrency','Waluta wyniku brutto',result?.grossPnl?.currency??null),
            fld('netPnl','Wynik netto',result?.netPnl?.amount??null,'financial'),
            fld('netCurrency','Waluta wyniku netto',result?.netPnl?.currency??null),
            fld('missingFeeCount','Brakujące prowizje',result?.missingCommissionExecIds.length??null)]});
      }catch{report.coverage.push(coverage('round_trip','UNAVAILABLE','SOURCE_READ_FAILED'));}
    }
    if(query.mode==='timeline') await appendDiagnosticTimeline(deps,query,report);
    if(query.mode==='session') {
      const evalCountWhere=['account_id=$1','occurred_at >= $2::timestamptz','occurred_at <= $3::timestamptz'];
      const evalCountValues:unknown[]=[accountId,query.from,query.to];
      if(query.instrumentId){evalCountWhere.push(`instrument_id=$${evalCountValues.length+1}`);evalCountValues.push(query.instrumentId);}
      if(query.reason){evalCountWhere.push(`reason=$${evalCountValues.length+1}`);evalCountValues.push(query.reason);}
      if(query.severity){evalCountWhere.push(`(CASE WHEN outcome IN ('ERROR','UNKNOWN') OR evaluation_kind='error' THEN 'CRITICAL' WHEN outcome='SKIPPED' THEN 'WARN' ELSE 'INFO' END)=$${evalCountValues.length+1}`);evalCountValues.push(query.severity);}
      const counts=await collect('session_counts',`SELECT count(*)::int AS evaluations,
        count(*) FILTER(WHERE outcome='CONFIGURED_EVALUATION' AND reason='NO_SIGNAL')::int AS no_signals,
        count(*) FILTER(WHERE outcome='ERROR' OR evaluation_kind='error')::int AS errors,
        count(*) FILTER(WHERE outcome='SKIPPED')::int AS skips
        FROM diagnostic_evaluations WHERE ${evalCountWhere.join(' AND ')}`,evalCountValues);
      const c=counts[0];
      report.counters=[{key:'evaluations',label:'Oceny zapisane',value:c?Number(c.evaluations):null},
        {key:'noSignals',label:'Brak sygnału',value:c?Number(c.no_signals):null},
        {key:'errors',label:'Błędy',value:c?Number(c.errors):null},
        {key:'skips',label:'Pominięte',value:c?Number(c.skips):null}];
      const byReason=await collect('session_reasons',`SELECT reason,min(occurred_at) AS occurred_at,
        count(*)::int AS total FROM diagnostic_evaluations WHERE ${evalCountWhere.join(' AND ')}
        GROUP BY reason ORDER BY total DESC,reason LIMIT ${bound}`,evalCountValues);
      report.sections.push({id:'reason-counts',title:'Oceny według powodu',instrumentId:query.instrumentId??null,
        fields:byReason.slice(0,100).map((row,index)=>fld(`reason-${index}`,str(row.reason)??'UNKNOWN',Number(row.total),'untrusted'))});
      if(byReason.length>100){report.truncated=true;report.omissions.push('session_reasons:DISPLAY_LIMIT');}
      const attemptWhere=['a.account_id=$1','a.attempted_at >= $2::timestamptz','a.attempted_at <= $3::timestamptz'];
      const attemptValues:unknown[]=[accountId,query.from,query.to];
      if(query.instrumentId){attemptWhere.push(`rp.instrument_id=$${attemptValues.length+1}`);attemptValues.push(query.instrumentId);}
      const attempts=await collect('session_attempts',`SELECT count(*)::int AS attempts FROM paper_entry_attempts a
        LEFT JOIN paper_run_proposals rp ON rp.proposed_order_id=a.proposed_order_id
        WHERE ${attemptWhere.join(' AND ')}`,attemptValues);
      report.counters.push({key:'attempts',label:'Próby wejścia',value:query.reason||query.severity?null:attempts[0]?Number(attempts[0].attempts):null});
      const fillWhere=['f.account_id=$1','f.executed_at >= $2::timestamptz','f.executed_at <= $3::timestamptz'];
      const fillValues:unknown[]=[accountId,query.from,query.to];
      if(query.instrumentId){fillWhere.push(`p.instrument_id=$${fillValues.length+1}`);fillValues.push(query.instrumentId);}
      const filled=await collect('session_fills',`SELECT count(*)::int AS fills,
        count(*) FILTER(WHERE f.commission IS NULL OR f.commission_currency IS NULL)::int AS missing_fees
        FROM broker_execution_fills f LEFT JOIN proposed_orders p ON p.id=f.proposed_order_id
        WHERE ${fillWhere.join(' AND ')}`,fillValues);
      report.counters.push({key:'fills',label:'Realizacje',value:query.reason||query.severity?null:filled[0]?Number(filled[0].fills):null},
        {key:'missingFees',label:'Realizacje bez prowizji',value:query.reason||query.severity?null:filled[0]?Number(filled[0].missing_fees):null});
      const faultWhere=['f.account_id=$1','f.first_observed_at <= $3::timestamptz',
        '(f.resolved_at IS NULL OR f.resolved_at >= $2::timestamptz)'];
      const faultValues:unknown[]=[accountId,query.from,query.to];
      if(query.instrumentId){faultWhere.push(`p.instrument_id=$${faultValues.length+1}`);faultValues.push(query.instrumentId);}
      const faultCount=await collect('session_faults',`SELECT count(*)::int AS faults,
        count(*) FILTER(WHERE f.active)::int AS active_faults
        FROM lifecycle_faults f LEFT JOIN proposed_orders p ON p.id=f.original_proposal_id
        WHERE ${faultWhere.join(' AND ')}`,faultValues);
      report.counters.push({key:'faults',label:'Epizody alarmowe',value:query.reason||query.severity?null:faultCount[0]?Number(faultCount[0].faults):null},
        {key:'activeFaults',label:'Aktywne alarmy',value:query.reason||query.severity?null:faultCount[0]?Number(faultCount[0].active_faults):null});
      if(query.reason||query.severity) report.omissions.push('SESSION_FILTER_APPLIES_TO_EVALUATIONS_ONLY');
      await appendDiagnosticSessionEconomics(deps,query,report);
    }
    await accountIntegrity();
    if(deps.currentAccountId()!==accountId || deps.currentSessionId()!==sessionId) {
      report.coverage.push(coverage('account','UNAVAILABLE','ACCOUNT_CONTEXT_CHANGED'));
      report.events=[];report.sections=[];report.counters=[];report.omissions.push('ACCOUNT_CONTEXT_CHANGED');
    }
    return report;
  }};
}
