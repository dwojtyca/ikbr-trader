import { describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type DiagnosticEvent } from '@ikbr/shared/diagnostics';
import { DiagnosticLoopRecorder, type DiagnosticLoopSink } from './diagnostics.js';
import type { TradingLoopCycleReport } from './types.js';

const now=new Date('2026-10-04T08:00:00.000Z');
const cycle=(id=randomUUID()):TradingLoopCycleReport=>({cycleId:id,startedAt:now,finishedAt:now,durationMs:0,
  reports:[{cycleId:id,instrumentId:'pko_wse',startedAt:now,finishedAt:now,durationMs:0,
    outcome:{kind:'CONFIGURED_EVALUATION',instrumentId:'pko_wse',evaluation:{kind:'no_signal',instrumentId:'pko_wse',
      reasons:['RSI_TOO_HIGH'],entryAllowed:false,entryBlockers:['PP4_RESEARCH_UNAVAILABLE']}}}]});
const identity=()=>({configHash:'a'.repeat(64),conId:'123',symbol:'PKO',listing:'WSE',implementationId:null,
  instanceId:null,revision:null,assignedInstances:[{implementationId:'momentum_breakout_long_v1',instanceId:'pko_momo',revision:1}]});

describe('diagnostic loop recorder',()=>{
  it('preserves no-signal reasons/blockers and writes heartbeat after evaluation',async()=>{
    const order:string[]=[];const seen:unknown[]=[];const logged:object[]=[];
    const sink:DiagnosticLoopSink={recordEvaluation:async input=>{order.push('evaluation');seen.push(input);return {id:'1',recordedAt:now};},
      heartbeat:async()=>{order.push('heartbeat');}};
    const recorder=new DiagnosticLoopRecorder({sink,accountId:()=> 'paper-fixture',identity,intervalMs:5000,enabled:true,
      logger:{error:()=>undefined,info:fields=>logged.push(fields)}});
    await recorder.capture(cycle());
    assert.deepEqual(order,['evaluation','heartbeat']);
    assert.equal((seen[0] as {reason:string}).reason,'NO_SIGNAL');
    assert.deepEqual((seen[0] as {reasons:string[]}).reasons,['RSI_TOO_HIGH']);
    assert.deepEqual((seen[0] as {entryBlockers:string[]}).entryBlockers,['PP4_RESEARCH_UNAVAILABLE']);
    assert.equal((seen[0] as {assignedInstances:unknown[]}).assignedInstances.length,1);
    assert.equal(((logged[0] as {diagnostic:{id:string}}).diagnostic).id,'diagnostic_evaluations:1');
  });
  it('records recovery gap after poisoned sink and never emits success for failed row',async()=>{
    let fail=true;const pulse:unknown[]=[];const logs:object[]=[];
    const sink:DiagnosticLoopSink={recordEvaluation:async()=>{if(fail)throw Error('secret password');return {id:'2',recordedAt:now};},
      heartbeat:async input=>{pulse.push(input);}};
    const recorder=new DiagnosticLoopRecorder({sink,accountId:()=> 'paper-fixture',identity,intervalMs:5000,enabled:true,
      logger:{error:fields=>logs.push(fields),info:fields=>logs.push(fields)}});
    await recorder.capture(cycle());
    assert.equal(pulse.length,0);
    assert.equal(logs.length,1);
    assert.equal(JSON.stringify(logs).includes('secret'),false);
    fail=false;await recorder.capture(cycle());
    assert.equal(pulse.length,1);
    assert.ok((pulse[0] as {failedSince:Date}).failedSince instanceof Date);
  });
  it('drops overlap with an explicit failure instead of queueing writes',async()=>{
    let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
    let calls=0;const errors:object[]=[];
    const sink:DiagnosticLoopSink={recordEvaluation:async()=>{calls++;await barrier;return {id:'3',recordedAt:now};},
      heartbeat:async()=>undefined};
    const recorder=new DiagnosticLoopRecorder({sink,accountId:()=> 'paper-fixture',identity,intervalMs:5000,enabled:true,
      logger:{error:fields=>errors.push(fields),info:()=>undefined}});
    const first=recorder.capture(cycle());
    await recorder.capture(cycle());
    release();await first;
    assert.equal(calls,1);
    assert.equal(errors.length,1);
  });
  it('compacts only unchanged INFO and flushes all IDs/counts on a configuration change',async()=>{
    let revision=1,sequence=0;const logged:DiagnosticEvent[]=[];
    const sink:DiagnosticLoopSink={recordEvaluation:async()=>({id:String(++sequence),recordedAt:now}),heartbeat:async()=>undefined};
    const recorder=new DiagnosticLoopRecorder({sink,accountId:()=> 'paper-fixture',identity:()=>({...identity(),revision}),intervalMs:5000,enabled:true,
      logger:{error:()=>undefined,info:fields=>logged.push((fields as {diagnostic:DiagnosticEvent}).diagnostic)}});
    for(let index=0;index<4;index++)await recorder.capture(cycle());
    assert.equal(logged.length,1);
    revision=2;await recorder.capture(cycle());
    assert.equal(logged.length,3);
    const summary=logged[1] as DiagnosticEvent&{count:number;sourceEventIds:string[];firstOccurredAt:string;lastOccurredAt:string};
    assert.equal(summary.count,3);assert.equal(summary.sourceEventIds.length,3);
    assert.equal(summary.firstOccurredAt,now.toISOString());assert.equal(summary.lastOccurredAt,now.toISOString());
    assert.equal(logged[2].revision,2);
    assert.equal(sequence,5);
  });
  it('never suppresses configured errors and redacts exact secrets before persistence',async()=>{
    const logs:DiagnosticEvent[]=[];const stored:unknown[]=[];
    const recorder=new DiagnosticLoopRecorder({sink:{recordEvaluation:async input=>{stored.push(input);return {id:String(stored.length),recordedAt:now};},heartbeat:async()=>undefined},
      accountId:()=> 'paper-fixture',identity,secrets:['raw-provider-credential'],intervalMs:5000,enabled:true,
      logger:{error:fields=>logs.push((fields as {diagnostic:DiagnosticEvent}).diagnostic),info:()=>undefined}});
    const original=cycle();const outcome=original.reports[0].outcome;
    assert.equal(outcome.kind,'CONFIGURED_EVALUATION');
    if(outcome.kind!=='CONFIGURED_EVALUATION')assert.fail('fixture must be configured');
    const bad:TradingLoopCycleReport={...original,reports:[{...original.reports[0],outcome:{...outcome,
      evaluation:{...outcome.evaluation,kind:'error',reasons:['raw-provider-credential']}}}]};
    await recorder.capture(bad);await recorder.capture(bad);
    assert.equal(logs.length,2);assert.ok(logs.every(event=>event.severity==='CRITICAL'));
    assert.doesNotMatch(JSON.stringify({stored,logs}),/raw-provider-credential/);
  });
});
