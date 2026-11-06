import { captureResearchSourceError } from "@ikbr/shared/instrument-research";
import type { DiagnosticPrivacy } from "@ikbr/shared/diagnostics";
export interface AutoBootstrapDependencies<T> {
  enabled: boolean;
  readStopped(): Promise<boolean>;
  writeStopped(stopped: boolean): Promise<void>;
  bootstrap(isCurrent: () => boolean): Promise<T>;
  stop(): Promise<void>;
  ready(): boolean;
  now?: () => number;
  privacy?: DiagnosticPrivacy;
  probe?(): Promise<void>;
  invalidateReads?(): void;
  drainStatus?(): { state: string; since: string | null; elapsedMs?: number | null };
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
  private cause: ReturnType<typeof captureResearchSourceError> | null = null;
  private lastTickAt: number | undefined;
  private lastProbeAt = -Infinity;
  private lastProbeSuccess: string | null = null;
  private lastGap: string | null = null;
  private reason: string | null = null;
  private revoked = false;
  private probing: Promise<void> | null = null;
  constructor(private readonly deps: AutoBootstrapDependencies<T>) {}

  async initialize(): Promise<void> {
    this.stopped = await this.deps.readStopped();
    this.initialized = true;
  }

  invalidate(reason = 'CONNECTION_INVALIDATED'): void {
    if (this.revoked) return;
    this.revoked = true;
    this.generation++;
    this.needed = true;
    this.reason = reason;
    this.lastProbeSuccess = null;
    this.deps.invalidateReads?.();
  }

  /** Also checked before accepting buffered socket events, before overdue timers run. */
  continuous(): boolean {
    if (!this.initialized || !this.deps.enabled || this.stopped || this.closed) return true;
    const now = this.now();
    if (!Number.isFinite(now) || (this.lastTickAt !== undefined &&
      (now < this.lastTickAt || now - this.lastTickAt >= 30_000))) {
      this.lastGap = Number.isFinite(now) ? new Date(now).toISOString() : 'INVALID_CLOCK';
      this.lastTickAt = Number.isFinite(now) ? now : undefined;
      this.invalidate('SCHEDULING_INTERRUPTION');
      return false;
    }
    return !this.revoked;
  }

  diagnostics() {
    return { enabled: this.deps.enabled, initialized: this.initialized, manuallyStopped: this.stopped,
      shuttingDown: this.closed, inFlight: this.flight !== null, recoveryNeeded: this.needed,
      failures: this.failures, nextAttemptAt: this.nextAttemptAt ? new Date(this.nextAttemptAt).toISOString() : null,
      error: this.error, cause: this.cause, generation: this.generation, recoveryReason: this.reason,
      lastSchedulingInterruption: this.lastGap, lastProbeSuccess: this.lastProbeSuccess,
      probing: this.probing !== null, drain: this.deps.drainStatus?.() };
  }

  async tick(): Promise<void> {
    if (!this.initialized || !this.deps.enabled || this.closed || this.stopped) return;
    this.continuous();
    const now = this.now();
    if (!Number.isFinite(now)) return;
    this.lastTickAt = now;
    if (this.pendingControls || this.flight || this.probing || now < this.nextAttemptAt) return;
    if (!this.needed && this.deps.ready()) {
      if (!this.deps.probe || now - this.lastProbeAt < 30_000) return;
      const generation = this.generation;
      this.lastProbeAt = now;
      this.probing = Promise.resolve().then(() => this.deps.probe!()).then(() => {
        if (generation !== this.generation || this.closed || this.stopped || !this.continuous() || generation !== this.generation) return;
        this.lastProbeSuccess = new Date(this.now()).toISOString();
      }).catch(error => {
        if (!this.closed && !this.stopped) {
          this.invalidate('LIVENESS_UNAVAILABLE');
          this.failed(error);
        }
        throw error;
      }).finally(() => { this.probing = null; });
      await this.probing;
      return;
    }
    await this.launch();
  }

  async startManually(): Promise<T> {
    const { flight } = await this.serialize(async () => {
      if (!this.initialized || this.closed) throw new Error('INGESTION_START_UNAVAILABLE');
      try { await this.deps.writeStopped(false); }
      catch (error) {
        this.inhibit();
        await this.drainAndStop();
        this.error = 'INGESTION_CONTROL_PERSISTENCE_FAILED'; this.cause = captureResearchSourceError(error, this.deps.privacy);
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
      catch (error) { persistenceError = error; this.error = 'INGESTION_CONTROL_PERSISTENCE_FAILED'; this.cause = captureResearchSourceError(error, this.deps.privacy); }
      await this.drainAndStop();
      if (persistenceError) throw persistenceError;
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.inhibit();
    await this.serialize(() => this.drainAndStop());
  }

  private inhibit(): void {
    this.stopped = true;
    this.invalidate('OPERATOR_STOP_OR_SHUTDOWN');
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private async drainAndStop(): Promise<void> {
    await this.probing?.catch(() => undefined);
    await this.flight?.catch(() => undefined);
    await this.deps.stop();
  }
  private serialize<R>(action: () => Promise<R>): Promise<R> {
    this.pendingControls++;
    const result = this.controls.then(action);
    this.controls = result.catch(() => undefined).finally(() => { this.pendingControls--; });
    return result;
  }
  private failed(error: unknown): void {
    this.cause = captureResearchSourceError(error, this.deps.privacy);
    this.failures++;
    this.nextAttemptAt = this.now() + Math.min(300_000, 30_000 * 2 ** Math.min(this.failures - 1, 4));
    this.error = 'INGESTION_BOOTSTRAP_FAILED';
  }
  private launch(): Promise<T> {
    if (this.flight) return this.flight;
    if (this.closed || this.stopped) return Promise.reject(new Error('INGESTION_START_UNAVAILABLE'));
    this.revoked = false;
    this.lastTickAt = this.now();
    const generation = this.generation;
    const current = () => !this.closed && !this.stopped && generation === this.generation
      && this.continuous() && generation === this.generation;
    this.flight = Promise.resolve().then(() => this.deps.bootstrap(current)).then(result => {
      if (!current()) throw new Error('INGESTION_BOOTSTRAP_INTERRUPTED');
      if (!this.deps.ready()) throw new Error('INGESTION_SUBSCRIPTIONS_INCOMPLETE');
      this.needed = false;
      this.failures = 0;
      this.nextAttemptAt = 0;
      this.error = null;
      this.cause = null;
      this.reason = null;
      this.lastProbeAt = this.now();
      return result;
    }).catch(error => {
      this.needed = true;
      this.invalidate('BOOTSTRAP_FAILED');
      this.failed(error);
      throw error;
    }).finally(() => { this.flight = null; });
    return this.flight;
  }
}
