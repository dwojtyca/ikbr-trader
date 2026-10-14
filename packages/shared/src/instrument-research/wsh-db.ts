import {performance} from 'node:perf_hooks';
import type {ResearchConnection,ResearchPool} from './types.js';

const timeoutError=()=>new Error('RESEARCH_WSH_BOOKKEEPING_TIMEOUT');
export class WshBoundedConnection {
  readonly db:ResearchConnection;
  private released=false;
  private operationDeadline=Infinity;
  private attemptDeadline=Infinity;
  constructor(private readonly raw:ResearchConnection){
    this.db={query:async(sql,values)=>{
      const deadline=Math.min(this.operationDeadline,this.attemptDeadline,performance.now()+3000);
      if(this.released||deadline<=performance.now())throw timeoutError();
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{this.destroy();reject(timeoutError());},Math.max(1,deadline-performance.now()));
        void (async()=>{
          const remaining=Math.floor(deadline-performance.now());
          if(remaining<=0)throw timeoutError();
          await raw.query("SELECT set_config('statement_timeout',$1,false)",[String(remaining)]);
          if(this.released||performance.now()>=deadline)throw timeoutError();
          return raw.query(sql,values);
        })().then(value=>{if(this.released||performance.now()>=deadline){this.destroy();reject(timeoutError());}else resolve(value);},reject).finally(()=>clearTimeout(timer));
      });
    },release:()=>this.release()};
  }
  beginOperation(deadlineAt?:string,monotonicDeadline?:number):void{
    const now=performance.now();
    this.operationDeadline=Math.min(now+3000,monotonicDeadline??(deadlineAt?now+Date.parse(deadlineAt)-Date.now():Infinity));
  }
  endOperation():void{this.operationDeadline=Infinity;}
  startAttempt(remainingMs:number):void{this.attemptDeadline=Math.min(this.attemptDeadline,performance.now()+remainingMs);}
  destroy():void{if(!this.released){this.released=true;this.raw.release(true);}}
  release():void{if(!this.released){this.released=true;this.raw.release();}}
  get closed():boolean{return this.released;}
}
export async function connectWshBounded(pool:ResearchPool,deadlineAt?:string,monotonicDeadline?:number):Promise<WshBoundedConnection>{
  const now=performance.now();
  const deadline=Math.min(now+3000,monotonicDeadline??(deadlineAt?now+Date.parse(deadlineAt)-Date.now():Infinity));
  const remaining=deadline-performance.now();
  if(remaining<=0)throw timeoutError();
  let expired=false;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{expired=true;reject(timeoutError());},remaining);
    void pool.connect().then(raw=>{
      clearTimeout(timer);
      if(expired||performance.now()>=deadline){raw.release(true);reject(timeoutError());return;}
      const db=new WshBoundedConnection(raw);db.beginOperation(undefined,deadline);resolve(db);
    },error=>{clearTimeout(timer);reject(error);});
  });
}
