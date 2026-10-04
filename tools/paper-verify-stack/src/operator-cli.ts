import { readFile, open } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { boundDiagnosticReport, redactDiagnosticExport, parseDiagnosticQuery, safeDiagnosticText,
  formatDiagnosticReport, formatDiagnosticEvent, sanitizeDiagnosticReport, DIAGNOSTIC_LIMITS, type DiagnosticReport } from '@ikbr/shared/diagnostics';
import { OperatorClient, OperatorRequestError } from './operator-client.js';
import { OperatorFollowState } from './operator-follow.js';
export const operatorHelp=`Obsługa bota bez przeglądarki (odczyt):
  pnpm paper:ops --env-file .env status [--instrument pko_wse]
  pnpm paper:ops --env-file .env logs [--follow] [--reason NO_STRATEGY_SIGNAL]
  pnpm paper:ops --env-file .env trace --proposal 42
  pnpm paper:ops --env-file .env trace --evaluation UUID
  pnpm paper:ops --env-file .env session --from 2026-10-04T07:00:00Z --to 2026-10-04T15:00:00Z
  pnpm paper:ops --env-file .env export --from UTC --to UTC --output diagnostyka.txt [--json]
Filtry: --instrument ID --reason KOD --severity INFO|WARN|ERROR|CRITICAL --from UTC --to UTC --limit 1..1000
Wyświetlanie: --json lub polski tekst; --timezone Europe/Warsaw. Domyślnie ostatnia godzina, 200 zdarzeń.
Token wyłącznie z EXECUTION_API_TOKEN lub wskazanego --env-file; nigdy jako argument.
Kontrole PP5 (osobne, uwierzytelnione; nie ponawiaj po nieznanym wyniku):
  control supervision
  control pause --reason 'przyczyna'
  control resume --reason 'przyczyna'       (nie omija istniejących bramek)
  control close --proposal 42 --request-id UUID --limit-price CENA
  control reconcile --proposal 42
Pauza wejść nie zatrzymuje automatycznych wyjść. Raport nie zezwala na handel.
`;
export async function writeDiagnosticExport(path:string,content:string):Promise<void> {
  if(Buffer.byteLength(content)>DIAGNOSTIC_LIMITS.maxExportBytes) throw Error('EXPORT_SIZE_LIMIT');
  const file=await open(path,'wx',0o600);
  try { await file.writeFile(content,'utf8'); await file.sync(); } finally { await file.close(); }
}
export function renderBoundedExport(input:DiagnosticReport,json:boolean,timeZone:string):string {
  const report=boundDiagnosticReport(input,DIAGNOSTIC_LIMITS.maxExportBytes-16384);
  const render=()=>json?JSON.stringify(report,null,2)+'\n':formatDiagnosticReport(report,{timeZone})+'\n';
  let content=render();
  const fits=()=>{content=render();return Buffer.byteLength(content)<=DIAGNOSTIC_LIMITS.maxExportBytes;};
  if(Buffer.byteLength(content)<=DIAGNOSTIC_LIMITS.maxExportBytes)return content;
  report.truncated=true;report.omissions=[...new Set([...report.omissions,'EXPORT_RENDER_SIZE_LIMIT'])];
  const trim=<T>(rows:T[],assign:(rows:T[])=>void):boolean=>{
    assign([]);if(!fits())return false;
    let low=0,high=rows.length;
    while(low<high){const count=Math.ceil((low+high)/2);assign(rows.slice(0,count));if(fits())low=count;else high=count-1;}
    assign(rows.slice(0,low));fits();return true;
  };
  if(trim(report.events,rows=>{report.events=rows;})||trim(report.sections,rows=>{report.sections=rows;})||
    trim(report.counters,rows=>{report.counters=rows;}))return content;
  throw Error('EXPORT_SIZE_LIMIT');
}
export function appendLiveSupervision(report:DiagnosticReport,raw:unknown):DiagnosticReport {
  const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
  const value=object(raw),observer=object(value?.observer);
  report.sections.push({id:'live-supervision',title:'Bieżący nadzór PP5',instrumentId:null,fields:[
    {key:'healthy',label:'Zdrowie obserwatora',value:typeof observer?.healthy==='boolean'?observer.healthy:null},
    {key:'reason',label:'Powód nadzoru',value:typeof observer?.reason==='string'?observer.reason:null,sensitivity:'untrusted'},
    {key:'running',label:'Trwa obserwacja',value:typeof observer?.running==='boolean'?observer.running:null},
    {key:'tradingEnabled',label:'Zapisy master',value:typeof value?.tradingEnabled==='boolean'?value.tradingEnabled:null},
    {key:'automationEnabled',label:'Automatyczne wyjścia',value:typeof value?.automationEnabled==='boolean'?value.automationEnabled:null},
  ]});
  report.coverage.push({source:'live_supervision',status:observer?'PARTIAL':'UNAVAILABLE',observedAt:report.generatedAt,earliestAvailableAt:null,reasons:['CURRENT_PROCESS_OBSERVATION_NOT_BROKER_PROOF']});
  return sanitizeDiagnosticReport(report);
}
export async function runOperatorCli(args:string[],env:NodeJS.ProcessEnv=process.env):Promise<void> {
  const {values,positionals}=parseArgs({args,allowPositionals:true,options:{
    help:{type:'boolean'},json:{type:'boolean'},follow:{type:'boolean'},'env-file':{type:'string'},'base-url':{type:'string'},
    instrument:{type:'string'},reason:{type:'string'},severity:{type:'string'},from:{type:'string'},to:{type:'string'},limit:{type:'string'},
    proposal:{type:'string'},evaluation:{type:'string'},output:{type:'string'},timezone:{type:'string'},'request-id':{type:'string'},'limit-price':{type:'string'},
  }});
  if(values.help||!positionals.length) { process.stdout.write(operatorHelp); return; }
  const command=positionals[0];
  if(!['logs','status','trace','session','export','control'].includes(command)||positionals.length>(command==='control'?2:1)) throw Error('OPERATOR_COMMAND_INVALID');
  if(values.follow&&values.to) throw Error('FOLLOW_FIXED_END_NOT_ALLOWED');
  if(values.follow&&command!=='logs'||values.output&&command!=='export') throw Error('OPERATOR_ARGUMENTS_INVALID');
  if(command==='export'&&(!values.from||!values.to||!values.output)) throw Error('EXPORT_INTERVAL_OUTPUT_REQUIRED');
  const timeZone=values.timezone??'Europe/Warsaw'; new Intl.DateTimeFormat('pl-PL',{timeZone});
  const fileEnv=values['env-file']?parseEnv(await readFile(values['env-file'],'utf8')):{};
  const token=env.EXECUTION_API_TOKEN??fileEnv.EXECUTION_API_TOKEN??'';
  const client=new OperatorClient({token,origin:values['base-url']??env.PAPER_OPS_BASE_URL??fileEnv.PAPER_OPS_BASE_URL});
  if(command==='control') {
    const action=positionals[1];
    if(action==='pause'||action==='resume') await client.control({action,reason:values.reason??''});
    else if(action==='close') await client.control({action,proposalId:values.proposal??'',requestId:values['request-id']??'',limitPrice:Number(values['limit-price'])});
    else if(action==='reconcile') await client.control({action,proposalId:values.proposal??''});
    else if(action==='supervision') {
      const live=await client.control({action:'supervision'});
      const report=appendLiveSupervision(await client.report(parseDiagnosticQuery({mode:'status'})),live);
      process.stdout.write(values.json?JSON.stringify(report)+'\n':formatDiagnosticReport(report,{timeZone})+'\n'); return;
    } else throw Error('OPERATOR_CONTROL_INVALID');
    process.stdout.write('Żądanie przyjęte przez API. Potwierdź stan poleceniem status lub trace; odpowiedź nie oznacza realizacji zlecenia.\n'); return;
  }
  const query:Record<string,unknown>={mode:command==='trace'?'timeline':command==='logs'||command==='export'?'events':command};
  for(const [flag,key] of Object.entries({from:'from',to:'to',limit:'limit',instrument:'instrumentId',reason:'reason',severity:'severity',proposal:'proposalId',evaluation:'evaluationId'})) {
    const value=values[flag as keyof typeof values]; if(value!==undefined) query[key]=value;
  }
  let parsed=parseDiagnosticQuery(query); const report=await client.report(parsed);
  if(command==='export') {
    const redacted=redactDiagnosticExport(report,{secrets:[token]});
    const content=renderBoundedExport(redacted,Boolean(values.json),timeZone);
    await writeDiagnosticExport(values.output!,content);
    process.stdout.write('Zapisano ograniczoną, zanonimizowaną diagnostykę (uprawnienia 0600). Pominięcia są opisane w pliku.\n');return;
  }
  process.stdout.write(values.json?JSON.stringify(report)+'\n':formatDiagnosticReport(report,{timeZone})+'\n');
  if(!values.follow) return;
  if(values.to) throw Error('FOLLOW_FIXED_END_NOT_ALLOWED');
  let stopped=false,reconnecting=false; const stop=()=>{stopped=true;}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const state=new OperatorFollowState(report);
  const outputEvents=(events:ReturnType<OperatorFollowState['flush']>)=>{
    for(const event of events) process.stdout.write(values.json?JSON.stringify(event)+'\n':formatDiagnosticEvent(event,{timeZone})+'\n');
  };
  const notice=(code:string,message:string)=>process.stdout.write(values.json?JSON.stringify({schemaVersion:1,code,severity:'WARN',occurredAt:new Date().toISOString(),message})+'\n':message+'\n');
  try {
    while(!stopped) {
      await delay(5000); if(stopped) break;
      const now=Date.now(); parsed={...parsed,from:new Date(Math.max(Date.parse(query.from as string??parsed.from),now-300000)).toISOString(),to:new Date(now).toISOString()};
      try {
        const next=await client.report(parsed);
        if(reconnecting) notice('READER_RECONNECTED','Połączenie przywrócone. Odtworzono okno do 5 minut; wcześniejsza przerwa wymaga raportu sesji.');
        reconnecting=false;
        const observed=state.observe(next);
        if(observed.coverageChanged) {
          const coverageReport={...next,events:[],sections:[],counters:[]};
          process.stdout.write(values.json?JSON.stringify(coverageReport)+'\n':formatDiagnosticReport(coverageReport,{timeZone})+'\n');
        }
        for(const event of observed.events) outputEvents(values.json?[event]:state.compact(event,now));
      } catch { reconnecting=true;outputEvents(state.flush());notice('READER_DISCONNECTED','BRAK DANYCH: odczyt przerwany. Ponowne połączenie dotyczy wyłącznie odczytu; kompletność niepotwierdzona.'); }

    }
  } finally { outputEvents(state.flush());process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  runOperatorCli(process.argv.slice(2)).catch(error=>{
    const unknown=error instanceof OperatorRequestError&&error.mutation;
    process.stderr.write(unknown?'Wynik operacji niepotwierdzony. Nie ponawiaj żądania; sprawdź zapisany stan i uzgodnienie brokera.\n':
      `Nie można wykonać polecenia. ${safeDiagnosticText(error instanceof OperatorRequestError?`${error.code}${error.status?` HTTP ${error.status}`:''}`:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'OPERATOR_ERROR')}\n`);
    process.exitCode=1;
  });
}
