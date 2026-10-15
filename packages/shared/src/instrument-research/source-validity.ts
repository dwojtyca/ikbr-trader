import { isResearchHash, researchAssert, researchTime } from './validation.js';

export interface OngoingSourceValidity {
  mode: 'OPERATOR_CONFIRMED_ONGOING';
  confirmedAt: string;
  confirmationRef: string;
  confirmationHash: string;
}
export type ResearchSourceValidity =
  | { expiresAt: string; validity?: never }
  | { expiresAt: null; validity: OngoingSourceValidity };

export function assertSourceValidity(record: Record<string, unknown>, start: unknown, reason: string): void {
  const started = researchTime(start);
  if (!Object.hasOwn(record, 'validity')) {
    researchAssert(record.expiresAt !== null && started < researchTime(record.expiresAt), reason);
    return;
  }
  const v = record.validity;
  researchAssert(record.expiresAt === null && v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype, reason);
  const value = v as Record<string, unknown>;
  researchAssert(Reflect.ownKeys(value).length === 4 && Object.keys(value).sort().join(' ') === 'confirmationHash confirmationRef confirmedAt mode', reason);
  for (const key of Object.keys(value)) researchAssert('value' in Object.getOwnPropertyDescriptor(value,key)!, reason);
  researchAssert(value.mode === 'OPERATOR_CONFIRMED_ONGOING' && researchTime(value.confirmedAt) >= started
    && typeof value.confirmationRef === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.confirmationRef)
    && isResearchHash(value.confirmationHash), reason);
}

/** A structural policy bound for diagnostics; use-time validation remains separate. */
export function sourceValidityExpiry(record: ResearchSourceValidity): number | null {
  return record.expiresAt === null ? null : researchTime(record.expiresAt);
}
export function assertSourceValidityAt(record: ResearchSourceValidity, start: string, now: number, reason: string): void {
  researchAssert(Number.isFinite(now) && researchTime(start) <= now, reason);
  researchAssert(record.expiresAt === null ? researchTime(record.validity.confirmedAt) <= now : now < researchTime(record.expiresAt), reason);
}
export function earliestSourceValidityExpiry(...records: ResearchSourceValidity[]): number | null {
  const finite = records.map(sourceValidityExpiry).filter((n): n is number => n !== null);
  return finite.length ? Math.min(...finite) : null;
}
