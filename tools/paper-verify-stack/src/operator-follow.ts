import {compactDiagnosticEvents,type DiagnosticEvent,type DiagnosticReport} from '@ikbr/shared/diagnostics';
export class OperatorFollowState {
 private readonly seen=new Map<string,string>();
 private coverageSignature='';
 private prior:DiagnosticEvent|null=null;
 private repeated:DiagnosticEvent[]=[];
 private flushedAt=0;
 constructor(report:DiagnosticReport) {this.observe(report);}
 observe(report:DiagnosticReport):{events:DiagnosticEvent[];coverageChanged:boolean} {
  const signature=JSON.stringify([report.coverage.map(c=>({source:c.source,status:c.status,reasons:c.reasons,earliestAvailableAt:c.earliestAvailableAt})),report.omissions,report.truncated]);
  const coverageChanged=signature!==this.coverageSignature;this.coverageSignature=signature;
  const events:DiagnosticEvent[]=[];
  for(const e of [...report.events].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id))) {
   // Proposal rows have no transition timestamp; polling time is not a new transition.
   const value=JSON.stringify(e.code==='CURRENT_PROPOSAL_SNAPSHOT'?{...e,occurredAt:null,recordedAt:null}:e);
   if(this.seen.get(e.id)===value)continue;this.seen.set(e.id,value);events.push(e);
  }
  while(this.seen.size>10000)this.seen.delete(this.seen.keys().next().value!);
  return {events,coverageChanged};
 }
 compact(event:DiagnosticEvent,now=Date.now()):DiagnosticEvent[] {
  if(this.prior) {
   const group=compactDiagnosticEvents([this.prior,event]);
   if(group.events.length===1&&'count' in group.events[0]&&group.events[0].count>1) {
    this.repeated.push(event);this.prior=event;
    if(this.repeated.length>=1000||now-this.flushedAt>=60000)return this.flush(now);
    return [];
   }
  }
  const result=this.flush(now);this.prior=event;return [...result,event];
 }
 flush(now=Date.now()):DiagnosticEvent[] {
  this.flushedAt=now;
  const result=compactDiagnosticEvents(this.repeated).events;
  this.repeated=[];return result;
 }
}
