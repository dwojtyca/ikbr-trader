import { createHash } from 'node:crypto';
import { canonicalJson, type LoadedTradingConfiguration } from '@ikbr/shared/trading-config';

export interface PaperCurrencyCaps {
  readonly maxNotional: number;
  readonly maxStopRisk: number;
  readonly feeReserve: number;
  readonly maxDailyLoss: number;
}
export interface PaperRunWindow {
  readonly instrumentId: string;
  readonly conId: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly instrument: string;
  readonly currency: 'PLN' | 'USD';
  readonly sessionTimeZone: 'Europe/Warsaw' | 'America/New_York';
  readonly accountDate: string;
  readonly sessionDate: string;
}
export interface PaperRunPolicy {
  readonly version: 1 | 2;
  readonly runId: string;
  readonly accountId: string;
  readonly effectiveConfigHash: string;
  readonly accountDayTimeZone: 'Europe/Warsaw';
  readonly kind: 'supervised_one_attempt' | 'bounded_scheduled';
  readonly maxAttemptsPerAccountDay: 1 | 2;
  readonly effectiveAccountDate?: string;
  readonly expiresAfterAccountDate?: string;
  readonly maxAttemptsPerInstrumentDay: 1;
  readonly windows: readonly PaperRunWindow[];
  readonly currencyCaps: Readonly<Partial<Record<'PLN' | 'USD', PaperCurrencyCaps>>>;
  readonly manifestHash: string;
  readonly canonicalManifest: string;
}
const fail = (reason: string): never => { throw new Error(`PAPER_RUN_${reason}`); };
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail('INVALID_OBJECT');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(row, key))) return fail('INVALID_FIELDS');
  return row;
};
const id = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : fail('INVALID_ID');
export function paperLocalDate(ms: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) return fail('INVALID_TIMESTAMP');
  const ms = Date.parse(value), date = value.slice(0, 10), midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms) || !Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) return fail('INVALID_TIMESTAMP');
  return ms;
}
export function parsePaperRunPolicy(env: Record<string, unknown>, loaded: LoadedTradingConfiguration): PaperRunPolicy | undefined {
  const raw = env.PAPER_RUN_POLICY_JSON;
  if (raw === undefined || raw === '') return undefined;
  if (env.IBKR_ENVIRONMENT !== 'paper') return fail('PAPER_REQUIRED');
  if (loaded.mode !== 'bundle') return fail('BUNDLE_REQUIRED');
  if (Object.entries(env).some(([key, value]) => /^(GPW|AAPL)_RUN_(ID|ACCOUNT|START|END)$/.test(key) && value !== undefined && value !== '')) return fail('LEGACY_AUTHORITY_CONFLICT');
  let decoded: unknown = raw;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > 1024 * 1024) return fail('TOO_LARGE');
    try { decoded = JSON.parse(raw); } catch { return fail('INVALID_JSON'); }
  }
  const scheduled = (decoded as Record<string, unknown> | null)?.version === 2;
  const row = object(decoded, ['version', 'runId', 'accountId', 'effectiveConfigHash', 'accountDayTimeZone', 'kind', 'maxAttemptsPerAccountDay', 'maxAttemptsPerInstrumentDay', 'windows', 'currencyCaps', ...(scheduled ? ['effectiveAccountDate', 'expiresAfterAccountDate'] : [])]);
  if (row.version !== (scheduled ? 2 : 1) || row.kind !== (scheduled ? 'bounded_scheduled' : 'supervised_one_attempt') || row.accountDayTimeZone !== 'Europe/Warsaw' || row.maxAttemptsPerAccountDay !== (scheduled ? 2 : 1) || row.maxAttemptsPerInstrumentDay !== 1) return fail('UNSUPPORTED_POLICY');
  const effectiveAccountDate = scheduled ? paperPolicyDate(row.effectiveAccountDate) : undefined;
  const expiresAfterAccountDate = scheduled ? paperPolicyDate(row.expiresAfterAccountDate) : undefined;
  if (scheduled && expiresAfterAccountDate! < effectiveAccountDate!) return fail('INVALID_DATE_BOUNDS');
  if (row.effectiveConfigHash !== loaded.effectiveHash) return fail('CONFIG_HASH_MISMATCH');
  const runId = id(row.runId), accountId = id(row.accountId);
  if (!Array.isArray(row.windows) || row.windows.length === 0 || row.windows.length > 100) return fail('INVALID_WINDOWS');
  const seen = new Set<string>();
  const windows = row.windows.map(value => {
    const w = object(value, ['instrumentId', 'conId', 'startsAt', 'endsAt']);
    if (typeof w.instrumentId !== 'string' || !Number.isSafeInteger(w.conId) || Number(w.conId) <= 0) return fail('INVALID_INSTRUMENT');
    const instrument = loaded.configuration.instruments.find(i => i.id === w.instrumentId && i.contract.conId === w.conId);
    if (!instrument) return fail('UNCONFIGURED_INSTRUMENT');
    if (scheduled) {
      const entry = loaded.configuration.entryPolicies.find(p => p.id === instrument.entryPolicyId);
      if (entry?.kind !== 'bounded_scheduled' || entry.maxAttemptsPerAccountDay !== 2) return fail('CONFIGURATION_POLICY_INCOMPATIBLE');
    }
    const start = timestamp(w.startsAt), end = timestamp(w.endsAt), zone = instrument.session.timeZone;
    if (end <= start || end - start > 3600000) return fail('INVALID_DURATION');
    if (paperLocalDate(start, 'Europe/Warsaw') !== paperLocalDate(end, 'Europe/Warsaw') || paperLocalDate(start, zone) !== paperLocalDate(end, zone)) return fail('CROSS_DAY_WINDOW');
    const accountDate = paperLocalDate(start, 'Europe/Warsaw'), sessionDate = paperLocalDate(start, zone);
    const keys = scheduled ? [`${instrument.contract.conId}:account:${accountDate}`, `${instrument.contract.conId}:session:${sessionDate}`] : [String(instrument.contract.conId)];
    if (keys.some(key => seen.has(key))) return fail('DUPLICATE_INSTRUMENT');
    keys.forEach(key => seen.add(key));
    if (scheduled && (accountDate < effectiveAccountDate! || accountDate > expiresAfterAccountDate!)) return fail('WINDOW_OUTSIDE_DATE_BOUNDS');
    return Object.freeze({ instrumentId: instrument.id, conId: instrument.contract.conId, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), instrument: instrument.contract.symbol, currency: instrument.contract.currency, sessionTimeZone: zone, accountDate: paperLocalDate(start, 'Europe/Warsaw'), sessionDate: paperLocalDate(start, zone) });
  }).sort((a, b) => scheduled ? a.conId - b.conId || a.startsAt.localeCompare(b.startsAt) || a.endsAt.localeCompare(b.endsAt) : a.instrumentId.localeCompare(b.instrumentId));
  const currencies = [...new Set(windows.map(w => w.currency))].sort();
  const caps = object(row.currencyCaps, currencies);
  const currencyCaps: Partial<Record<'PLN' | 'USD', PaperCurrencyCaps>> = {};
  for (const currency of currencies) {
    const cap = object(caps[currency], ['maxNotional', 'maxStopRisk', 'feeReserve', 'maxDailyLoss']);
    if (Object.values(cap).some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) return fail('INVALID_CAP');
    currencyCaps[currency] = Object.freeze(cap as unknown as PaperCurrencyCaps);
  }
  const manifest = { version: (scheduled ? 2 : 1) as 1 | 2, runId, accountId, effectiveConfigHash: loaded.effectiveHash, accountDayTimeZone: 'Europe/Warsaw' as const, kind: (scheduled ? 'bounded_scheduled' : 'supervised_one_attempt') as PaperRunPolicy['kind'], maxAttemptsPerAccountDay: (scheduled ? 2 : 1) as 1 | 2, maxAttemptsPerInstrumentDay: 1 as const, windows: windows.map(({ instrumentId, conId, startsAt, endsAt }) => ({ instrumentId, conId, startsAt, endsAt })), currencyCaps, ...(scheduled ? { effectiveAccountDate: effectiveAccountDate!, expiresAfterAccountDate: expiresAfterAccountDate! } : {}) };
  const canonicalManifest = canonicalJson(manifest);
  return Object.freeze({ ...manifest, windows: Object.freeze(windows), currencyCaps: Object.freeze(currencyCaps), canonicalManifest, manifestHash: createHash('sha256').update(canonicalManifest).digest('hex') });
}

export function paperPolicyDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('INVALID_DATE');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value || value < '2000-01-01' || value > '2100-12-31') return fail('INVALID_DATE');
  return value;
}

export interface PaperPolicyTransition {
  readonly priorKind: 'supervised_one_attempt' | 'bounded_scheduled';
  readonly nextKind: 'supervised_one_attempt' | 'bounded_scheduled';
  readonly accountDayTimeZone: string;
  readonly currentAccountDate: string;
  readonly effectiveAccountDate: string;
  readonly consumedAttempts: number;
  readonly reconciledFlat: boolean;
  readonly unresolvedReservations: boolean;
}
export function validatePaperPolicyTransition(input: PaperPolicyTransition): { ok: true; retainedAttempts: number } | { ok: false; reason: string; retainedAttempts: number } {
  const deny = (reason: string) => ({ ok: false as const, reason, retainedAttempts: input.consumedAttempts });
  if (!Number.isSafeInteger(input.consumedAttempts) || input.consumedAttempts < 0) return deny('PAPER_RUN_INVALID_COUNT');
  if (input.accountDayTimeZone !== 'Europe/Warsaw') return deny('PAPER_RUN_TIMEZONE_CHANGED');
  if (input.nextKind === 'bounded_scheduled') {
    try { paperPolicyDate(input.effectiveAccountDate); paperPolicyDate(input.currentAccountDate); } catch { return deny('PAPER_RUN_INVALID_DATE'); }
    if (input.effectiveAccountDate <= input.currentAccountDate) return deny('PAPER_RUN_TRANSITION_REQUIRES_SUBSEQUENT_DAY');
    if (!input.reconciledFlat || input.unresolvedReservations) return deny('PAPER_RUN_TRANSITION_REQUIRES_FLAT');
    return { ok: true, retainedAttempts: input.consumedAttempts };
  }
  return { ok: true, retainedAttempts: input.consumedAttempts };
}
