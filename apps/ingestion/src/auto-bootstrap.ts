export interface AutoBootstrapDependencies<T> {
  enabled: boolean;
  readStopped(): Promise<boolean>;
  writeStopped(stopped: boolean): Promise<void>;
  bootstrap(isCurrent: () => boolean): Promise<T>;
  stop(): Promise<void>;
  ready(): boolean;
  now?: () => number;
}

/** Serializes control changes and keeps recovery behind a durable operator stop. */
export class AutoBootstrapController<T> {
  private initialized = false;
  private stopped = true;
  private closed = false;
  private generation = 0;
  private needed = true;
  private failures = 0;
  private nextAttemptAt = 0;
  private flight: Promise<T> | null = null;
  private controls: Promise<unknown> = Promise.resolve();
  private pendingControls = 0;
  private error: string | null = null;
  constructor(private readonly deps: AutoBootstrapDependencies<T>) {}

  async initialize(): Promise<void> {
    this.stopped = await this.deps.readStopped();
    this.initialized = true;
  }

  invalidate(): void {
    this.generation++;
    this.needed = true;
  }

  diagnostics() {
    return { enabled: this.deps.enabled, initialized: this.initialized, manuallyStopped: this.stopped,
      shuttingDown: this.closed, inFlight: this.flight !== null, recoveryNeeded: this.needed,
      failures: this.failures, nextAttemptAt: this.nextAttemptAt ? new Date(this.nextAttemptAt).toISOString() : null,
      error: this.error };
  }

  async tick(): Promise<void> {
    if (!this.initialized || !this.deps.enabled || this.closed || this.stopped || this.pendingControls || this.flight
      || (!this.needed && this.deps.ready()) || this.now() < this.nextAttemptAt) return;
    await this.launch();
  }

  async startManually(): Promise<T> {
    const { flight } = await this.serialize(async () => {
      if (!this.initialized || this.closed) throw new Error('INGESTION_START_UNAVAILABLE');
      try { await this.deps.writeStopped(false); }
      catch (error) {
        this.inhibit();
        await this.drainAndStop();
        this.error = 'INGESTION_CONTROL_PERSISTENCE_FAILED';
        throw error;
      }
      this.stopped = false;
      this.needed = true;
      this.nextAttemptAt = 0;
      return { flight: this.launch() };
    });
    return flight;
  }

  async stopManually(): Promise<void> {
    this.inhibit();
    await this.serialize(async () => {
      this.inhibit();
      let persistenceError: unknown;
      try { await this.deps.writeStopped(true); }
      catch (error) { persistenceError = error; this.error = 'INGESTION_CONTROL_PERSISTENCE_FAILED'; }
      await this.drainAndStop();
      if (persistenceError) throw persistenceError;
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.inhibit();
    await this.serialize(() => this.drainAndStop());
  }

  private inhibit(): void { this.stopped = true; this.generation++; }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private async drainAndStop(): Promise<void> {
    await this.flight?.catch(() => undefined);
    await this.deps.stop();
  }
  private serialize<R>(action: () => Promise<R>): Promise<R> {
    this.pendingControls++;
    const result = this.controls.then(action);
    this.controls = result.catch(() => undefined).finally(() => { this.pendingControls--; });
    return result;
  }
  private launch(): Promise<T> {
    if (this.flight) return this.flight;
    if (this.closed || this.stopped) return Promise.reject(new Error('INGESTION_START_UNAVAILABLE'));
    const generation = this.generation;
    const current = () => !this.closed && !this.stopped && generation === this.generation;
    this.flight = Promise.resolve().then(() => this.deps.bootstrap(current)).then(result => {
      if (!current()) throw new Error('INGESTION_BOOTSTRAP_INTERRUPTED');
      if (!this.deps.ready()) throw new Error('INGESTION_SUBSCRIPTIONS_INCOMPLETE');
      this.needed = false;
      this.failures = 0;
      this.nextAttemptAt = 0;
      this.error = null;
      return result;
    }).catch(error => {
      this.needed = true;
      this.failures++;
      this.nextAttemptAt = this.now() + Math.min(300_000, 30_000 * 2 ** Math.min(this.failures - 1, 4));
      this.error = 'INGESTION_BOOTSTRAP_FAILED';
      throw error;
    }).finally(() => { this.flight = null; });
    return this.flight;
  }
}
