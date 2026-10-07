import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWshEvents } from "./research-wsh-normalization.js";
import type { WshConfig } from "@ikbr/shared/instrument-research";

const config = { kind: "ibkr-wsh-v1", conId: 123, isin: "PLPKO0000016", issuerTimeZone: "Europe/Warsaw" } as WshConfig;
const metadata = { meta_data: { event_types: [
  { tag: "wshe_ed", name: "Earnings date", columns: [{ tag: "earnings_date", name: "Earnings date", type: "date", group: "main", ignored: "allowed" }] },
  { tag: "wshe_fq", name: "Fiscal quarter", columns: [] },
  { tag: "wshe_sh", name: "Shareholder meeting", columns: [] },
  { tag: "wshe_eps", name: "EPS", columns: [] },
] } };
function row(event_type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { event_key: "ev-1", event_type, conids: ["123", "456"], data: { company: { isin: config.isin }, ...data }, ...extra };
}
function normalize(rows: unknown[], meta: unknown = metadata) { return normalizeWshEvents(rows, meta, config); }

test("normalizes earnings, meeting, EPS and generic rows without interpreting unsupported data", () => {
  const result = normalize([
    row("wshe_ed", { earnings_date: "20261012", fiscal_year: 2026, quarter: 3, wshe_earnings_date_status: "CONFIRMED", announce_datetime: "20261012 08:30:00 CET" }),
    row("wshe_sh", { start_date: "20261101", end_date: "20261102", event_status: "CANCEL", meeting_type: "AGM", location: "Warsaw", time_zone: "CET" }, { event_key: "meeting", status: "PENDING" }),
    row("wshe_eps", { amount_oc: "2.10", estimated_eps: "2.0", currency: "PLN", prelim_eps: "2.2" }, { event_key: "eps" }),
    row("new_type", { index_date: "opaque", forecast: "raw" }, { event_key: "generic", index_date: "opaque-date", index_date_type: "raw-type", status: "MYSTERY" }),
  ]);
  assert.equal(result.events.length, 4);
  const earnings = result.events.find(e => e.providerEventType === "wshe_ed")!;
  assert.equal(earnings.interpretation, "EARNINGS");
  assert.equal(earnings.context.statusInterpretation, "RECOGNIZED");
  assert.equal((earnings.context.recognizedFields as Record<string, unknown>).earnings_date_precision, "DATE_ONLY");
  assert.equal((earnings.context.recognizedFields as Record<string, unknown>).announce_datetime_precision, "UNKNOWN_TIME_PRECISION");
  assert.equal((earnings.context.recognizedFields as Record<string, unknown>).amount_oc, "NOT_PROVIDED");
  const meeting = result.events.find(e => e.interpretation === "SHAREHOLDER_MEETING")!;
  assert.equal(meeting.status, "CANCEL");
  assert.equal((meeting.sourceFields as Record<string, unknown>).outer_status, "PENDING");
  const eps = result.events.find(e => e.interpretation === "EPS")!;
  assert.equal((eps.context.recognizedFields as Record<string, unknown>).amount_oc, "2.10");
  const generic = result.events.find(e => e.providerEventKey === "generic")!;
  assert.equal(generic.metadataDescription, "METADATA_DESCRIPTION_UNAVAILABLE");
  assert.equal(generic.statusInterpretation, "UNKNOWN_INTERPRETATION");
  assert.equal((generic.sourceFields as Record<string, unknown>).outer_index_date, "opaque-date");
});

test("empty is valid and row limit is strictly below 100", () => {
  assert.deepEqual(normalize([]), { events: [], rowCount: 0, duplicateCount: 0 });
  const rows = Array.from({ length: 99 }, (_, i) => row("wshe_ed", { earnings_date: "20261012" }, { event_key: `ev-${i}` }));
  assert.equal(normalize(rows).rowCount, 99);
  assert.throws(() => normalize([...rows, row("wshe_ed", { earnings_date: "20261012" }, { event_key: "ev-99" })]));
  assert.throws(() => normalize([...rows, row("wshe_ed", { earnings_date: "20261012" }, { event_key: "ev-99" }), row("wshe_ed", {}, { event_key: "ev-100" })]));
});

test("deduplicates exact rows, retains revisions and annotates fiscal disagreements", () => {
  const original = row("wshe_ed", { fiscal_year: 2026, quarter: 3, earnings_date: "20261012", wshe_earnings_date_status: "CONFIRMED" });
  const revision = row("wshe_fq", { fiscal_year: 2026, quarter: 3, earnings_date: "20261013", wshe_earnings_date_status: "INFERRED" }, { event_key: "rev" });
  const result = normalize([original, original, revision, row("wshe_ed", { fiscal_year: 2026, quarter: 3, earnings_date: "20261014" })]);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.events.length, 3);
  assert.ok(result.events.every(e => e.context.disagreement === "SOURCE_DISAGREEMENT"));
  const again = normalize([revision, original, original, row("wshe_ed", { fiscal_year: 2026, quarter: 3, earnings_date: "20261014" })]);
  assert.deepEqual(result.events.map(e => [e.id, e.versionHash]).sort(), again.events.map(e => [e.id, e.versionHash]).sort());
});

test("rejects foreign identity, malformed dates, reversed intervals and bounded-value violations", () => {
  assert.throws(() => normalize([row("wshe_ed", {}, { conids: ["457"] })]));
  assert.throws(() => normalize([row("wshe_ed", { company: { isin: "US0000000001" } })]));
  assert.throws(() => normalize([row("wshe_ed", { earnings_date: "20260230" })]));
  assert.throws(() => normalize([row("wshe_sh", { start_date: "20261102", end_date: "20261101" })]));
  assert.throws(() => normalize([row("wshe_ed", { nested: { x: { y: { z: { a: { b: { c: { tooDeep: true } } } } } } } })]));
  assert.throws(() => normalize([row("wshe_ed", { huge: "x".repeat(4001) })]));
});


test("generic date values stay opaque and ordinary ed/fq variants do not imply a disagreement", () => {
  const unknown = normalize([row("new_type", { start_date: "opaque-date" }, { event_key: "generic" })]).events[0];
  assert.equal((unknown.context.recognizedFields as Record<string, unknown>).start_date, "opaque-date");
  assert.equal((unknown.context.recognizedFields as Record<string, unknown>).start_date_precision, undefined);
  assert.throws(() => normalize([row("wshe_ed", { earnings_date: 20261012 })]), /DATE_INVALID/);
  const events = normalize([
    row("wshe_ed", { earnings_date: "20261105", fiscal_year: 2026, quarter: "Q3", wshe_earnings_date_status: "UNCONFIRMED", audit_source: "NEWS" }, { event_key: "ed" }),
    row("wshe_fq", { earnings_date: "20261105", fiscal_year: 2026, quarter: "Q3", wshe_earnings_date_status: "UNCONFIRMED", confidence_indicator: "AXX" }, { event_key: "fq" }),
  ]).events;
  assert.ok(events.every(event => event.context.disagreement === undefined));
  assert.throws(() => normalizeWshEvents([], {}, config), /ROW_INVALID|METADATA_INVALID/);
});
