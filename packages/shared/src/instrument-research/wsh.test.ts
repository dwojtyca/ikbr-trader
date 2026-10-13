import assert from "node:assert/strict";
import { test } from "node:test";
import { researchFixture, wshSnapshotFixture } from "./research.fixture.js";
import { parseResearchManifest, parseResearchSnapshot, researchHash } from "./validation.js";
import { evaluateResearchEligibility } from "./eligibility.js";
import { inspectResearch } from "./repair.js";
import { sanitizeResearchProviderError, formatResearchProviderError } from "./provider-error.js";
import { validateWshValue, wshRequestDates } from "./wsh.js";

const now = Date.parse("2026-10-07T12:00:00Z");
test("V1 immutable JSON is decoded unchanged; publication requirements survive V2", () => {
  const v1 = researchFixture(now), before = JSON.stringify(v1.snapshot), hash = researchHash(v1.snapshot);
  assert.equal(researchHash(parseResearchSnapshot(v1.snapshot,v1.manifest)),hash); assert.equal(JSON.stringify(v1.snapshot),before);
  for (const f of [v1,wshSnapshotFixture(now)]) {
    (f.snapshot.evidence[0] as unknown as { published: null }).published = null;
    assert.throws(() => parseResearchSnapshot(f.snapshot,f.manifest));
  }
  const f = wshSnapshotFixture(now);
  assert.throws(() => parseResearchManifest({...f.manifest,schemaVersion:1},f.config,f.configHash));
  assert.throws(() => parseResearchSnapshot({...f.snapshot,schemaVersion:1},f.manifest));
});
test("V2 qualified WSH is context for all three configured issuers before/during/after events", () => {
  for (const instrument of ["pko_wse","aapl_smart","xyz_nyse"]) for (const eventDate of ["2026-10-06","2026-10-07","2026-10-08"]) {
    const f = wshSnapshotFixture(now,instrument,eventDate);
    parseResearchManifest(f.manifest,f.config,f.configHash); parseResearchSnapshot(f.snapshot,f.manifest);
    const result = evaluateResearchEligibility(f.snapshot,f.manifest,now);
    assert.equal(result.eligible,true,result.reasons.join(","));
    assert.equal(result.expiresAt,new Date(Date.parse(f.snapshot.createdAt)+900000).toISOString());
  }
});
test("first observed knowledge is never publication; wrong provenance, source identity, date bounds and saturation reject", () => {
  const changes: ((s: ReturnType<typeof wshSnapshotFixture>["snapshot"])=>void)[] = [
    s => { const e=s.evidence[1]; if(e.published===null)e.firstObservedAt=new Date(now+1).toISOString(); },
    s => { const e=s.evidence[1]; if(e.published===null)e.locator.requestHash="0".repeat(64); },
    s => { const e=s.events[0]; if(e.kind==="wsh-calendar")e.issuerIsin="US9999999999"; },
    s => { const c=s.coverage[2]; if("wshAcquisition" in c)c.wshAcquisition.rowCount=100; },
    s => { const c=s.coverage[2]; if("wshAcquisition" in c)c.wshAcquisition.requestStartDate="20261001"; },
    s => { const e=s.events[0]; if(e.kind==="wsh-calendar")e.sourceFields.earnings_date="2026-10-09"; },
  ];
  for(const change of changes){const f=wshSnapshotFixture(now);change(f.snapshot);assert.throws(()=>parseResearchSnapshot(f.snapshot,f.manifest));}
  const f=wshSnapshotFixture(now);
  assert.equal(evaluateResearchEligibility(f.snapshot,f.manifest,Date.parse(f.snapshot.createdAt)+900000).eligible,false);
});
test("bounded context keeps optional values but rejects overflows rather than truncating", () => {
  validateWshValue({empty:null,forecast:"NOT_PROVIDED",zero:0});
  for(const value of ["x".repeat(4001),[...Array(101)].map(()=>null),Object.fromEntries([...Array(129)].map((_,i)=>[i,null])),{a:{b:{c:{d:{e:{f:{g:1}}}}}}},Infinity])assert.throws(()=>validateWshValue(value));
});
test("query uses issuer-local dates across DST; no event window is introduced", () => {
  const f=wshSnapshotFixture(now);
  assert.deepEqual(wshRequestDates(f.wshConfig,"2026-10-24T22:30:00Z"),{startDate:"20261016",endDate:"20261211"});
  const empty=structuredClone(f.snapshot);empty.events=[];empty.evidence=empty.evidence.filter(e=>e.published!==null);
  const c=empty.coverage[2];if("wshAcquisition" in c){c.status="EMPTY";c.evidenceRefs=[];c.wshAcquisition.rowCount=0;}
  assert.equal(evaluateResearchEligibility(empty,f.manifest,now).eligible,true);
});


test("WSH provider failures retain diagnostics without changing eligibility or legacy hashes", () => {
  const f = wshSnapshotFixture(now);
  f.snapshot.events = [];
  f.snapshot.evidence = f.snapshot.evidence.filter(e => ("kind" in e ? e.kind !== "wsh-calendar" : true));
  const old = f.snapshot.coverage.find(c => c.role === "calendar")!;
  const failure = { sourceId: old.sourceId, role: "calendar" as const, status: "ERROR" as const,
    checkedAt: f.snapshot.createdAt, windowStart: f.snapshot.createdAt, windowEnd: f.snapshot.createdAt,
    complete: false, evidenceRefs: [], reason: "RESEARCH_WSH_ERROR_10281" };
  f.snapshot.coverage = f.snapshot.coverage.map(c => c === old ? failure : c);
  const legacyHash = researchHash(f.snapshot);
  assert.equal(researchHash(parseResearchSnapshot(f.snapshot, f.manifest)), legacyHash);
  const message = "Duplicate WSH event data request";
  const enhanced = { ...failure, providerError: { code: 10281, message } };
  f.snapshot.coverage = f.snapshot.coverage.map(c => c === failure ? enhanced : c);
  parseResearchSnapshot(f.snapshot, f.manifest);
  assert.equal(evaluateResearchEligibility(f.snapshot, f.manifest, now).eligible, false);
  const preparation = inspectResearch(f.manifest, f.policy.instrumentId,
    { id: "fixture", hash: researchHash(f.snapshot), sequence: 1, snapshot: f.snapshot }, now);
  assert.equal(preparation.state, "HOLD");
  assert.deepEqual(preparation.sources.find(c => c.role === "calendar")?.providerError, enhanced.providerError);
  for (const invalid of [{code:1.5,message}, {code:10281,message:"x".repeat(1001)},
    {code:10281,message:"bad\nline"}, {code:10281,message,stack:"hidden"}, null]) {
    const copy = structuredClone(f.snapshot);
    (copy.coverage.find(c => c.role === "calendar") as unknown as Record<string, unknown>).providerError = invalid;
    assert.throws(() => parseResearchSnapshot(copy, f.manifest), /PROVIDER_ERROR_INVALID/);
  }
  const other = structuredClone(f.snapshot);
  other.coverage[0].providerError = enhanced.providerError;
  assert.throws(() => parseResearchSnapshot(other, f.manifest), /PROVIDER_ERROR_INVALID/);
});

test("provider error text retains wording but removes known secrets, account IDs and terminal controls", () => {
  const error = sanitizeResearchProviderError(502, "connect failed DU1234567 custom-secret\n\x1b[31m", { secrets: ["custom-secret"] });
  assert.equal(error.code, 502);
  assert.match(error.message, /connect failed/);
  assert.doesNotMatch(error.message, /DU1234567|custom-secret|[\n\x1b]/);
  assert.match(formatResearchProviderError(error), /502/);
  assert.match(formatResearchProviderError(undefined), /niedostępny/);
  assert.equal(sanitizeResearchProviderError(undefined, "x".repeat(5000)).message.length, 1000);
});
