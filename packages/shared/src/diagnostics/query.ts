import { DIAGNOSTIC_LIMITS, type DiagnosticQuery, type DiagnosticMode, type DiagnosticSeverity } from './types.js';
const allowed = new Set(['mode','from','to','limit','instrumentId','reason','severity','proposalId','evaluationId']);
const utc = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const normalized = new Date(value).toISOString();
  return normalized.slice(0,19) === value.slice(0,19);
};
export function parseDiagnosticQuery(input: unknown, now = Date.now()): DiagnosticQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('DIAGNOSTIC_QUERY_INVALID');
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some(key => !allowed.has(key))) throw Error('DIAGNOSTIC_QUERY_INVALID');
  const mode = row.mode ?? 'status', from = row.from ?? new Date(now-3600000).toISOString(), to = row.to ?? new Date(now).toISOString();
  const limit = row.limit === undefined ? DIAGNOSTIC_LIMITS.defaultLimit : typeof row.limit === 'string' && /^\d+$/.test(row.limit) ? Number(row.limit) : row.limit;
  if (!['events','status','timeline','session'].includes(String(mode)) || !utc(from) || !utc(to) || Date.parse(to)<Date.parse(from) ||
      Date.parse(to)-Date.parse(from)>DIAGNOSTIC_LIMITS.maxDays*86400000 || Date.parse(to)>now+60000 ||
      typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit<1 || limit>DIAGNOSTIC_LIMITS.maxEvents) throw Error('DIAGNOSTIC_QUERY_INVALID');
  const query: DiagnosticQuery = {mode:mode as DiagnosticMode,from:new Date(from).toISOString(),to:new Date(to).toISOString(),limit};
  for (const key of ['instrumentId','reason','evaluationId'] as const) {
    if (row[key] !== undefined) {
      if (typeof row[key] !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(row[key])) throw Error('DIAGNOSTIC_QUERY_INVALID');
      query[key] = row[key];
    }
  }
  if (row.proposalId !== undefined) {
    if (typeof row.proposalId !== 'string' || !/^[1-9]\d{0,14}$/.test(row.proposalId)) throw Error('DIAGNOSTIC_QUERY_INVALID');
    query.proposalId=row.proposalId;
  }
  if (row.severity !== undefined) {
    if (!['INFO','WARN','ERROR','CRITICAL'].includes(String(row.severity))) throw Error('DIAGNOSTIC_QUERY_INVALID');
    query.severity=row.severity as DiagnosticSeverity;
  }
  if (query.mode==='timeline' && (!!query.proposalId === !!query.evaluationId)) throw Error('DIAGNOSTIC_TRACE_ID_REQUIRED');
  return query;
}
