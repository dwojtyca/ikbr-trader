import type { RuntimeOwnerGuard, TwsExecutionClient } from './tws-execution-client.js';

export async function readCurrentBrokerAccounts(client: Pick<TwsExecutionClient, 'connect' | 'getManagedAccounts' | 'isConnected' | 'getConnectionGeneration'>,
  owner?: RuntimeOwnerGuard): Promise<{ accounts: string[]; generation: number; assertCurrent(): void }> {
  owner?.assertCurrent();
  await client.connect();
  const generation = client.getConnectionGeneration();
  const accounts = await client.getManagedAccounts();
  const assertCurrent = () => {
    owner?.assertCurrent();
    if (!client.isConnected() || client.getConnectionGeneration() !== generation) throw Error('EXECUTION_SESSION_CHANGED');
  };
  assertCurrent();
  return { accounts, generation, assertCurrent };
}

export class BrokerSessionRecovery {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private failures = 0;
  private stopped = false;
  private abortAttempt?: () => void;
  constructor(private readonly deps: {
    signal: AbortSignal;
    current(): boolean;
    hydrate(): Promise<void>;
    cancel(): void;
    recovered(): void;
    failed(error: unknown, retryMs: number): void;
    timeoutMs?: number;
  }) {}
  private retryMs() { return this.failures ? [1000, 2000, 5000, 10000, 30000][Math.min(this.failures-1, 4)] : 1000; }
  start(): void {
    if (this.stopped || this.timer || this.running) return;
    const schedule = () => {
      if (this.stopped || this.deps.signal.aborted) return;
      this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(schedule); }, this.retryMs());
      this.timer.unref();
    };
    void this.tick().finally(schedule);
  }
  tick(): Promise<void> {
    if (this.stopped || this.deps.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (this.deps.current()) { this.failures = 0; return; }
      await Promise.race([this.deps.hydrate(), new Promise<never>((_, reject) => {
        onAbort = () => { this.deps.cancel(); reject(Error('EXECUTION_SESSION_RECOVERY_ABORTED')); };
        this.abortAttempt = onAbort;
        this.deps.signal.addEventListener('abort', onAbort, { once: true });
        if (this.deps.signal.aborted) onAbort();
        timeout = setTimeout(() => { this.deps.cancel(); reject(Error('EXECUTION_SESSION_RECOVERY_TIMEOUT')); }, this.deps.timeoutMs ?? 22000);
      })]);
      if (this.stopped || this.deps.signal.aborted) return;
      if (!this.deps.current()) throw Error('EXECUTION_SESSION_CHANGED');
      this.failures = 0;
      this.deps.recovered();
    } catch (error) {
      if (!this.stopped && !this.deps.signal.aborted) { this.failures++; this.deps.failed(error, this.retryMs()); }
    } finally {
      clearTimeout(timeout);
      this.abortAttempt = undefined;
      if (onAbort) this.deps.signal.removeEventListener('abort', onAbort);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer);
    if (this.abortAttempt) this.abortAttempt(); else this.deps.cancel();
    await this.running;
  }
}
