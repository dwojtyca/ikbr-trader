import { randomUUID } from 'node:crypto';
import { compactDiagnosticEvents, describeDiagnosticReason, EMPTY_DIAGNOSTIC_IDENTITY, safeDiagnosticText,
  type DiagnosticEvaluationInput, type DiagnosticHeartbeatInput, type DiagnosticEvent } from '@ikbr/shared/diagnostics';
import type { TradingLoopCycleReport, TradingLoopInstrumentReport } from './types.js';

export interface DiagnosticLoopSink {
  heartbeat(input: DiagnosticHeartbeatInput): Promise<void>;
  recordEvaluation(input: DiagnosticEvaluationInput): Promise<{id:string;recordedAt:Date}|null>;
}
export interface DiagnosticLoopIdentity {
  configHash: string | null; conId: string | null; symbol: string | null; listing: string | null;
  implementationId: string | null; instanceId: string | null; revision: number | null;
  assignedInstances?: readonly {implementationId:string;instanceId:string;revision:number}[];
}

export class DiagnosticLoopRecorder {
  readonly processId = randomUUID();
  readonly startedAt: Date;
  private pending = false;
  private failedSince: Date | null = null;
  private failureCount = 0;
  private readonly lastLogged = new Map<string,{key:string;pending:DiagnosticEvent[]}>();
  constructor(private readonly options: {
    sink: DiagnosticLoopSink; accountId(): string | null; identity(instrumentId: string): DiagnosticLoopIdentity;
    secrets?: readonly string[];
    intervalMs: number; enabled: boolean; logger: { error(fields:object,message:string):void; info(fields:object,message:string):void };
    clock?: () => Date;
  }) { this.startedAt=(options.clock??(()=>new Date()))(); }

  async announceStart():Promise<void> {
    const accountId=this.options.accountId();
    if(!accountId){this.markFailure(this.startedAt);return;}
    try { await this.options.sink.heartbeat({accountId,processId:this.processId,startedAt:this.startedAt,
      seenAt:this.startedAt,expectedIntervalMs:this.options.intervalMs,enabled:this.options.enabled,
      failedSince:this.failedSince,failureCount:this.failureCount});
    } catch { this.markFailure(this.startedAt); }
  }

  async capture(cycle: TradingLoopCycleReport): Promise<void> {
    if(this.pending){this.markFailure(cycle.startedAt);return;}
    this.pending=true;
    const accountId=this.options.accountId();
    if(!accountId){this.markFailure(cycle.startedAt);this.pending=false;return;}
    try {
      for(const report of cycle.reports) {
        const input=this.map(report,accountId);
        const stored=await this.options.sink.recordEvaluation(input);
        if(!stored) throw Error('DIAGNOSTIC_CAPACITY_EXHAUSTED');
        this.logEvaluation(input,stored);
      }
      const pulse:DiagnosticHeartbeatInput={accountId,processId:this.processId,startedAt:this.startedAt,
        seenAt:cycle.finishedAt,expectedIntervalMs:this.options.intervalMs,enabled:this.options.enabled,
        failedSince:this.failedSince,failureCount:this.failureCount};
      await this.options.sink.heartbeat(pulse);
      this.failedSince=null;this.failureCount=0;
    } catch { this.markFailure(cycle.startedAt); }
    finally { this.pending=false; }
  }

  failed(at:Date):void { this.markFailure(at); }

  private markFailure(at:Date):void {
    this.failedSince??=at;
    this.failureCount++;
    this.flush();
    const diagnostic:DiagnosticEvent={...EMPTY_DIAGNOSTIC_IDENTITY,schemaVersion:1,
      id:`diagnostic_sink:${this.processId}:${this.failureCount}`,code:'DIAGNOSTIC_SINK_UNAVAILABLE',
      severity:'CRITICAL',service:'signal-engine',occurredAt:at.toISOString(),recordedAt:at.toISOString(),
      reason:'DIAGNOSTIC_SINK_UNAVAILABLE',message:'Zapis diagnostyczny jest niedostępny; pokrycie ocen jest niepełne.',
      impact:'Nie można potwierdzić trwałości zapisu. To zdarzenie istnieje tylko w konsoli.',
      action:'Sprawdź połączenie z bazą i raport pokrycia po odzyskaniu zapisu.',auditRef:null,
      fields:[{key:'processId',label:'Proces',value:this.processId,sensitivity:'identifier'},
        {key:'failedSince',label:'Początek braku zapisu',value:this.failedSince.toISOString()},
        {key:'failureCount',label:'Liczba nieudanych zapisów',value:this.failureCount}]};
    this.options.logger.error({diagnostic},diagnostic.message);
  }

  private map(report:TradingLoopInstrumentReport,accountId:string):DiagnosticEvaluationInput {
    const identity=this.options.identity(report.instrumentId);
    const outcome=report.outcome;
    const runtime='runtime' in outcome?outcome.runtime:null;
    const reason=(runtime?.outcome==='NOT_SUBMITTED'?runtime.denialReason:undefined) ?? (outcome.kind==='CONFIGURED_EVALUATION'
      ? outcome.evaluation.kind==='no_signal'?'NO_SIGNAL':outcome.evaluation.reasons[0] ?? outcome.evaluation.kind.toUpperCase()
      : 'reason' in outcome ? outcome.reason : outcome.kind);
    const evaluation=report.evaluation ?? (outcome.kind==='CONFIGURED_EVALUATION'?outcome.evaluation:null);
    const attribution=evaluation?.strategyAttribution;
    const linked=runtime?.outcome==='SUBMITTED'?runtime.execution.orderId:
      runtime?.outcome==='DUPLICATE'?proposalId(runtime.previousExecution):
      runtime?.outcome==='PENDING'||runtime?.outcome==='AWAITING_AI'?proposalId(runtime.previousOrder):null;
    const privacy={accountIds:[accountId],secrets:this.options.secrets??[]};
    return {accountId,processId:this.processId,cycleId:report.cycleId,instrumentId:report.instrumentId,
      occurredAt:report.finishedAt,outcome:outcome.kind,
      evaluationKind:evaluation?.kind??null,
      reason:safeDiagnosticText(reason,privacy),
      reasons:(outcome.kind==='CONFIGURED_EVALUATION'?outcome.evaluation.reasons:[reason])
        .map(value=>safeDiagnosticText(value,privacy)),
      entryBlockers:(outcome.kind==='CONFIGURED_EVALUATION'?outcome.evaluation.entryBlockers:[])
        .map(value=>safeDiagnosticText(value,privacy)),
      assignedInstances:identity.assignedInstances??[],
      configHash:attribution?.effectiveConfigHash??identity.configHash,
      conId:identity.conId,symbol:identity.symbol,listing:identity.listing,
      implementationId:attribution?.implementationId??identity.implementationId,
      instanceId:attribution?.instanceId??identity.instanceId,
      revision:attribution?.instanceRevision??identity.revision,
      evaluationId:report.cycleId,proposalId:linked};
  }

  private logEvaluation(input:DiagnosticEvaluationInput,stored:{id:string;recordedAt:Date}):void {
    const severity=input.outcome==='ERROR'||input.outcome==='UNKNOWN'||input.evaluationKind==='error'?'CRITICAL':input.outcome==='SKIPPED'?'WARN':'INFO';
    const described=describeDiagnosticReason(input.reason);
    const diagnostic:DiagnosticEvent={...EMPTY_DIAGNOSTIC_IDENTITY,schemaVersion:1,
      id:`diagnostic_evaluations:${stored.id}`,code:input.outcome,severity,service:'signal-engine',
      occurredAt:input.occurredAt.toISOString(),recordedAt:stored.recordedAt.toISOString(),reason:input.reason,
      ...described,instrumentId:input.instrumentId,conId:input.conId??null,symbol:input.symbol??null,
      listing:input.listing??null,implementationId:input.implementationId??null,instanceId:input.instanceId??null,
      revision:input.revision??null,configHash:input.configHash??null,evaluationId:input.evaluationId??null,
      traceId:input.cycleId,proposalId:input.proposalId===null||input.proposalId===undefined?null:String(input.proposalId),
      auditRef:null,fields:[{key:'reasons',label:'Powody',value:input.reasons?.join(', ')??null,sensitivity:'untrusted'},
        {key:'entryBlockers',label:'Blokady wejścia',value:input.entryBlockers?.join(', ')??null,sensitivity:'untrusted'}]};
    const key=JSON.stringify({...diagnostic,id:null,occurredAt:null,recordedAt:null,evaluationId:null,traceId:null});
    const prior=this.lastLogged.get(input.instrumentId);
    if(severity==='INFO'&&prior?.key===key) {
      prior.pending.push(diagnostic);
      if(prior.pending.length>=9)this.flushInstrument(input.instrumentId);
      return;
    }
    this.flushInstrument(input.instrumentId);
    if(this.lastLogged.size>=100&&!this.lastLogged.has(input.instrumentId)) {
      const oldest=this.lastLogged.keys().next().value!;
      this.flushInstrument(oldest);this.lastLogged.delete(oldest);
    }
    if(severity==='INFO')this.lastLogged.set(input.instrumentId,{key,pending:[]});
    else this.lastLogged.delete(input.instrumentId);
    if(severity==='CRITICAL')this.options.logger.error({diagnostic},diagnostic.message);
    else this.options.logger.info({diagnostic},diagnostic.message);
  }

  private flushInstrument(instrumentId:string):void {
    const prior=this.lastLogged.get(instrumentId);
    if(!prior?.pending.length)return;
    for(const diagnostic of compactDiagnosticEvents(prior.pending).events) {
      this.options.logger.info({diagnostic},diagnostic.message);
    }
    prior.pending=[];
  }

  flush():void { for(const instrumentId of this.lastLogged.keys())this.flushInstrument(instrumentId); }
}

function proposalId(value:unknown):number|null {
  if(!value||typeof value!=='object')return null;
  const id=(value as {id?:unknown}).id;
  return typeof id==='number'&&Number.isSafeInteger(id)&&id>0?id:null;
}
