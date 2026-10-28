import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { emitBrokerPhase, type BrokerPhaseDiagnostics, type BrokerPhaseEvent } from '../reconciliation/phase-diagnostics.js';
import { AccountingSourceService, type AccountingSource } from './source-service.js';
import { accountingError, accountingHash, type SourceSettingsV1 } from './types.js';

export type AccountingRuntimeState = 'WAITING_DATABASE' | 'ACQUIRING_OWNER' | 'CONNECTING_SOURCE' | 'QUALIFYING_SOURCE' | 'SYNCHRONIZING' | 'READY' | 'BACKOFF' | 'STOPPING';
export interface AccountingRuntimeOwner {
  assertCurrent(): void;
  assertInTransaction(db: Pick<PoolClient, 'query'>): Promise<void>;
}

/** Keeps consumer references stable while each source generation remains immutable. */
export class AccountingSourceRuntime implements AccountingSource {
  private current: AccountingSourceService | undefined;
  private generation = 0;
  private initialized = false;
  private stopped = false;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextSessionId = randomUUID();
  private failures = 0;
  private state: AccountingRuntimeState = 'WAITING_DATABASE';
  private lastError: string | null = null;
  private lastCause: BrokerPhaseEvent['cause'] = null;
  private nextRetryAt: string | null = null;
  constructor(readonly settings: SourceSettingsV1, readonly settingsHash: string,
    private readonly factory: (sourceSessionId: string, onLost: () => void) => AccountingSourceService,
    private readonly options: { onOwnerLost?: () => void; retryMs?: number; attemptTimeoutMs?: number; diagnostics?: BrokerPhaseDiagnostics } = {}) {}

  initialize(): Promise<void> { return this.tick(); }
  start(): void {
    if (this.stopped || this.timer) return;
    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.tick().catch(() => undefined).finally(schedule);
      }, this.options.retryMs ?? (this.failures ? [1000, 2000, 5000, 10000, 30000][Math.min(this.failures - 1, 4)] : 1000));
      this.timer.unref();
    };
    schedule();
  }
  private revoke(service: AccountingSourceService, generation: number): void {
    if (this.current !== service || generation !== this.generation) return;
    this.current = undefined;
    this.generation++;
    this.initialized = false;
    this.nextSessionId = randomUUID();
    this.state = 'BACKOFF';
    this.lastError = 'ACCOUNTING_SOURCE_OWNER_LOST';
    this.options.onOwnerLost?.();
    void this.cleanup(service);
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run(): Promise<void> {
    if (this.current && this.initialized) {
      const active = this.current;
      try {
        if (active.status().automaticClockRecovery?.state === 'RECOVERING') return;
        this.current.assertRuntimeOwnerCurrent();
        this.current.start();
        const status = active.status();
        if (['ACCOUNTING_PERSISTENCE_FAILED','ACCOUNTING_CLOCK_RECOVERY_OUTCOME_UNKNOWN'].includes(status.hold ?? '') || ['OUTCOME_UNKNOWN','OPERATOR_REQUIRED'].includes(status.automaticClockRecovery?.state ?? '')) {
          this.revoke(active, this.generation); return;
        }
        this.state = !status.hold ? 'READY' : /QUALIFICATION/.test(status.hold) ? 'QUALIFYING_SOURCE' : /EVIDENCE|REVISION|PERSISTENCE_PENDING/.test(status.hold) ? 'SYNCHRONIZING' : 'CONNECTING_SOURCE';
        this.lastError = status.hold;
        return;
      } catch {
        this.revoke(active, this.generation);
      }
    }
    if (this.stopped) return;
    const generation = ++this.generation;
    let service!: AccountingSourceService;
    this.state = 'ACQUIRING_OWNER';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      service = this.factory(this.nextSessionId, () => this.revoke(service, generation));
      this.current = service;
      await Promise.race([service.initialize(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(accountingError('SOURCE_STARTUP_TIMEOUT')), this.options.attemptTimeoutMs ?? 10000);
      })]);
      if (this.stopped || this.current !== service || generation !== this.generation) throw accountingError('SOURCE_OWNER_LOST');
      this.initialized = true;
      service.start();
      this.state = 'CONNECTING_SOURCE'; this.lastError = null; this.failures = 0; this.nextRetryAt = null;
    } catch (error) {
      if (this.current === service || !service) {
        if (error instanceof Error && error.message === 'ACCOUNTING_SOURCE_OWNER_ACQUISITION_RESOLVED_INACTIVE') this.nextSessionId = randomUUID();
        else try { service?.assertRuntimeOwnerCurrent(); this.nextSessionId = randomUUID(); } catch { /* Keep the acquisition identity until an unknown commit is resolved. */ }
        this.current = undefined; this.generation++; this.initialized = false;
        this.state = this.stopped ? 'STOPPING' : 'BACKOFF';
        this.lastError = error instanceof Error && /^ACCOUNTING_[A-Z_]+$/.test(error.message) ? error.message : 'ACCOUNTING_SOURCE_STARTUP_UNAVAILABLE';
        emitBrokerPhase({ privacy: this.options.diagnostics?.privacy, emit: event => { this.lastCause = event.cause; this.options.diagnostics?.emit(event); } },
          'accounting.startup', 'error', { reason: this.lastError }, undefined, error);
        this.failures++;
        this.nextRetryAt = new Date(Date.now() + (this.options.retryMs ?? [1000, 2000, 5000, 10000, 30000][Math.min(this.failures - 1, 4)])).toISOString();
        this.options.onOwnerLost?.();
      }
      if (service) await this.cleanup(service);
    } finally { clearTimeout(timer); }
  }
  private async cleanup(service: AccountingSourceService): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.resolve().then(() => service.close()).catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); }
  }
  async close(): Promise<void> {
    this.stopped = true; this.state = 'STOPPING'; clearTimeout(this.timer);
    const service = this.current; this.current = undefined; this.generation++; this.initialized = false;
    this.options.onOwnerLost?.();
    if (service) await this.cleanup(service);
    await this.running;
  }
  private source(): AccountingSourceService {
    if (!this.current || !this.initialized || this.stopped) throw accountingError('SOURCE_UNINITIALIZED');
    return this.current;
  }
  private async call<T>(job: (source: AccountingSourceService) => Promise<T>): Promise<T> {
    const source = this.source(), generation = this.generation;
    const result = await job(source);
    if (this.current !== source || this.generation !== generation || this.stopped) throw accountingError('SOURCE_OWNER_LOST');
    return result;
  }
  captureRuntimeOwner(): AccountingRuntimeOwner {
    const source = this.source(), generation = this.generation;
    const assertCurrent = () => {
      if (this.current !== source || this.generation !== generation || this.stopped) throw accountingError('SOURCE_OWNER_LOST');
      source.assertRuntimeOwnerCurrent();
    };
    assertCurrent();
    return { assertCurrent, assertInTransaction: async db => { assertCurrent(); await source.assertRuntimeOwnerInTransaction(db); assertCurrent(); } };
  }
  assertRuntimeOwnerCurrent(): void { this.captureRuntimeOwner().assertCurrent(); }
  async assertRuntimeOwnerInTransaction(db: Pick<PoolClient, 'query'>): Promise<void> { await this.captureRuntimeOwner().assertInTransaction(db); }
  assertCurrent(...args: Parameters<AccountingSource['assertCurrent']>): void { this.source().assertCurrent(...args); }
  status(): ReturnType<AccountingSourceService['status']> & { runtime: { state: AccountingRuntimeState; generation: number; lastError: string | null; nextRetryAt: string | null; originalCause: BrokerPhaseEvent['cause'] } } {
    const status = this.current?.status() ?? { configured: true, sourceId: accountingHash({ account: this.settings.accountId, kind: 'tws-accounting' }), qualificationId: null, expiresAt: null, sourceGeneration: 0,
      semanticRevision: 0, pending: 0, hold: this.lastError ?? 'ACCOUNTING_SOURCE_UNINITIALIZED', captureId: null, settingsHash: this.settingsHash, brokerReadOnly: true,
      automaticClockRecovery: { enabled: true, episodeId: null, state: 'IDLE' as const, attemptCount: 0, attemptLimit: null, nextAttemptAt: null,
        firstErrorAt: null, lastError: null, receiptId: null, captureId: null, entryBlocked: true, originalCause: null, rejectedClock: null } };
    return { ...status, runtime: { state: this.state, generation: this.generation, lastError: this.lastError, nextRetryAt: this.nextRetryAt, originalCause: this.lastCause } };
  }
  observeIngressFailure(...args: Parameters<AccountingSource['observeIngressFailure']>): void { if (this.initialized) this.current?.observeIngressFailure(...args); }
  observeOrderStatus(...args: Parameters<AccountingSource['observeOrderStatus']>): void { if (this.initialized) this.current?.observeOrderStatus(...args); }
  observeExecution(...args: Parameters<AccountingSource['observeExecution']>): void {
    if (this.initialized && this.current) this.current.observeExecution(...args);
    else void args[1]().catch(() => undefined);
  }
  observeCommission(...args: Parameters<AccountingSource['observeCommission']>): void {
    if (this.initialized && this.current) this.current.observeCommission(...args);
    else void args[1]().catch(() => undefined);
  }
  inspect(...args: Parameters<AccountingSource['inspect']>) { return this.call(s => s.inspect(...args)); }
  qualify(...args: Parameters<AccountingSource['qualify']>) { return this.call(s => s.qualify(...args)); }
  invalidate(...args: Parameters<AccountingSource['invalidate']>) { return this.call(s => s.invalidate(...args)); }
  join(...args: Parameters<AccountingSource['join']>) { return this.call(s => s.join(...args)); }
  readCapture(...args: Parameters<AccountingSource['readCapture']>) { return this.call(s => s.readCapture(...args)); }
  refreshRecoveryState() { return this.call(s => s.refreshRecoveryState()); }
  recoveryDatabaseTime() { return this.call(s => s.recoveryDatabaseTime()); }
  verificationExpired(...args: Parameters<AccountingSource['verificationExpired']>) { return this.call(s => s.verificationExpired(...args)); }
  recoveryIdentity() { return this.source().recoveryIdentity(); }
  requireRecoveryOperator(...args: Parameters<AccountingSource['requireRecoveryOperator']>) { return this.call(s => s.requireRecoveryOperator(...args)); }
  automaticRecovery(...args: Parameters<AccountingSource['automaticRecovery']>) { return this.call(s => s.automaticRecovery(...args)); }
  recoverClock(...args: Parameters<AccountingSource['recoverClock']>) { return this.call(s => s.recoverClock(...args)); }
}
