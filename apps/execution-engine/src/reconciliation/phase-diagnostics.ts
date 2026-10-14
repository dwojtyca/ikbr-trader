import { performance } from 'node:perf_hooks';
import { safeDiagnosticText, type DiagnosticPrivacy } from '@ikbr/shared/diagnostics';
import { canonicalRunId } from './run-id.js';

export interface BrokerPhaseMetadata {
  runId?: number | string;
  captureId?: number;
  requestId?: number;
  generation?: number;
  caller?: 'periodic' | 'explicit' | 'fresh';
  reason?: string;
}
export interface BrokerPhaseEvent extends Omit<BrokerPhaseMetadata, 'runId'> {
  runId?: number;
  phase: string;
  outcome: 'ok' | 'error' | 'milestone' | 'skipped';
  durationMs: number | null;
  cause: { name: string | null; code: string | null; message: string | null } | null;
}
export interface BrokerPhaseDiagnostics {
  emit(event: BrokerPhaseEvent): void;
  privacy?: () => DiagnosticPrivacy;
}
export function brokerDiagnosticPrivacy(environment: NodeJS.ProcessEnv,
  config: { allowedPaperAccounts: readonly string[]; allowedLiveAccounts: readonly string[] }, activeAccountId: string | null): DiagnosticPrivacy {
  return { accountIds: [...config.allowedPaperAccounts, ...config.allowedLiveAccounts, ...(activeAccountId ? [activeAccountId] : [])],
    secrets: Object.entries(environment).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY|CHAT_ID/i.test(key))
      .map(([, value]) => value).filter((value): value is string => Boolean(value)) };
}
export function emitBrokerPhase(diagnostics: BrokerPhaseDiagnostics | undefined, phase: string,
  outcome: BrokerPhaseEvent['outcome'], metadata: BrokerPhaseMetadata = {}, durationMs?: number, error?: unknown): void {
  if (!diagnostics) return;
  try {
    const privacy = diagnostics.privacy?.() ?? {};
    const safe = (value: unknown): string | null => typeof value === 'string' ? safeDiagnosticText(value, privacy)
      : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
    const cause = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; message?: unknown } : null;
    const event: BrokerPhaseEvent = { phase: safeDiagnosticText(phase, privacy), outcome,
      durationMs: durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
      cause: error === undefined ? null : { name: safe(cause?.name), code: safe(cause?.code), message: safe(cause?.message) } };
    const runId = canonicalRunId(metadata.runId);
    if (runId !== null) event.runId = runId;
    if (Number.isSafeInteger(metadata.captureId) && metadata.captureId! > 0) event.captureId = metadata.captureId;
    for (const key of ['requestId', 'generation'] as const) {
      if (Number.isSafeInteger(metadata[key]) && metadata[key]! >= 0) event[key] = metadata[key];
    }
    if (metadata.caller && ['periodic', 'explicit', 'fresh'].includes(metadata.caller)) event.caller = metadata.caller;
    if (metadata.reason !== undefined) event.reason = safeDiagnosticText(metadata.reason, privacy);
    diagnostics.emit(event);
  } catch { /* Diagnostics cannot change broker evidence or recovery behavior. */ }
}
export async function brokerPhase<T>(diagnostics: BrokerPhaseDiagnostics | undefined, phase: string,
  metadata: BrokerPhaseMetadata, job: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await job();
    emitBrokerPhase(diagnostics, phase, 'ok', metadata, performance.now() - started);
    return result;
  } catch (error) {
    emitBrokerPhase(diagnostics, phase, 'error', metadata, performance.now() - started, error);
    throw error;
  }
}
