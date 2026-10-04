import { DIAGNOSTIC_LIMITS, parseDiagnosticReport, type DiagnosticQuery, type DiagnosticReport } from '@ikbr/shared/diagnostics';
export function operatorOrigin(raw='http://127.0.0.1:3103'): string {
  let url: URL; try { url=new URL(raw); } catch { throw Error('OPERATOR_ORIGIN_INVALID'); }
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]','execution-engine'].includes(url.hostname)||url.port!=='3103'||
    url.username||url.password||url.search||url.hash||url.pathname!=='/') throw Error('OPERATOR_ORIGIN_INVALID');
  return url.origin;
}
export class OperatorRequestError extends Error {
  constructor(readonly code:string,readonly mutation:boolean,readonly status:number|null=null) { super(code); }
}
export interface OperatorClientOptions { token:string; origin?:string; fetchImpl?:typeof fetch; timeoutMs?:number; }
export class OperatorClient {
  private readonly origin:string;
  constructor(private readonly options:OperatorClientOptions) {
    this.origin=operatorOrigin(options.origin);
    if(!options.token||/\s/.test(options.token)) throw Error('OPERATOR_TOKEN_REQUIRED');
  }
  private async request(path:string,body?:unknown):Promise<unknown> {
    const mutation=body!==undefined;
    try {
      const response=await (this.options.fetchImpl??fetch)(`${this.origin}${path}`,{method:mutation?'POST':'GET',
        headers:{Authorization:`Bearer ${this.options.token}`,...(mutation?{'Content-Type':'application/json'}:{})},
        ...(mutation?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(this.options.timeoutMs??5000)});
      if(!response.ok) throw new OperatorRequestError('OPERATOR_HTTP_ERROR',mutation,response.status);
      if(!response.body) throw new OperatorRequestError('OPERATOR_BODY_MISSING',mutation);
      const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
      try {
        for(;;) { const read=await reader.read(); if(read.done) break; size+=read.value.byteLength;
          if(size>DIAGNOSTIC_LIMITS.maxResponseBytes) { await reader.cancel(); throw new OperatorRequestError('OPERATOR_RESPONSE_TOO_LARGE',mutation); }
          chunks.push(read.value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch(error) { if(error instanceof OperatorRequestError) throw error; throw new OperatorRequestError('OPERATOR_OUTCOME_UNAVAILABLE',mutation); }
  }
  async report(query:DiagnosticQuery):Promise<DiagnosticReport> {
    const params=new URLSearchParams(Object.entries(query).map(([key,value])=>[key,String(value)]));
    return parseDiagnosticReport(await this.request(`/execution/diagnostics?${params}`));
  }
  async control(input: { action:'pause'|'resume'; reason:string } | { action:'close'; proposalId:string; requestId:string; limitPrice:number } |
    { action:'reconcile'; proposalId:string } | {action:'supervision'}):Promise<unknown> {
    if(input.action==='supervision') return this.request('/execution/lifecycle/supervision');
    if(input.action==='pause'||input.action==='resume') {
      if(!input.reason.trim()||input.reason.length>500||/[\u0000-\u001f\u007f]/.test(input.reason)) throw Error('OPERATOR_REASON_REQUIRED');
      return this.request(`/execution/entry-control/${input.action}`,{reason:input.reason});
    }
    if(!('proposalId' in input)||!/^[1-9]\d{0,14}$/.test(input.proposalId)) throw Error('OPERATOR_PROPOSAL_REQUIRED');
    if(input.action==='reconcile') return this.request(`/execution/lifecycle/${input.proposalId}/close/reconcile`,{});
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)||!Number.isFinite(input.limitPrice)||input.limitPrice<=0) throw Error('OPERATOR_CLOSE_ARGUMENTS_REQUIRED');
    return this.request(`/execution/lifecycle/${input.proposalId}/close`,{requestId:input.requestId,limitPrice:input.limitPrice});
  }
}
