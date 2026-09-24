import { requireAaplSchedule, type AaplSchedule, type AaplScheduleEvidence } from "@ikbr/shared";
export class AaplScheduleRefresh {
  lastError: string | undefined;
  private running: Promise<AaplScheduleEvidence | null> | undefined;
  private invalidating: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private lastAttempt = -Infinity;
  constructor(private readonly deps: {
    read(): Promise<AaplScheduleEvidence | null>;
    begin(status: 'REFRESHING' | 'FAILED'): Promise<number>;
    finish(generation: number, schedule: AaplSchedule | null): Promise<boolean>;
    fetch(): Promise<AaplSchedule>;
    now?: () => number;
  }) {}
  invalidate(): Promise<void> {
    // Serialize database invalidation, preserving the generation fence across in-flight callbacks.
    this.lastAttempt = -Infinity;
    const pending = this.invalidating.catch(() => undefined).then(() => this.deps.begin('FAILED'));
    this.invalidating = pending;
    return pending.then(() => undefined);
  }
  ensure(): Promise<AaplScheduleEvidence | null> {
    if (this.running) return this.running;
    this.running = this.refresh().catch(error => {
      this.lastError = error instanceof Error ? error.message : 'aapl_schedule_refresh_failed';
      throw error;
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async idle(): Promise<void> { await this.running; await this.invalidating; }
  private async refresh(): Promise<AaplScheduleEvidence | null> {
    if (!this.initialized) { this.initialized = true; await this.invalidate(); }
    try { await this.invalidating; } catch { await this.invalidate(); }
    const now = this.deps.now?.() ?? Date.now();
    const evidence = await this.deps.read();
    let due = true;
    try {
      const schedule = requireAaplSchedule(evidence, now);
      const received = Date.parse(schedule.receivedAt);
      const crossedOpen = schedule.sessions.some(x => Date.parse(x.start) > received && Date.parse(x.start) <= now);
      due = now - received >= 3600000 || crossedOpen;
    } catch { /* Missing, stale or invalidated evidence must be refreshed. */ }
    if (!due || now - this.lastAttempt < 60000) return evidence;
    this.lastAttempt = now;
    const generation = await this.deps.begin('REFRESHING');
    try {
      const schedule = await this.deps.fetch();
      requireAaplSchedule({ generation, status: 'READY', schedule, updatedAt: schedule.receivedAt }, this.deps.now?.() ?? Date.now());
      await this.invalidating;
      if (await this.deps.finish(generation, schedule)) this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "aapl_schedule_fetch_failed";
      await this.deps.finish(generation, null);
    }
    await this.invalidating;
    return this.deps.read();
  }
}
