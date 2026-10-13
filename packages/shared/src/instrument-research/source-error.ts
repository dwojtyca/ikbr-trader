import { safeDiagnosticText, type DiagnosticPrivacy } from '../diagnostics/privacy.js';
import type { ResearchSourceError, ResearchSourceHttpDetails } from './types.js';
const unavailable = 'Oryginalny opis błędu niedostępny w zapisanych danych.';
const controls = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;
const primitiveCode = (value: unknown): value is string | number | null => value === null || Number.isSafeInteger(value) || typeof value === 'string' && value.length > 0 && value.length <= 100 && !controls.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !controls.test(value);
export function isResearchSourceError(value: unknown): value is ResearchSourceError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['name','code','message','httpStatus','httpStatusMessage','providerCode','providerMessage'].includes(key))) return false;
  return (row.name === null || text(row.name,100)) && primitiveCode(row.code) && text(row.message,1000)
    && (!Object.hasOwn(row,'httpStatus') || Number.isInteger(row.httpStatus) && Number(row.httpStatus)>=100 && Number(row.httpStatus)<=599)
    && (!Object.hasOwn(row,'httpStatusMessage') || text(row.httpStatusMessage,1000))
    && (!Object.hasOwn(row,'providerCode') || Object.hasOwn(row,'httpStatus') && primitiveCode(row.providerCode))
    && (!Object.hasOwn(row,'providerMessage') || Object.hasOwn(row,'httpStatus') && text(row.providerMessage,1000));
}
function safe(value: string, privacy: DiagnosticPrivacy, max: number): string {
  const originals = [...(privacy.secrets ?? []), ...(privacy.accountIds ?? [])].filter(Boolean);
  for (const secret of originals) {
    const encoded = encodeURIComponent(secret).replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/%[0-9A-F]{2}/g,triplet=>triplet.split('').map(char=>/[A-F]/.test(char)?`[${char.toLowerCase()}${char}]`:char).join(''));
    value = value.replace(new RegExp(encoded,'g'),'[UKRYTO]');
  }
  const secrets = originals.flatMap(secret => [secret, encodeURIComponent(secret)]);
  return safeDiagnosticText(value.replace(/https?:\/\/[^\s]+/gi,'[ADRES UKRYTY]')
    .replace(/\b(?:api[_-]?token|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi,'[SEKRET]'), { ...privacy, secrets }).slice(0,max);
}
export function sanitizeResearchSourceError(value: ResearchSourceError, privacy: DiagnosticPrivacy = {}): ResearchSourceError {
  const code = (v: string | number | null) => typeof v === 'string' ? safe(v,privacy,100) || null : Number.isSafeInteger(v) ? v : null;
  return { name: value.name === null ? null : safe(value.name,privacy,100) || null, code: code(value.code), message: safe(value.message,privacy,1000) || unavailable,
    ...(value.httpStatus === undefined ? {} : {httpStatus:value.httpStatus}),
    ...(value.httpStatusMessage ? {httpStatusMessage:safe(value.httpStatusMessage,privacy,1000)} : {}),
    ...(value.providerCode === undefined ? {} : {providerCode:code(value.providerCode)}),
    ...(value.providerMessage ? {providerMessage:safe(value.providerMessage,privacy,1000)} : {}) };
}
export function captureResearchSourceError(error: unknown, privacy: DiagnosticPrivacy = {}): ResearchSourceError {
  let original = error;
  const visited = new Set<unknown>();
  for (let depth=0; depth<4 && original instanceof Error && !visited.has(original); depth++) {
    visited.add(original);
    const detail = (original as Error & {sourceError?:unknown}).sourceError;
    if (isResearchSourceError(detail)) return sanitizeResearchSourceError(detail,privacy);
    const nativeCode = (original as Error & {code?:unknown}).code;
    if (typeof nativeCode === "string" || Number.isSafeInteger(nativeCode) || original.cause === undefined) break;
    original = original.cause;
  }
  if (original instanceof Error && !/^RESEARCH_[A-Z0-9_]+$/.test(original.message)) {
    const rawCode = (original as Error & {code?:unknown}).code;
    return sanitizeResearchSourceError({name:original.name || null, code: typeof rawCode==='string' || Number.isSafeInteger(rawCode) ? rawCode as string|number : null, message:original.message || unavailable},privacy);
  }
  return sanitizeResearchSourceError({name:null,code:null,message:typeof original==='string' && !/^RESEARCH_[A-Z0-9_]+$/.test(original) ? original : unavailable},privacy);
}
export class ResearchSourceFailure extends Error {
  readonly sourceError: ResearchSourceError;
  constructor(reason: string, original: unknown, privacy: DiagnosticPrivacy = {}, httpDetails?: ResearchSourceHttpDetails) {
    const detail = sanitizeResearchSourceError({...captureResearchSourceError(original,privacy), ...httpDetails},privacy);
    if (detail.message===unavailable && detail.httpStatusMessage) detail.message=detail.httpStatusMessage;
    const cause = Object.assign(new Error(detail.message), {name:detail.name ?? 'Error',code:detail.code});
    super(reason,{cause});
    this.sourceError=detail;
  }
}
export function formatResearchSourceError(value: unknown, privacy: DiagnosticPrivacy = {}): string {
  if (!isResearchSourceError(value)) return unavailable;
  const error = sanitizeResearchSourceError(value,privacy);
  return `Nazwa: ${error.name ?? 'brak'}; kod oryginalny: ${error.code ?? 'brak'}; komunikat: ${error.message}`
    + (error.httpStatus === undefined ? '' : `; HTTP: ${error.httpStatus}${error.httpStatusMessage ? ` ${error.httpStatusMessage}` : ''}`)
    + (error.providerCode === undefined ? '' : `; kod dostawcy: ${error.providerCode ?? 'brak'}`)
    + (error.providerMessage === undefined ? '' : `; komunikat dostawcy: ${error.providerMessage}`);
}
