import type {DiagnosticReport,DiagnosticQuery,DiagnosticField} from '@ikbr/shared/diagnostics';
import type {DiagnosticReadModelDeps} from './read-model.js';
export async function appendDiagnosticSessionEconomics(deps:DiagnosticReadModelDeps,query:DiagnosticQuery,report:DiagnosticReport):Promise<void> {
 if(query.mode!=='session')return;
 const account=deps.currentAccountId();if(!account)return;
 const unavailable=(reason:string)=>report.coverage.push({source:'session_economics',status:'UNAVAILABLE',observedAt:null,earliestAvailableAt:null,reasons:[reason]});
 if(!deps.roundTrip){unavailable('ROUND_TRIP_EVALUATOR_UNAVAILABLE');return;}
 try{
  const values:unknown[]=[account,query.from,query.to];
  let filter='';if(query.instrumentId){values.push(query.instrumentId);filter=' AND original.instrument_id=$4';}
  const rows=(await deps.pool.query(`SELECT DISTINCT original.id,original.instrument_id,fill.currency
    FROM broker_execution_fills fill LEFT JOIN lifecycle_close_operations close ON close.close_proposal_id=fill.proposed_order_id
    LEFT JOIN proposed_orders original ON original.id=COALESCE(close.original_proposal_id,fill.proposed_order_id)
    WHERE fill.account_id=$1 AND fill.side IN ('SELL','SLD') AND fill.executed_at >= $2 AND fill.executed_at <= $3
    AND (original.execution_account_id=$1 OR original.id IS NULL)${filter}
    ORDER BY original.id NULLS LAST,fill.currency LIMIT 51`,values)).rows;
  if(rows.length>50){report.truncated=true;report.omissions.push('SESSION_ECONOMICS_COHORT_LIMIT');}
  const byCurrency=new Map<string,{gross:number;net:number;complete:number;pending:number}>();
  let unknown=0;
  const seen=new Set<string>();
  for(const row of rows.slice(0,50)){
   if(!row.id){unknown++;continue;}
   if(seen.has(String(row.id)))continue;seen.add(String(row.id));
   const value=await deps.roundTrip(Number(row.id));
   const currency=value?.quoteCurrency??(typeof row.currency==='string'?row.currency:'NIEZNANA');
   const group=byCurrency.get(currency)??{gross:0,net:0,complete:0,pending:0};
   const gross=value?.grossPnl,net=value?.netPnl;
   if(gross&&net&&value?.status==='COMPLETED'&&value.accounting==='COMPLETE'&&gross.currency===currency&&net.currency===currency&&
     Number.isFinite(gross.amount)&&Number.isFinite(net.amount)&&Number.isFinite(group.net+net.amount)&&Number.isFinite(group.gross+gross.amount)){
    group.gross+=gross.amount;group.net+=net.amount;group.complete++;
   }else group.pending++;
   byCurrency.set(currency,group);
  }
  for(const [currency,group] of byCurrency){
   const complete=group.pending===0&&unknown===0&&rows.length<=50;
   const fields:DiagnosticField[]=[{key:'currency',label:'Waluta',value:currency},{key:'scope',label:'Zakres',value:'Zapisane wyjścia bota w przedziale; pełne cykle według istniejącego ewaluatora'},
    {key:'completeTrips',label:'Potwierdzone rozliczone cykle',value:group.complete},{key:'pendingTrips',label:'Cykle niepotwierdzone/niepełne opłaty',value:group.pending},
    {key:'gross',label:'Wynik brutto potwierdzonych cykli',value:complete?group.gross:null,sensitivity:'financial'},
    {key:'net',label:'Wynik netto potwierdzonych cykli',value:complete?group.net:null,sensitivity:'financial'},
    {key:'complete',label:'Kompletność rozliczenia wybranego zbioru',value:complete}];
   report.sections.push({id:`session-economics:${currency}`,title:'Rozliczenie sesji według waluty',instrumentId:query.instrumentId??null,fields});
  }
  report.counters.push({key:'unattributedExits',label:'Wyjścia bez przypisania do bota',value:unknown});
  report.coverage.push({source:'session_economics',status:'PARTIAL',observedAt:report.generatedAt,earliestAvailableAt:null,
   reasons:[rows.length?'STORED_EXIT_COHORT_NOT_BROKER_ACCOUNT_TOTAL':'NO_STORED_EXITS_NOT_PROOF_OF_ZERO_PNL',...(unknown?['UNATTRIBUTED_EXITS']:[])]});
 }catch{unavailable('SESSION_ECONOMICS_UNAVAILABLE');}
}
