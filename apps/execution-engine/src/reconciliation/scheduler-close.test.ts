import assert from "node:assert/strict";
import { test } from "node:test";
import { ReconciliationScheduler, type SchedulerConfig } from "./scheduler.js";
import type { ReconciliationRunner, RunReport, RunnerContext } from "./runner.js";

const config: SchedulerConfig = {enabled:true,intervalMs:1000,startupDelayMs:0,minIntervalMs:0,
  sourceTimeoutMs:100,runTimeoutMs:100,executionSafetyMarginMs:0};
const logger = {info:()=>{},warn:()=>{},error:()=>{}};
const context = {currentContext:()=>({accountId:"PAPER",sessionId:"session",sessionStartedAt:new Date()}) as RunnerContext};
test("triggerFresh waits for prior capture and begins a separate run", async () => {
  const completions: Array<(report:RunReport|null)=>void> = [];
  let captures=0;
  const runner = {runOnce:()=>{captures++;return new Promise<RunReport|null>(resolve=>completions.push(resolve));}};
  const scheduler = new ReconciliationScheduler(runner as unknown as ReconciliationRunner,context,config,logger);
  const first=scheduler.triggerNow();
  const fresh=scheduler.triggerFresh();
  assert.equal(captures,1);
  completions[0]!(null);
  await first;
  assert.equal(captures,2);
  completions[1]!(null);
  await fresh;
  await scheduler.stop();
});
test("triggerFresh never starts another capture after stop", async () => {
  let finish!: (report:RunReport|null)=>void;
  let captures=0;
  const runner = {runOnce:()=>{captures++;return new Promise<RunReport|null>(resolve=>{finish=resolve;});}};
  const scheduler = new ReconciliationScheduler(runner as unknown as ReconciliationRunner,context,config,logger);
  const first=scheduler.triggerNow();
  const fresh=scheduler.triggerFresh();
  const stopped=scheduler.stop();
  finish(null);
  await Promise.all([first,fresh,stopped]);
  assert.equal(captures,1);
});
test('multiple fresh waiters each acquire a post-request capture without overlap', async () => {
  const completions: Array<(value: RunReport | null) => void> = [];
  let captures = 0;
  const runner = { runOnce: () => { captures++; return new Promise<RunReport | null>(resolve => completions.push(resolve)); } };
  const scheduler = new ReconciliationScheduler(runner as unknown as ReconciliationRunner, context, config, logger);
  const first = scheduler.triggerNow(), fresh1 = scheduler.triggerFresh(), fresh2 = scheduler.triggerFresh();
  assert.equal(captures, 1); completions[0](null); await first;
  assert.equal(captures, 2); completions[1](null); await fresh1;
  assert.equal(captures, 3); completions[2](null); await fresh2; await scheduler.stop();
});
test('stop before delayed startup and duplicate start leave no periodic work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let captures = 0;
  const scheduler = new ReconciliationScheduler({ runOnce: async () => { captures++; return null; } } as unknown as ReconciliationRunner,
    context, { ...config, startupDelayMs: 100 }, logger);
  scheduler.start(); scheduler.start(); await scheduler.stop(); t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(captures, 0);
});
test('synchronous acquisition failure cannot leave a settled in-flight promise blocking fresh callers', async () => {
  let captures = 0;
  const scheduler = new ReconciliationScheduler({ runOnce: () => { captures++; throw new Error('source failed'); } } as unknown as ReconciliationRunner,
    context, config, logger);
  await scheduler.triggerNow(); await scheduler.triggerFresh(); await scheduler.stop(); assert.equal(captures, 2);
});
