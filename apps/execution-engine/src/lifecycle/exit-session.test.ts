import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstrumentSessionIdentity, type SessionScheduleEvidence } from '@ikbr/shared';
import { fixture } from './close-test-fixture.js';
import { deriveExitSession, tightenExitSession } from './exit-session.js';
function setup(start = '2026-11-27T14:30:00.000Z', end = '2026-11-27T18:00:00.000Z') {
  const bound = fixture().context.bound!; const now = Date.parse(start)+60000;
  const evidence: SessionScheduleEvidence = { generation: 1, status: 'READY', updatedAt: new Date(now).toISOString(), schedule: {
    source: 'ibkr_session_schedule_v1', identity: buildInstrumentSessionIdentity(bound.instrument,bound), coverageStart:'2026-10-01T00:00:00.000Z',coverageEnd:'2026-12-01T00:00:00.000Z',requestedAt:new Date(now-1000).toISOString(),receivedAt:new Date(now).toISOString(),sessions:[{date:start.slice(0,10),start,end}] } };
  return {bound,now,evidence};
}
test('early close derives broker UTC deadline with configured margin and refuses exact deadline admission policy elsewhere',()=>{
 const f=setup(); assert.equal(deriveExitSession(f.bound,f.evidence,f.now,f.now,60).exitDeadline,'2026-11-27T17:00:00.000Z');
});
test('broker UTC intervals retain different US DST offsets without wall-clock inference',()=>{
 for(const [start,end,expected] of [['2026-11-27T14:30:00.000Z','2026-11-27T18:00:00.000Z','2026-11-27T17:45:00.000Z'],['2026-10-30T13:30:00.000Z','2026-10-30T20:00:00.000Z','2026-10-30T19:45:00.000Z']]) {
 const f=setup(start,end);assert.equal(deriveExitSession(f.bound,f.evidence,f.now,f.now,15).exitDeadline,expected); }
});
test('restart may tighten but cannot postpone pinned session policy',()=>{
 const f=setup(),p=deriveExitSession(f.bound,f.evidence,f.now,f.now,15);
 assert.equal(tightenExitSession(p,{...p,sessionEnd:'2026-11-27T20:00:00.000Z',exitDeadline:'2026-11-27T19:45:00.000Z'}).exitDeadline,p.exitDeadline);
 assert.equal(tightenExitSession(p,{...p,sessionEnd:'2026-11-27T17:00:00.000Z',exitDeadline:'2026-11-27T16:45:00.000Z'}).exitDeadline,'2026-11-27T16:45:00.000Z');
 assert.throws(()=>tightenExitSession(p,{...p,sessionDate:'2026-11-28'}),/identity/);
});
test('missing historical session, stale calendar, wrong identity and invalid margin fail closed',()=>{
 const f=setup();assert.throws(()=>deriveExitSession(f.bound,f.evidence,f.now-86400000,f.now,15),/original_session/);
 assert.throws(()=>deriveExitSession(f.bound,null,f.now,f.now,15),/unavailable/);
 assert.throws(()=>deriveExitSession(f.bound,f.evidence,f.now,f.now+7*3600000,15),/stale/);
 assert.throws(()=>deriveExitSession(f.bound,f.evidence,f.now,f.now,14),/policy/);
 f.evidence.schedule!.identity.conId++;assert.throws(()=>deriveExitSession(f.bound,f.evidence,f.now,f.now,15),/identity/);
});
