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
