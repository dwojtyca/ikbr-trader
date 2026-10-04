import { createHmac, randomBytes } from 'node:crypto';
import { DIAGNOSTIC_LIMITS, EMPTY_DIAGNOSTIC_IDENTITY, type DiagnosticEvent, type DiagnosticField, type DiagnosticReport } from './types.js';
export interface DiagnosticPrivacy { secrets?: readonly string[]; accountIds?: readonly string[] }
export function safeDiagnosticText(value: string, privacy: DiagnosticPrivacy = {}): string {
  let text = value;
  for (const secret of [...(privacy.secrets ?? []), ...(privacy.accountIds ?? [])].filter(Boolean).sort((a,b)=>b.length-a.length)) text=text.split(secret).join('[UKRYTO]');
  text=text.replace(/\b(?:DU|U|F)\d{5,}\b/g,'[KONTO]')
    .replace(/\bBearer\s+[^\s,;]+/gi,'Bearer [UKRYTO]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g,'[SEKRET]')
    .replace(/\b(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,'[SEKRET]')
    .replace(/https?:\/\/[^\s]+/gi, match => safeDiagnosticUrl(match) ?? '[ADRES UKRYTY]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`);
  return text.length>2048 ? `${text.slice(0,2020)}… [SKRÓCONO]` : text;
}
export function safeDiagnosticUrl(value: string): string | null {
  try { const url=new URL(value); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return null;
    url.search=''; url.hash=''; return url.toString(); } catch { return null; }
}
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const iso=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
const list=(v:unknown,max:number):v is unknown[]=>Array.isArray(v)&&v.length<=max;
const fieldValid=(v:unknown)=>obj(v)&&typeof v.key==='string'&&typeof v.label==='string'&&
  (v.value===null||typeof v.value==='string'||typeof v.value==='boolean'||typeof v.value==='number'&&Number.isFinite(v.value))&&
  (v.sensitivity===undefined||['identifier','financial','untrusted'].includes(String(v.sensitivity)));
export function parseDiagnosticReport(value: unknown): DiagnosticReport {
  if (!obj(value)||value.schemaVersion!==1||!['events','status','timeline','session'].includes(String(value.mode))||!iso(value.generatedAt)||
      !obj(value.interval)||!iso(value.interval.from)||!iso(value.interval.to)||typeof value.truncated!=='boolean'||
      !list(value.omissions,100)||value.omissions.some(v=>typeof v!=='string')||!list(value.events,1000)||!list(value.sections,1000)||
      !list(value.coverage,100)||!list(value.counters,1000)) throw Error('DIAGNOSTIC_RESPONSE_INVALID');
  for (const e of value.events) {
    if (!obj(e)||e.schemaVersion!==1||!['INFO','WARN','ERROR','CRITICAL'].includes(String(e.severity))||!iso(e.occurredAt)||!iso(e.recordedAt)||
        ['id','code','service','reason','message','impact','action'].some(key=>typeof e[key]!=='string')||
        Object.keys(EMPTY_DIAGNOSTIC_IDENTITY).some(key=>e[key]!==null&&(key==='revision'? !Number.isSafeInteger(e[key]):typeof e[key]!=='string'))||
        (e.auditRef!==null&&typeof e.auditRef!=='string')||!list(e.fields,200)||e.fields.some(f=>!fieldValid(f))) throw Error('DIAGNOSTIC_RESPONSE_INVALID');
  }
  for(const s of value.sections) if(!obj(s)||typeof s.id!=='string'||typeof s.title!=='string'||(s.instrumentId!==null&&typeof s.instrumentId!=='string')||!list(s.fields,200)||s.fields.some(f=>!fieldValid(f))) throw Error('DIAGNOSTIC_RESPONSE_INVALID');
  for(const c of value.coverage) if(!obj(c)||typeof c.source!=='string'||!['COMPLETE','PARTIAL','UNAVAILABLE'].includes(String(c.status))||
    (c.observedAt!==null&&!iso(c.observedAt))||(c.earliestAvailableAt!==null&&!iso(c.earliestAvailableAt))||!list(c.reasons,100)||c.reasons.some(r=>typeof r!=='string')) throw Error('DIAGNOSTIC_RESPONSE_INVALID');
  for(const c of value.counters) if(!obj(c)||typeof c.key!=='string'||typeof c.label!=='string'||(c.value!==null&&(typeof c.value!=='number'||!Number.isFinite(c.value)))) throw Error('DIAGNOSTIC_RESPONSE_INVALID');
  return sanitizeDiagnosticReport(value as unknown as DiagnosticReport);
}
export function sanitizeDiagnosticReport(report: DiagnosticReport, privacy: DiagnosticPrivacy = {}): DiagnosticReport {
  const text=(s:string)=>safeDiagnosticText(s,privacy), nullable=(s:string|null)=>s===null?null:text(s);
  const fields=(rows:DiagnosticField[])=>rows.map(f=>({key:text(f.key),label:text(f.label),value:typeof f.value==='string'?text(f.value):f.value,
    ...(f.sensitivity?{sensitivity:f.sensitivity}:{})}));
  return {schemaVersion:1,mode:report.mode,generatedAt:report.generatedAt,interval:{from:report.interval.from,to:report.interval.to},
    coverage:report.coverage.map(c=>({source:text(c.source),status:c.status,observedAt:c.observedAt,earliestAvailableAt:c.earliestAvailableAt,reasons:c.reasons.map(text)})),
    events:report.events.map(e=>({schemaVersion:1,id:text(e.id),code:text(e.code),severity:e.severity,service:text(e.service),
      occurredAt:e.occurredAt,recordedAt:e.recordedAt,reason:text(e.reason),message:text(e.message),impact:text(e.impact),action:text(e.action),
      instrumentId:nullable(e.instrumentId),conId:nullable(e.conId),symbol:nullable(e.symbol),listing:nullable(e.listing),implementationId:nullable(e.implementationId),
      instanceId:nullable(e.instanceId),revision:e.revision,configHash:nullable(e.configHash),evaluationId:nullable(e.evaluationId),traceId:nullable(e.traceId),
      proposalId:nullable(e.proposalId),brokerOrderId:nullable(e.brokerOrderId),lifecycleId:nullable(e.lifecycleId),closeId:nullable(e.closeId),researchSnapshotId:nullable(e.researchSnapshotId),
      auditRef:e.auditRef&&/^\/execution\/[a-zA-Z0-9_./?=&%-]+$/.test(e.auditRef)?text(e.auditRef):null,fields:fields(e.fields)})),
    sections:report.sections.map(s=>({id:text(s.id),title:text(s.title),instrumentId:nullable(s.instrumentId),fields:fields(s.fields)})),
    counters:report.counters.map(c=>({key:text(c.key),label:text(c.label),value:c.value})),truncated:report.truncated,omissions:report.omissions.map(text)};
}
export function redactDiagnosticExport(input: DiagnosticReport, privacy: DiagnosticPrivacy = {}): DiagnosticReport {
  const report=sanitizeDiagnosticReport(input,privacy), salt=randomBytes(32);
  const pseudo=(s:string)=>`ref-${createHmac('sha256',salt).update(s).digest('hex').slice(0,16)}`;
  const keys=['id','evaluationId','traceId','proposalId','brokerOrderId','lifecycleId','closeId','researchSnapshotId'] as const;
  const identifiers=new Map<string,string>();
  for(const e of report.events) for(const key of keys) if(e[key]) identifiers.set(e[key]!,pseudo(e[key]!));
  for(const section of report.sections) {
    identifiers.set(section.id,pseudo(section.id));
    for(const f of section.fields) if(f.sensitivity==='identifier'&&f.value!==null) identifiers.set(String(f.value),pseudo(String(f.value)));
  }
  for(const e of report.events) for(const f of e.fields) if(f.sensitivity==='identifier'&&f.value!==null) identifiers.set(String(f.value),pseudo(String(f.value)));
  const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const alternatives=[...identifiers.keys()].sort((a,b)=>b.length-a.length).map(escape).join('|');
  const references=alternatives?new RegExp(`(?<![a-zA-Z0-9])(?:${alternatives})(?![a-zA-Z0-9])`,'g'):null;
  const replace=(s:string)=>{
    if(identifiers.has(s))return identifiers.get(s)!;
    // Preserve dates and canonical hashes; replace even short IDs in surrounding prose.
    return s.split(/(\b\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?Z)?\b|\b[a-f0-9]{64}\b)/g)
      .map((part,index)=>index%2||!references?part:part.replace(references,id=>identifiers.get(id)!)).join('');
  };
  const fields=(rows:DiagnosticField[])=>rows.map(f=>({...f,key:replace(f.key),label:replace(f.label),value:f.sensitivity==='financial'||f.sensitivity==='untrusted'?'[POMINIĘTO W EKSPORCIE]':
    f.sensitivity==='identifier'&&f.value!==null?pseudo(String(f.value)):typeof f.value==='string'?replace(f.value):f.value}));
  report.events=report.events.map(event=>{
    const e:DiagnosticEvent={...event,auditRef:null,reason:replace(event.reason),message:replace(event.message),impact:replace(event.impact),action:replace(event.action),fields:fields(event.fields)};
    for(const key of keys) { const value=e[key]; if(value!==null) e[key]=pseudo(value); }
    return e;
  });
  report.sections=report.sections.map(s=>({...s,id:pseudo(s.id),title:replace(s.title),fields:fields(s.fields)}));
  report.coverage=report.coverage.map(c=>({...c,source:replace(c.source),reasons:c.reasons.map(replace)}));
  report.counters=report.counters.map(c=>({...c,key:replace(c.key),label:replace(c.label)}));
  report.omissions=report.omissions.map(replace);
  report.omissions.push('EXPORT_REDACTED_IDENTIFIERS_FINANCIAL_UNTRUSTED_AUDIT_LINKS');
  return report;
}
export function boundDiagnosticReport(input: DiagnosticReport, maxBytes=DIAGNOSTIC_LIMITS.maxResponseBytes): DiagnosticReport {
  const report=structuredClone(input);
  const capped=(reason:string)=>{report.truncated=true;report.omissions.push(reason);};
  if(report.events.length>1000){report.events.length=1000;capped('EVENT_ARRAY_LIMIT');}
  if(report.sections.length>1000){report.sections.length=1000;capped('SECTION_ARRAY_LIMIT');}
  if(report.counters.length>1000){report.counters.length=1000;capped('COUNTER_ARRAY_LIMIT');}
  for(const row of [...report.events,...report.sections]) if(row.fields.length>200){row.fields.length=200;capped('FIELD_ARRAY_LIMIT');}
  for(const row of report.coverage)if(row.reasons.length>100){row.reasons.length=100;capped('COVERAGE_REASON_LIMIT');}
  if(report.coverage.length>100){
    const priority={UNAVAILABLE:0,PARTIAL:1,COMPLETE:2};
    report.coverage.sort((a,b)=>priority[a.status]-priority[b.status]);
    report.coverage.length=99;
    report.coverage.push({source:'report_limits',status:'PARTIAL',observedAt:report.generatedAt,earliestAvailableAt:null,reasons:['COVERAGE_ARRAY_LIMIT']});
    capped('COVERAGE_ARRAY_LIMIT');
  }
  report.omissions=[...new Set(report.omissions)];
  if(report.omissions.length>99){report.omissions.length=99;report.omissions.push('OMISSION_ARRAY_LIMIT');report.truncated=true;}
  const fits=()=>Buffer.byteLength(JSON.stringify(report))<=maxBytes;
  if(fits()) return report;
  report.truncated=true;
  report.omissions=report.omissions.slice(0,99);report.omissions.push('RESPONSE_SIZE_LIMIT');
  const trim=<T>(rows:T[],assign:(rows:T[])=>void):boolean=>{
    assign([]);
    if(!fits()) return false;
    let low=0,high=rows.length;
    while(low<high){const count=Math.ceil((low+high)/2);assign(rows.slice(0,count));if(fits())low=count;else high=count-1;}
    assign(rows.slice(0,low));return true;
  };
  if(trim(report.events,rows=>{report.events=rows;}) || trim(report.sections,rows=>{report.sections=rows;}) ||
      trim(report.counters,rows=>{report.counters=rows;})) return report;
  throw Error('DIAGNOSTIC_SIZE_LIMIT');
}
