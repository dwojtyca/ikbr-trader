import { captureResearchSourceError, sanitizeResearchSourceError } from '@ikbr/shared/instrument-research';
import { type DiagnosticPrivacy } from '@ikbr/shared/diagnostics';

export type ContractResolutionOutcome = 'SUCCESS' | 'TIMEOUT' | 'BROKER_ERROR' | 'SEND_THROW' | 'NO_DETAILS' | 'AMBIGUOUS_DETAILS' | 'INTERRUPTED';
export type ContractSourceError = ReturnType<typeof captureResearchSourceError>;
export interface ContractTransportDiagnostic {
  generation: number;
  connected: boolean;
  retired: boolean;
  aborted: boolean;
  socketConnectedAt: string | null;
  serverAt: string | null;
  serverVersion: number | null;
  nextValidIdAt: string | null;
  disconnectedAt: string | null;
  retiredAt: string | null;
  globalContext: Array<{ observedAt: string | null; generation: number; sourceError: ContractSourceError }>;
  omittedGlobalMessages: number;
}
export interface ContractResolutionDiagnostic {
  schemaVersion: 1;
  attemptId: string;
  bootstrapAttempt: number | null;
  requestId: number;
  transportGeneration: number | null;
  instrumentId: string | null;
  label: string;
  query: Record<string, string | number>;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  timeoutMs: number;
  detailCount: number;
  endCount: number;
  sdkInvocationAttempted: boolean;
  sdkInvocationReturned: boolean;
  wireTransmission: 'UNAVAILABLE';
  outcome: ContractResolutionOutcome | null;
  sourceError: ContractSourceError | null;
  brokerCause: 'UNKNOWN' | 'REQUEST_ERROR_OBSERVED';
  transport: ContractTransportDiagnostic | null;
  currentTransportGeneration: number | null;
}
export interface ContractBootstrapFailures {
  attempt: number;
  failures: ContractResolutionDiagnostic[];
  omittedFailures: number;
  truncated: boolean;
}
export interface ContractDiagnosticEvent {
  event: 'contract_resolution_started' | 'contract_resolution_finished' | 'broker_context';
  message: string;
  diagnostic?: ContractResolutionDiagnostic;
  context?: { observedAt: string | null; generation: number; sourceError: ContractSourceError; requestId: number | null; scope: 'GLOBAL' | 'REQUEST' };
}

export function contractDiagnosticText(value: string, privacy: DiagnosticPrivacy = {}, max = 100): string {
  const safe = sanitizeResearchSourceError({ name: null, code: null, message: value }, privacy).message;
  return safe.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[ADRES UKRYTY]')
    .replace(/\{[\s\S]*$/, '[DANE UKRYTE]')
    .replace(/\[(?=\s*(?:"|\{|\[|-?\d|true\b|false\b|null\b))[\s\S]*$/, '[DANE UKRYTE]').slice(0, max);
}
export function contractSourceError(error: unknown, privacy: DiagnosticPrivacy = {}, originalCode?: unknown): ContractSourceError {
  const captured = captureResearchSourceError(error, privacy);
  const code = typeof originalCode === 'string' || Number.isSafeInteger(originalCode) ? originalCode as string | number : captured.code;
  return sanitizeResearchSourceError({
    name: captured.name === null ? null : contractDiagnosticText(captured.name, privacy),
    code: typeof code === 'string' ? contractDiagnosticText(code, privacy) : code,
    message: contractDiagnosticText(captured.message, privacy, 1000),
  }, privacy);
}
export function contractQueryDiagnostic(contract: Record<string, unknown>, privacy: DiagnosticPrivacy = {}): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const key of ['conId', 'symbol', 'secType', 'exchange', 'primaryExch', 'primaryExchange', 'currency', 'localSymbol', 'tradingClass']) {
    const value = contract[key];
    if (typeof value === 'string') result[key] = contractDiagnosticText(value, privacy);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}
export function contractDiagnosticTimestamp(now: number): string | null {
  return Number.isFinite(now) && Math.abs(now) <= 8.64e15 ? new Date(now).toISOString() : null;
}
export function contractDiagnosticMessage(diagnostic: ContractResolutionDiagnostic): string {
  if (diagnostic.outcome === null) return 'Rozpoczęto odczyt opisu kontraktu; wywołanie SDK nie potwierdza wysłania ani odbioru przez brokera';
  switch (diagnostic.outcome) {
    case 'SUCCESS': return 'Odebrano opis kontraktu i znacznik końca; weryfikacja instrumentu i gotowość danych są osobnymi etapami';
    case 'TIMEOUT': return 'Upłynął czas oczekiwania na opis kontraktu; przyczyna po stronie brokera jest nieznana';
    case 'BROKER_ERROR': return 'Odczyt opisu kontraktu zakończony błędem przypisanym do tego żądania';
    case 'SEND_THROW': return 'Lokalne wywołanie SDK opisu kontraktu zgłosiło wyjątek';
    case 'NO_DETAILS': return 'Odebrano koniec odpowiedzi bez opisu kontraktu';
    case 'AMBIGUOUS_DETAILS': return 'Odebrano więcej niż jeden pasujący opis kontraktu';
    case 'INTERRUPTED': return 'Odczyt opisu kontraktu przerwany; kontekst połączenia nie jest błędem przypisanym do instrumentu';
  }
}
export function emitContractDiagnostic(callback: ((event: ContractDiagnosticEvent) => void) | undefined, event: ContractDiagnosticEvent): void {
  try { callback?.(structuredClone(event)); } catch { /* Diagnostics must not affect read settlement or cleanup. */ }
}
