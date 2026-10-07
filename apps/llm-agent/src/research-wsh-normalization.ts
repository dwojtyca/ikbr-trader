import {
  researchAssert,
  researchHash,
  validateWshValue,
  wshEventVersionProjection,
  type WshConfig,
  type WshEvent,
  type WshValue,
} from "@ikbr/shared/instrument-research";

const DATE_FIELDS = ["earnings_date", "start_date", "end_date", "quarter_end_date", "prelim_earnings_date"] as const;
const OPTIONAL_FIELDS = [
  "amount_oc", "estimated_eps", "estimize_eps_weighted", "currency", "fiscal_year", "quarter",
  "earnings_date", "time_of_day", "announce_datetime", "start_date", "end_date", "quarter_end_date",
  "prelim_earnings_date", "prelim_amount_from", "prelim_amount_to", "prelim_earnings_link",
  "confidence_indicator", "audit_source", "shm_meeting_type", "local_time_start", "venue_country_iso",
  "time_zone", "wshe_earnings_date_status", "event_status", "increase_decrease_code", "change_amount", "change_percent",
] as const;

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  researchAssert(value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, "RESEARCH_WSH_ROW_INVALID");
  return value as Obj;
}
function boundedText(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function realDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function typeLabel(metadata: unknown, eventType: string): { name: string | null; columns: WshValue[] } {
  const root = object(metadata);
  validateWshValue(root);
  const meta = object(root.meta_data);
  const types = meta.event_types;
  researchAssert(Array.isArray(types), "RESEARCH_WSH_METADATA_INVALID");
  const item = types.find(value => value && typeof value === "object" && !Array.isArray(value) && (value as Obj).tag === eventType);
  if (!item) return { name: null, columns: [] };
  const record = object(item);
  researchAssert(Array.isArray(record.columns), "RESEARCH_WSH_METADATA_INVALID");
  return {
    name: typeof record.name === "string" ? record.name : null,
    columns: record.columns.map(column => {
      const c = object(column);
      return Object.fromEntries(["tag", "name", "type", "group"].filter(k => Object.hasOwn(c, k)).map(k => [k, c[k]])) as WshValue;
    }),
  };
}

/** Purely maps a bounded provider response into immutable, hash-bound context rows. */
export function normalizeWshEvents(input: unknown, metadata: unknown, config: WshConfig): { events: WshEvent[]; rowCount: number; duplicateCount: number } {
  researchAssert(Array.isArray(input) && input.length < 100, "RESEARCH_WSH_ROW_COUNT_INVALID");
  validateWshValue(input);
  validateWshValue(metadata);
  researchAssert(Array.isArray(object(object(metadata).meta_data).event_types), "RESEARCH_WSH_METADATA_INVALID");
  const parsed = input.map(raw => {
    const row = object(raw);
    researchAssert(boundedText(row.event_key) && boundedText(row.event_type), "RESEARCH_WSH_ROW_INVALID");
    researchAssert(Array.isArray(row.conids) && row.conids.length > 0 && row.conids.length <= 32, "RESEARCH_WSH_IDENTITY_INVALID");
    const conIds = row.conids.map(value => {
      researchAssert(typeof value === "string" && /^(?:[1-9]\d*)$/.test(value), "RESEARCH_WSH_IDENTITY_INVALID");
      const n = Number(value); researchAssert(Number.isSafeInteger(n) && n > 0, "RESEARCH_WSH_IDENTITY_INVALID"); return n;
    });
    researchAssert(new Set(conIds).size === conIds.length && conIds.includes(config.conId), "RESEARCH_WSH_IDENTITY_INVALID");
    const data = object(row.data), company = object(data.company);
    researchAssert(company.isin === config.isin, "RESEARCH_WSH_IDENTITY_INVALID");
    const eventType = row.event_type;
    const kind: WshEvent["interpretation"] = eventType === "wshe_ed" || eventType === "wshe_fq" ? "EARNINGS" : eventType === "wshe_sh" ? "SHAREHOLDER_MEETING" : eventType === "wshe_eps" ? "EPS" : "GENERIC_PROVIDER_EVENT";
    conIds.sort((a, b) => a - b);
    const metadataInfo = typeLabel(metadata, eventType);
    for (const field of kind === "GENERIC_PROVIDER_EVENT" ? [] : DATE_FIELDS) {
      const value = data[field];
      if (value !== undefined && value !== null && value !== "") researchAssert(typeof value === "string" && realDate(value), "RESEARCH_WSH_DATE_INVALID");
    }
    const start = data.start_date, end = data.end_date;
    if (kind === "SHAREHOLDER_MEETING" && typeof start === "string" && start.length && typeof end === "string" && end.length) researchAssert(start <= end, "RESEARCH_WSH_DATE_INVALID");
    const originalStatus = kind === "EARNINGS" && Object.hasOwn(data, "wshe_earnings_date_status") ? data.wshe_earnings_date_status :
      kind === "SHAREHOLDER_MEETING" && Object.hasOwn(data, "event_status") ? data.event_status : row.status;
    researchAssert(originalStatus === undefined || originalStatus === null || typeof originalStatus === "string" && originalStatus.length <= 4000, "RESEARCH_WSH_STATUS_INVALID");
    const recognized = kind === "EARNINGS" ? ["CONFIRMED", "UNCONFIRMED", "INFERRED"] : kind === "SHAREHOLDER_MEETING" ? ["PENDING", "INPROCESS", "CANCEL"] : [];
    const sourceFields: Record<string, WshValue> = { data: data as WshValue };
    for (const key of ["index_date", "index_date_type", "source", "filterSource", "status"]) if (Object.hasOwn(row, key)) sourceFields[`outer_${key}`] = row[key] as WshValue;
    const fields: Record<string, WshValue> = {};
    for (const key of OPTIONAL_FIELDS) {
      if (Object.hasOwn(data, key)) fields[key] = data[key] as WshValue;
      else if (["amount_oc", "estimated_eps", "estimize_eps_weighted", "earnings_date"].includes(key)) fields[key] = "NOT_PROVIDED";
    }
    for (const key of kind === "GENERIC_PROVIDER_EVENT" ? [] : DATE_FIELDS) if (typeof data[key] === "string" && data[key] !== "") fields[`${key}_precision`] = "DATE_ONLY";
    if (typeof data.announce_datetime === "string") fields.announce_datetime_precision = "UNKNOWN_TIME_PRECISION";
    const context: Record<string, WshValue> = {
      recognizedFields: fields,
      metadata: { name: metadataInfo.name, columns: metadataInfo.columns },
      issuerTimeZone: config.issuerTimeZone,
      sourceStatus: (originalStatus ?? null) as WshValue,
      statusInterpretation: typeof originalStatus === "string" && recognized.includes(originalStatus) ? "RECOGNIZED" : "UNKNOWN_INTERPRETATION",
      interpretation: kind,
      ...(kind === "GENERIC_PROVIDER_EVENT" ? { genericContext: { index_date: row.index_date as WshValue ?? null, index_date_type: row.index_date_type as WshValue ?? null, metadataDescription: metadataInfo.name } } : {}),
    };
    validateWshValue(context); validateWshValue(sourceFields);
    const partial = {
      kind: "wsh-calendar" as const, providerEventKey: row.event_key, providerEventType: eventType,
      issuerIsin: config.isin, conIds, status: (originalStatus ?? null) as string | null,
      interpretation: kind, metadataDescription: metadataInfo.name === null ? "METADATA_DESCRIPTION_UNAVAILABLE" as const : "AVAILABLE" as const,
      statusInterpretation: typeof originalStatus === "string" && recognized.includes(originalStatus) ? "RECOGNIZED" as const : "UNKNOWN_INTERPRETATION" as const,
      context, sourceFields,
    };
    return { partial, fingerprint: researchHash(partial), periodKey: kind === "EARNINGS" && data.fiscal_year != null && data.quarter != null ? [data.fiscal_year, data.quarter].join(":") : null, dateStatus: [data.earnings_date ?? null, originalStatus ?? null] };
  });

  const seen = new Set<string>();
  const kept = parsed.filter(item => {
    const key = `${item.partial.providerEventKey}:${item.fingerprint}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const periods = new Map<string, Set<string>>();
  for (const item of kept) if (item.periodKey) {
    const variants = periods.get(item.periodKey) ?? new Set<string>(); variants.add(researchHash(item.dateStatus)); periods.set(item.periodKey, variants);
  }
  for (const item of kept) if (item.periodKey && (periods.get(item.periodKey)?.size ?? 0) > 1) item.partial.context.disagreement = "SOURCE_DISAGREEMENT";
  const events = kept.map(item => {
    const versionHash = researchHash(wshEventVersionProjection(item.partial));
    return { ...item.partial, id: `wsh_event_${researchHash({ key: item.partial.providerEventKey, versionHash })}`, versionHash, evidenceRef: `wsh_ev_${versionHash}` } as WshEvent;
  }).sort((a, b) => a.providerEventKey.localeCompare(b.providerEventKey) || a.versionHash.localeCompare(b.versionHash));
  return { events, rowCount: input.length, duplicateCount: input.length - kept.length };
}
