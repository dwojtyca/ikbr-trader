interface ReadRecoveryDependencies {
  pause(): void;
  invalidatePublications(): void;
  invalidateNativeRefresh(): void;
  invalidateScheduleRequests(): void;
  disconnect(): void;
  clearLocalState(): void;
  invalidateSchedules(): Promise<unknown>;
  drainPublications(): Promise<unknown>;
  drainNativeRefresh(): Promise<unknown>;
  drainSchedules(): Promise<unknown>;
  connect(): Promise<void>;
  probe(): Promise<void>;
  onInvalidationError(error: unknown): void;
  now?: () => number;
}

/** Shared production ordering for retiring readers, draining storage and reopening publication. */
export class ReadRecoverySession {
  private invalidating: Promise<unknown> = Promise.resolve();
  private drainSince: number | undefined;
  constructor(private readonly deps: ReadRecoveryDependencies) {}

  invalidate(): void {
    this.deps.pause();
    this.drainSince ??= this.now();
    this.deps.invalidatePublications();
    this.deps.invalidateNativeRefresh();
    this.deps.invalidateScheduleRequests();
    this.deps.disconnect();
    this.deps.clearLocalState();
    this.invalidating = this.deps.invalidateSchedules();
    void this.invalidating.catch(error => this.deps.onInvalidationError(error));
  }

  diagnostics(): { state: string; since: string | null; elapsedMs: number | null } {
    const now = this.now(), since = this.drainSince;
    const validSince = since !== undefined && Number.isFinite(since) && Math.abs(since) <= 8.64e15;
    return { state: since === undefined ? 'IDLE' : 'DRAIN_WAITING_STORAGE',
      since: validSince ? new Date(since).toISOString() : null,
      elapsedMs: since === undefined ? 0 : validSince && Number.isFinite(now) && now >= since ? now - since : null };
  }

  async drain(): Promise<void> {
    this.drainSince ??= this.now();
    await Promise.all([this.invalidating, this.deps.drainPublications(), this.deps.drainNativeRefresh(), this.deps.drainSchedules()]);
    this.drainSince = undefined;
  }

  async bootstrap<T>(current: () => boolean, prepare: () => Promise<T>, publish: (result: T) => void): Promise<T> {
    const assertCurrent = () => { if (!current()) throw new Error('INGESTION_BOOTSTRAP_INTERRUPTED'); };
    assertCurrent();
    this.deps.pause();
    await this.drain(); assertCurrent();
    await this.deps.connect(); assertCurrent();
    await this.deps.probe(); assertCurrent();
    const result = await prepare(); assertCurrent();
    publish(result); assertCurrent();
    return result;
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
}
