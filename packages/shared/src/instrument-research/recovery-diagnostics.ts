import { type DiagnosticPrivacy } from '../diagnostics/privacy.js';
import { sanitizeResearchSourceError } from './source-error.js';

const stages = ['profile', 'challenge-read', 'producer-inventory', 'gateway-before', 'gateway-stop', 'gateway-replacement',
  'profile-recheck', 'reconnect', 'producer-recheck', 'host-identity', 'evidence-parse', 'state-load', 'state-save',
  'prepare', 'supersede', 'commit', 'commit-readback', 'status', 'subprocess', 'arguments', 'request', 'configuration',
  'preflight', 'challenge', 'read', 'receipt', 'reconnect-connect', 'reconnect-close', 'reconnect-validate', 'reconnect-postflight'] as const;
export type RecoveryDiagnosticStage = typeof stages[number];
export type RecoveryDiagnostic = { version: 1; stage: RecoveryDiagnosticStage; reason: string;
  original: { name: string | null; code: string | number | null; message: string | null } };
const unknown = 'RESEARCH_RECOVERY_FAILED_OR_UNKNOWN';
const reasonPattern = /^RESEARCH_(?:RECOVERY|WSH)_[A-Z0-9_]{1,75}$/;
const controls = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function plain(value: unknown, keys: string[]): boolean {
  if (value === null || typeof value !== 'object') return false;
  try { return Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.hasOwn(value, key)
      && 'value' in Object.getOwnPropertyDescriptor(value, key)!); } catch { return false; }
}
function errorName(value: unknown): string | null {
  for (let depth = 0; depth < 4 && value !== null && typeof value === 'object'; depth++) {
    const name = own(value, 'name');
    if (typeof name === 'string') return name;
    try { value = Object.getPrototypeOf(value); } catch { return null; }
  }
  return null;
}
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !controls.test(v);
export function parseRecoveryDiagnostic(value: unknown): RecoveryDiagnostic | null {
  if (!plain(value, ['version', 'stage', 'reason', 'original'])) return null;
  const original = own(value, 'original');
  if (own(value, 'version') !== 1 || !stages.includes(own(value, 'stage') as RecoveryDiagnosticStage)
    || !bounded(own(value, 'reason'), 100) || !reasonPattern.test(own(value, 'reason') as string)
    || !plain(original, ['name', 'code', 'message'])) return null;
  const name = own(original, 'name'), code = own(original, 'code'), message = own(original, 'message');
  if (!(name === null || bounded(name, 100)) || !(code === null || bounded(code, 100) || Number.isSafeInteger(code))
    || !(message === null || bounded(message, 1000))) return null;
  if (Buffer.byteLength(JSON.stringify(value)) > 4096) return null;
  return structuredClone(value) as RecoveryDiagnostic;
}
export function recoveryDiagnosticPrivacy(env: NodeJS.ProcessEnv): DiagnosticPrivacy {
  const secrets: string[] = [], accountIds: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value) continue;
    if (/(?:TOKEN|KEY|SECRET|PASSWORD|POSTGRES_URL|REDIS_URL)/i.test(key)) secrets.push(value);
    if (/ACCOUNT/i.test(key)) accountIds.push(...value.split(',').map(x => x.trim()).filter(Boolean));
    if (/URL/i.test(key)) {
      try {
        const url = new URL(value);
        for (const credential of [url.username, url.password, ...[...url.searchParams].filter(([name]) => /token|key|secret|password|authorization/i.test(name)).map(([, item]) => item)]) {
          if (!credential) continue;
          secrets.push(credential);
          try { secrets.push(decodeURIComponent(credential)); } catch { /* The encoded value remains covered. */ }
        }
      } catch { /* Invalid URLs do not supply trustworthy component boundaries. */ }
    }
  }
  return { secrets, accountIds };
}
function recoveryText(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[ADRES UKRYTY]')
    .replace(/\{[\s\S]*$/, '[DANE UKRYTE]')
    .replace(/\[(?=\s*(?:"|\{|\[|-?\d|true\b|false\b|null\b))[\s\S]*$/, '[DANE UKRYTE]');
}
function sanitize(diagnostic: RecoveryDiagnostic, privacy: DiagnosticPrivacy): RecoveryDiagnostic {
  const value = diagnostic.original;
  const message = value.name === 'SyntaxError' ? null : value.message;
  const safe = sanitizeResearchSourceError({ name: recoveryText(value.name), code: typeof value.code === 'string' ? recoveryText(value.code) : value.code,
    message: recoveryText(message) ?? 'unavailable' }, privacy);
  const reason = sanitizeResearchSourceError({ name: null, code: null, message: diagnostic.reason }, privacy).message;
  const result: RecoveryDiagnostic = { version: 1, stage: diagnostic.stage, reason: reasonPattern.test(reason) ? reason : unknown,
    original: { name: safe.name, code: safe.code, message: message === null ? null : safe.message } };
  if (Buffer.byteLength(JSON.stringify(result)) > 4096) result.original.message = result.original.message?.slice(0, 500) ?? null;
  return result;
}
export class RecoveryDiagnosticFailure extends Error {
  constructor(message: string, readonly diagnostic: RecoveryDiagnostic) { super(message); }
}
export function recoveryDiagnostic(error: unknown, stage: RecoveryDiagnosticStage, privacy: DiagnosticPrivacy = {}): RecoveryDiagnostic {
  const existing = parseRecoveryDiagnostic(own(error, 'diagnostic'));
  if (existing) return sanitize(existing, privacy);
  const message = own(error, 'message'), code = own(error, 'code');
  const reason = typeof message === 'string' && reasonPattern.test(message) ? message
    : typeof code === 'string' && reasonPattern.test(code) ? code : unknown;
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object' && !visited.has(current); depth++) {
    visited.add(current);
    const source = own(current, 'sourceError');
    if (source && typeof source === 'object') { current = source; break; }
    const cause = own(current, 'cause');
    if (cause === undefined) break;
    current = cause;
  }
  const originalMessage = own(current, 'message'), originalCode = own(current, 'code');
  const originalName = errorName(current);
  const internal = typeof originalMessage === 'string' && /^RESEARCH_[A-Z0-9_]+$/.test(originalMessage);
  const result: RecoveryDiagnostic = { version: 1, stage, reason, original: {
    name: !internal ? originalName : null,
    code: !internal && (typeof originalCode === 'string' || Number.isSafeInteger(originalCode)) ? originalCode as string | number : null,
    message: !internal && originalName !== 'SyntaxError' && typeof originalMessage === 'string' ? originalMessage : null,
  } };
  return sanitize(result, privacy);
}
export function recoveryDiagnosticFailure(error: unknown, stage: RecoveryDiagnosticStage, privacy: DiagnosticPrivacy = {}, preferred?: unknown): RecoveryDiagnosticFailure {
  const message = own(error, 'message');
  return new RecoveryDiagnosticFailure(typeof message === 'string' && reasonPattern.test(message) ? message : unknown,
    recoveryDiagnostic(preferred ?? error, stage, privacy));
}
export function recoveryFailureOutput(error: unknown, stage: RecoveryDiagnosticStage, privacy: DiagnosticPrivacy = {}) {
  return { ok: false as const, reason: unknown, diagnostic: recoveryDiagnostic(error, stage, privacy) };
}
export function formatRecoveryFailure(error: unknown, stage: RecoveryDiagnosticStage, privacy: DiagnosticPrivacy = {}): string {
  const d = recoveryDiagnostic(error, stage, privacy), original = d.original;
  return `Etap: ${d.stage}; powód: ${d.reason}; nazwa oryginalna: ${original.name ?? 'niedostępna'}; kod oryginalny: ${original.code ?? 'niedostępny'}; opis oryginalny: ${original.message ?? 'niedostępny'}.`;
}
