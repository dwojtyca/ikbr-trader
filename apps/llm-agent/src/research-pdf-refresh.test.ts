import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { request, type RequestOptions } from "node:https";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateResearchEligibility, parseResearchSnapshot, researchHash, type InstrumentResearchSnapshotV1, type ResearchCallReservation, type ResearchManifestV1, type StoredResearchSnapshot } from "@ikbr/shared/instrument-research";
import { assertResearchPdfResponse, fetchResearchSource, type ResearchFetchResult } from "./research-fetch.js";
import { pdfBytes } from "./research-pdf-binary.testfixture.js";
import { issuerPdfFixture } from "./research-pdf-fixture.js";
import { extractResearchPdf } from "./research-pdf-extractor.js";
import { normalizeResearchSource } from "./research-providers.js";
import { ResearchRefreshScheduler, researchSourceSlot } from "./research-refresh.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const DAY = 86_400_000;

function binaryFixture(malformed = false) {
  const f = issuerPdfFixture();
  for (const page of f.document.pages) for (const item of page.items) if (item.text === "123 456") item.text = "123,456";
  const bytes = malformed ? Buffer.from("%PDF-1.7\nthis is not a PDF object graph") : pdfBytes(f.document);
  f.mapping.documentSha256 = digest(bytes);
  f.mapping.authorityDecisions[0].selected.documentSha256 = digest(bytes);
  f.source.automation = "PERMITTED"; f.source.retention = "FACTS_AND_REFERENCES"; f.source.maxRequestsPerDay = 10;
  return { ...f, bytes };
}

function refreshHarness(malformed = false) {
  const f = binaryFixture(malformed);
  let now = Date.parse("2026-10-07T12:00:00Z");
  const preservedSource = f.policy.sources.find(source => source.id === "annual_report")!;
  preservedSource.automation = "PERMITTED"; preservedSource.retention = "FACTS_AND_REFERENCES"; preservedSource.maxRequestsPerDay = 10;
  f.policy.sources = [f.source, preservedSource];
  const manifest: ResearchManifestV1 = { ...JSON.parse(readFileSync(new URL("../../../config/research/paper.example.json", import.meta.url), "utf8")), refreshEnabled: true, instruments: [f.policy] };
  const manifestHash = researchHash(manifest), priorTime = new Date(now - 1000).toISOString();
  const initial: InstrumentResearchSnapshotV1 = {
    schemaVersion: 1, configHash: manifest.configHash, manifestHash, instrumentId: f.policy.instrumentId, mappingHash: researchHash(f.policy), createdAt: priorTime,
    evidence: [{ ref: "preserved_annual", sourceId: preservedSource.id, documentId: "annual_fixture", url: preservedSource.urls[0], contentHash: "e".repeat(64), issuerId: f.policy.issuerId,
      issuerIdentifier: preservedSource.issuerIdentifier, published: { precision: "instant", at: "2026-03-12T00:00:00Z" }, fetchedAt: priorTime, observedAt: priorTime, automation: "PERMITTED", retention: "FACTS_AND_REFERENCES" }],
    coverage: [{ sourceId: preservedSource.id, role: "reports", status: "AVAILABLE", checkedAt: priorTime, windowStart: new Date(now - DAY).toISOString(), windowEnd: priorTime, complete: true, evidenceRefs: ["preserved_annual"], reason: "previous independently acquired annual evidence" }],
    reports: [{ id: "annual_fixture", kind: "annual", periodStart: f.policy.annual.periodStart, periodEnd: f.policy.annual.periodEnd, scope: "consolidated", evidenceRef: "preserved_annual", supersedes: null }],
    facts: [], news: [], events: [],
  };
  parseResearchSnapshot(initial, manifest);
  const snapshots: StoredResearchSnapshot[] = [{ id: "seed", hash: researchHash(initial), sequence: 0, snapshot: structuredClone(initial) }];
  const slots = new Set([now, now + DAY].map(time => "research_slot_" + researchHash({ manifestHash, instrumentId: f.policy.instrumentId, sourceId: preservedSource.id, role: "reports", slot: researchSourceSlot(time, "reports") })));
  const reservations: ResearchCallReservation[] = [], outcomes: { key: string; outcome: string }[] = [];
  let fetches = 0, locked = false;
  let response: ResearchFetchResult = { payload: f.bytes, contentHash: digest(f.bytes), contentType: "application/pdf" };
  const unsupportedWshCall = async (): Promise<never> => { throw new Error("unexpected WSH call in HTTP-only fixture"); };
  const store: ConstructorParameters<typeof ResearchRefreshScheduler>[0]["store"] = {
    readSnapshot: unsupportedWshCall,
    withWshEndpointLock: unsupportedWshCall,
    pendingWshAcquisition: unsupportedWshCall,
    beginWshAcquisition: unsupportedWshCall,
    reserveWshCall: unsupportedWshCall,
    assertWshAcquisition: unsupportedWshCall,
    publishWshSnapshot: unsupportedWshCall,
    finishWshFailure: unsupportedWshCall,
    retireWshAcquisition: unsupportedWshCall,
    readWshAcquisition: unsupportedWshCall,
    latestSnapshot: async () => structuredClone(snapshots.at(-1)!),
    hasRefreshSlot: async key => slots.has(key),
    withRefreshLock: async (_identity, work) => { if (locked) return false; locked = true; try { await work(); return true; } finally { locked = false; } },
    storeSnapshot: async (input, slotKey) => {
      assert.ok(slotKey); assert.equal(slots.has(slotKey), false);
      const snapshot = parseResearchSnapshot(input, manifest);
      const stored = { id: "snapshot_" + snapshots.length, hash: researchHash(snapshot), sequence: snapshots.length, snapshot };
      slots.add(slotKey); snapshots.push(structuredClone(stored)); return structuredClone(stored);
    },
    reserveCall: async reservation => {
      assert.equal(reservations.some(item => item.callKey === reservation.callKey), false);
      reservations.push(structuredClone(reservation));
      return { callKey: reservation.callKey, reservedAt: new Date(now).toISOString(), budgetDay: new Date(now).toISOString().slice(0, 10) };
    },
    recordCallOutcome: async (key, outcome) => { outcomes.push({ key, outcome }); },
  };
  const make = () => new ResearchRefreshScheduler({ manifest, manifestHash, accountId: "DU1", store, now: () => now,
    fetch: async (source, url) => { fetches++; assert.equal(source.id, f.source.id); assert.equal(url, f.source.urls[0]); return response; } });
  return { f, manifest, manifestHash, snapshots, reservations, outcomes, make, setResponse: (value: ResearchFetchResult) => { response = value; },
    advanceDay: () => { now += DAY; }, get now() { return now; }, get fetches() { return fetches; } };
}

test("production PDF refresh publishes five extracted facts, preserves unrelated evidence, and restart/concurrent ticks do not duplicate reservations", async () => {
  const h = refreshHarness(), scheduler = h.make();
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  const snapshot = h.snapshots.at(-1)!.snapshot;
  assert.deepEqual(snapshot.facts.map(fact => fact.value), [23456, -7654, 123456, 987654, 18.25]);
  assert.equal(snapshot.reports.filter(report => report.kind === "periodic").length, 1);
  const coverage = snapshot.coverage.find(item => item.sourceId === h.f.source.id)!;
  assert.equal(coverage.status, "AVAILABLE"); assert.equal(coverage.complete, true); assert.equal(coverage.evidenceRefs.length, 1);
  const evidence = snapshot.evidence.find(item => item.ref === coverage.evidenceRefs[0])!;
  assert.notEqual(evidence.published, null);
  if (evidence.published === null) throw new Error("HTTP report received socket evidence");
  assert.equal(evidence.contentHash, digest(h.f.bytes));
  assert.ok(snapshot.facts.every(fact => fact.evidenceRef === evidence.ref));
  assert.deepEqual(snapshot.evidence.find(item => item.ref === "preserved_annual"), h.snapshots[0].snapshot.evidence[0]);
  assert.equal(h.fetches, 1); assert.equal(h.reservations.length, 1); assert.equal(h.outcomes[0].outcome, "SUCCEEDED");
  assert.equal(h.reservations[0].manifestHash, h.manifestHash);
  assert.equal(h.reservations[0].maxRequestsPerDay, 10);
  await h.make().tick(); await scheduler.tick();
  assert.equal(h.fetches, 1); assert.equal(h.snapshots.length, 2);
  const eligibility = evaluateResearchEligibility(snapshot, h.manifest, h.now);
  assert.equal(eligibility.reasons.includes("RESEARCH_PERIODIC_REPORT_MISSING_OR_CONFLICTING"), false);
  assert.equal(eligibility.reasons.includes("RESEARCH_REPORTS_ERROR"), false);
});

test("changed PDF digest in the next slot publishes ERROR without reusing stale facts, mutating history or retrying parsing", async () => {
  const h = refreshHarness(); await h.make().tick();
  const successful = structuredClone(h.snapshots[1]);
  h.advanceDay();
  const changed = Buffer.concat([h.f.bytes, Buffer.from("\n% changed upstream document\n")]);
  h.setResponse({ payload: changed, contentHash: digest(changed), contentType: "application/pdf" });
  await h.make().tick();
  const snapshot = h.snapshots.at(-1)!.snapshot, coverage = snapshot.coverage.find(item => item.sourceId === h.f.source.id)!;
  assert.equal(coverage.status, "ERROR"); assert.equal(coverage.complete, false); assert.deepEqual(coverage.evidenceRefs, []);
  assert.equal(coverage.reason, "RESEARCH_PDF_DIGEST_MISMATCH");
  assert.equal(snapshot.facts.length, 0); assert.equal(snapshot.reports.some(report => report.kind === "periodic"), false);
  assert.deepEqual(snapshot.evidence, h.snapshots[0].snapshot.evidence);
  assert.deepEqual(h.snapshots[1], successful); assert.equal(researchHash(h.snapshots[1].snapshot), successful.hash);
  const eligibility = evaluateResearchEligibility(snapshot, h.manifest, h.now);
  assert.equal(eligibility.eligible, false); assert.ok(eligibility.reasons.includes("RESEARCH_REPORTS_ERROR"));
  assert.ok(eligibility.reasons.includes("RESEARCH_PERIODIC_REPORT_MISSING_OR_CONFLICTING"));
  assert.equal(h.fetches, 2); assert.equal(h.reservations.length, 2);
  await h.make().tick(); assert.equal(h.fetches, 2); assert.equal(h.snapshots.length, 3);
});

test("matching-pin malformed PDF fails inside the production decoder and retains prior independent evidence", async () => {
  const h = refreshHarness(true); await h.make().tick();
  const snapshot = h.snapshots.at(-1)!.snapshot;
  const coverage = snapshot.coverage.find(item => item.sourceId === h.f.source.id)!;
  assert.equal(coverage.status, "ERROR"); assert.equal(coverage.complete, false); assert.equal(coverage.reason, "RESEARCH_PDF_DECODE_FAILED");
  assert.deepEqual(snapshot.evidence, h.snapshots[0].snapshot.evidence);
  assert.equal(snapshot.facts.length, 0);
  assert.ok(evaluateResearchEligibility(snapshot, h.manifest, h.now).reasons.includes("RESEARCH_REPORTS_ERROR"));
  await h.make().tick(); assert.equal(h.fetches, 1); assert.equal(h.reservations.length, 1);
});

test("PDF production dispatch rejects foreign sources and reported hashes after real binary decoding", async () => {
  const f = binaryFixture();
  const extracted = await extractResearchPdf(f.bytes, digest(f.bytes), f.mapping.pages.map(page => page.pageNumber));
  const result = normalizeResearchSource(f.policy, f.source, extracted, "2026-10-07T12:00:00Z", f.source.urls[0], digest(f.bytes));
  assert.ok("facts" in result); assert.equal(result.facts.length, 5);
  assert.throws(() => normalizeResearchSource(f.policy, { ...f.source, provider: "https://other.example" }, extracted, "2026-10-07T12:00:00Z", f.source.urls[0], digest(f.bytes)), /configured identity/);
  assert.throws(() => normalizeResearchSource(f.policy, f.source, extracted, "2026-10-07T12:00:00Z", f.source.urls[0], "b".repeat(64)), /DOCUMENT_HASH_MISMATCH/);
  assert.throws(() => normalizeResearchSource(f.policy, f.source, extracted, "2026-10-07T12:00:00Z", "https://www.pkobp.pl/not-configured.pdf", digest(f.bytes)), /configured identity/);
});

test("scheduler revalidates PDF media/magic and reported hash even when the fetch dependency returns unchecked bytes", async () => {
  for (const failure of ["media", "magic", "reported_hash"] as const) {
    const h = refreshHarness();
    const response = { payload: h.f.bytes, contentHash: digest(h.f.bytes), contentType: "application/pdf" };
    if (failure === "media") response.contentType = "text/html";
    if (failure === "magic") response.payload = Buffer.from("<html>access denied</html>");
    if (failure === "reported_hash") response.contentHash = "b".repeat(64);
    h.setResponse(response); await h.make().tick();
    const snapshot = h.snapshots.at(-1)!.snapshot, coverage = snapshot.coverage.find(item => item.sourceId === h.f.source.id)!;
    assert.equal(coverage.status, "ERROR"); assert.equal(coverage.complete, false);
    assert.equal(coverage.reason, failure === "media" ? "RESEARCH_PDF_CONTENT_TYPE_INVALID" : failure === "magic" ? "RESEARCH_PDF_MAGIC_INVALID" : "RESEARCH_PDF_DOCUMENT_HASH_MISMATCH");
    assert.equal(snapshot.facts.length, 0); assert.equal(h.fetches, 1); assert.equal(h.reservations.length, 1);
  }
});

function stubHttps(payload: Buffer, contentType: string) {
  const observed: RequestOptions[] = [];
  const httpsRequest = ((_url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    observed.push(options);
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    req.destroy = error => { if (error) req.emit("error", error); };
    req.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy(): void };
      response.statusCode = 200; response.headers = { "content-type": contentType, "content-length": String(payload.length) }; response.destroy = () => {};
      onResponse(response as unknown as IncomingMessage);
      response.emit("data", payload.subarray(0, 10)); response.emit("data", payload.subarray(10)); response.emit("end");
    };
    return req;
  }) as unknown as typeof request;
  return { observed, httpsRequest, resolveAddress: async () => ({ address: "8.8.8.8", family: 4 as const }) };
}

test("HTTP PDF fetch requests PDF and accepts only PDF media/magic, hashing exact body without network", async () => {
  const f = binaryFixture();
  const deps = stubHttps(f.bytes, "Application/PDF; charset=binary");
  const result = await fetchResearchSource(f.source, f.source.urls[0], new Date(Date.now() + 5000).toISOString(), deps);
  assert.deepEqual(result.payload, f.bytes); assert.equal(result.contentHash, digest(f.bytes));
  assert.equal((deps.observed[0].headers as Record<string, string>).Accept, "application/pdf");
  for (const [bytes, contentType, error] of [[f.bytes, "text/html", /CONTENT_TYPE_INVALID/], [Buffer.from("<html>forbidden</html>"), "application/pdf", /MAGIC_INVALID/]] as const) {
    const wrong = stubHttps(bytes, contentType);
    await assert.rejects(fetchResearchSource(f.source, f.source.urls[0], new Date(Date.now() + 5000).toISOString(), wrong), error);
    assert.equal(wrong.observed.length, 1);
    assert.throws(() => assertResearchPdfResponse(bytes, contentType), error);
  }
});
