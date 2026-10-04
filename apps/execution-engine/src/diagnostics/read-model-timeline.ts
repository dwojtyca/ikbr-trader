import {researchHash} from '@ikbr/shared/instrument-research';
import {safeDiagnosticUrl,type DiagnosticField,type DiagnosticQuery,type DiagnosticReport,type DiagnosticScalar} from '@ikbr/shared/diagnostics';
import type {DiagnosticReadModelDeps} from './read-model.js';
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const scalar=(v:unknown):DiagnosticScalar=>typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)?v:null;
const stamp=(v:unknown):string|null=>v instanceof Date?v.toISOString():typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const millis=(v:unknown):string|null=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=8640000000000000?new Date(v).toISOString():null;
const field=(key:string,label:string,value:DiagnosticScalar,sensitivity?:DiagnosticField['sensitivity']):DiagnosticField=>({key,label,value,...(sensitivity?{sensitivity}:{})});
export async function appendDiagnosticTimeline(deps:DiagnosticReadModelDeps,query:DiagnosticQuery,report:DiagnosticReport):Promise<void> {
 if(query.mode!=='timeline')return;
 const account=deps.currentAccountId();if(!account)return;
 const ids=query.proposalId?[query.proposalId]:[...new Set(report.events.map(e=>e.proposalId).filter((id):id is string=>id!==null))];
 if(!ids.length) {report.omissions.push('NO_PERSISTED_PROPOSAL_LINK_FOR_EVALUATION');return;}
 if(ids.length>20){report.truncated=true;report.omissions.push('TIMELINE_PROPOSAL_LIMIT');}
 for(const id of ids.slice(0,20)) {
  try {
   const result=await deps.pool.query(`SELECT p.id,p.instrument_id,p.strategy_attribution,p.risk_check_status,p.source_error,p.last_error,
     ai.status AS review_status,ai.decision_json,ai.risk_evidence,ai.decided_at,ai.expires_at,
     rb.config_hash,rb.snapshot_hash,rb.snapshot_id,rb.manifest_hash,
     rs.canonical_json AS snapshot_json,rs.stored_at,
     c.model,c.prompt_version,c.output_schema_version,c.request_hash,c.started_at,c.deadline_at,
     o.received_at,o.outcome_json->>'kind' AS model_outcome
     FROM proposed_orders p LEFT JOIN proposal_ai_reviews ai ON ai.proposed_order_id=p.id
     LEFT JOIN research_bindings rb ON rb.proposed_order_id=p.id
     LEFT JOIN research_snapshots rs ON rs.id=rb.snapshot_id
     LEFT JOIN proposal_ai_model_calls c ON c.proposed_order_id=p.id
     LEFT JOIN proposal_ai_model_outcomes o ON o.proposed_order_id=p.id
     WHERE p.id=$1 AND (p.execution_account_id=$2 OR ai.account_id=$2)
       AND (p.execution_account_id IS NULL OR p.execution_account_id=$2) AND (ai.account_id IS NULL OR ai.account_id=$2)`,[id,account]);
   const row=result.rows[0];
   if(!row) {report.coverage.push({source:'decision_evidence',status:'UNAVAILABLE',observedAt:null,earliestAvailableAt:null,reasons:['PROPOSAL_NOT_AVAILABLE_IN_ACCOUNT']});continue;}
   if(query.instrumentId&&row.instrument_id!==query.instrumentId){report.omissions.push('TRACE_INSTRUMENT_MISMATCH');continue;}
   const decision=object(row.decision_json),risk=object(row.risk_evidence),attribution=object(row.strategy_attribution);
   const fields:DiagnosticField[]=[field('proposalId','Propozycja',id,'identifier'),field('configHash','Oryginalna konfiguracja',scalar(row.config_hash??attribution?.effectiveConfigHash)),
    field('implementation','Algorytm',scalar(attribution?.implementationId)),field('instance','Instancja',scalar(attribution?.instanceId)),field('revision','Wersja instancji',scalar(attribution?.instanceRevision)),
    field('reviewStatus','Stan zapisanej oceny AI',scalar(row.review_status)),field('decision','Zapisany werdykt AI',scalar(decision?.decision)),
    field('rationale','Zapisane uzasadnienie AI (niezaufana treść)',scalar(decision?.reason),'untrusted'),field('decidedAt','Czas decyzji AI',stamp(row.decided_at)),
    field('reviewExpiresAt','Termin decyzji',stamp(row.expires_at)),field('technicalRisk','Ryzyko propozycji',scalar(row.risk_check_status)),
    field('executionRiskAvailable','Zapis świeżego ryzyka wykonania istnieje',risk?true:null),
    field('executionRiskScope','Znaczenie dowodu ryzyka',risk?'Zapisane parametry oceny przed wykonaniem; nie stanowią aktualnej zgody na zapis':null),
    field('riskAssessedAt','Czas zapisanej oceny ryzyka',millis(risk?.assessedAtMs)),
    field('riskValidUntil','Ważność zapisanej oceny ryzyka',millis(risk?.validUntilMs)),
    field('riskInstrumentId','Instrument dowodu ryzyka',scalar(risk?.instrumentId)),field('riskConId','Kontrakt dowodu ryzyka',scalar(risk?.conid)),
    field('riskSessionId','Sesja dowodu ryzyka',scalar(risk?.sessionId),'identifier'),
    field('riskConfigHash','Konfiguracja dowodu ryzyka',scalar(risk?.strategyEffectiveConfigHash)),
    field('riskAccountCompletedAt','Czas dowodu stanu konta',stamp(risk?.accountCompletedAt)),
    field('riskBidObservedAt','Czas kwotowania bid',stamp(risk?.bidObservedAt)),field('riskAskObservedAt','Czas kwotowania ask',stamp(risk?.askObservedAt)),
    field('riskQuoteCurrency','Waluta wyceny instrumentu',scalar(risk?.quoteCurrency)),
    field('riskQuoteNotional','Wartość zlecenia w ocenie',scalar(risk?.quoteNotional),'financial'),
    field('riskQuoteStopRisk','Ryzyko stop w ocenie',scalar(risk?.quoteStopRisk),'financial'),
    field('sourceError','Zapisany błąd źródła',scalar(row.source_error),'untrusted'),field('lastError','Zapisany błąd wykonania',scalar(row.last_error),'untrusted'),
    field('snapshotId','Użyty snapshot badań',scalar(row.snapshot_id),'identifier'),field('snapshotHash','Hash użytych badań',scalar(row.snapshot_hash)),
    field('manifestHash','Hash polityki badań',scalar(row.manifest_hash)),field('model','Zapisany model',scalar(row.model)),field('promptVersion','Wersja instrukcji modelu',scalar(row.prompt_version)),
    field('outputSchemaVersion','Schemat decyzji',scalar(row.output_schema_version)),field('requestHash','Hash zapisanego wywołania',scalar(row.request_hash)),
    field('modelStartedAt','Początek wywołania',stamp(row.started_at)),field('modelDeadlineAt','Termin wywołania',stamp(row.deadline_at)),
    field('modelReceivedAt','Odbiór odpowiedzi',stamp(row.received_at)),field('modelOutcome','Wynik wywołania',scalar(row.model_outcome)),
    field('auditRef','Dokładny zapis (uwierzytelnione API)',`/execution/orders/${id}/research`,'identifier')];
   for(const [key,label,values] of [['riskFlags','Flaga ryzyka AI',decision?.riskFlags],['evidenceRefs','Dowód wskazany przez AI',decision?.evidenceRefs]] as const) {
    if(Array.isArray(values))for(const [index,value] of values.slice(0,30).entries())fields.push(field(`${key}:${index}`,label,scalar(value),key==='evidenceRefs'?'identifier':'untrusted'));
    if(Array.isArray(values)&&values.length>30){report.truncated=true;report.omissions.push('DECISION_FIELD_LIMIT');}
   }
   report.sections.push({id:`decision:${id}`,title:'Decyzja, ryzyko i zapisane wywołanie AI',instrumentId:row.instrument_id??null,fields});
   if(row.snapshot_json) {
    const snapshot=object(JSON.parse(row.snapshot_json));
    if(!snapshot||researchHash(snapshot)!==row.snapshot_hash||snapshot.instrumentId!==row.instrument_id||snapshot.configHash!==row.config_hash)throw Error('STORED_RESEARCH_IDENTITY_INVALID');
    const evidence=Array.isArray(snapshot.evidence)?snapshot.evidence:[];
    for(const [index,raw] of evidence.slice(0,50).entries()) {
     const source=object(raw),published=object(source?.published);if(!source)continue;
     report.sections.push({id:`source:${id}:${index}`,title:'Zapisane źródło użytych badań',instrumentId:row.instrument_id??null,fields:[
      field('ref','Odsyłacz w snapshot',scalar(source.ref),'identifier'),field('sourceId','Źródło',scalar(source.sourceId)),field('documentId','Dokument',scalar(source.documentId),'identifier'),
      field('url','Adres źródła',typeof source.url==='string'?safeDiagnosticUrl(source.url):null,'untrusted'),field('contentHash','Hash treści',scalar(source.contentHash)),
      field('publicationPrecision','Dokładność publikacji',scalar(published?.precision)),field('publishedAt','Publikacja',scalar(published?.at??published?.date)),
      field('publicationZone','Strefa publikacji daty',scalar(published?.timeZone)),field('fetchedAt','Pobranie',stamp(source.fetchedAt)),field('observedAt','Obserwacja',stamp(source.observedAt)),
      field('storedAt','Utrwalenie snapshot',stamp(row.stored_at))]});
    }
    if(evidence.length>50){report.truncated=true;report.omissions.push('RESEARCH_REFERENCE_LIMIT');}
   } else report.coverage.push({source:'research_references',status:'UNAVAILABLE',observedAt:null,earliestAvailableAt:null,reasons:['RESEARCH_SNAPSHOT_MISSING']});
   report.coverage.push({source:'decision_evidence',status:'PARTIAL',observedAt:stamp(row.decided_at),earliestAvailableAt:null,reasons:['STORED_EVIDENCE_NOT_CURRENT_ADMISSION']});
  }catch {report.coverage.push({source:'decision_evidence',status:'UNAVAILABLE',observedAt:null,earliestAvailableAt:null,reasons:['STORED_EVIDENCE_UNAVAILABLE']});}
 }
}
