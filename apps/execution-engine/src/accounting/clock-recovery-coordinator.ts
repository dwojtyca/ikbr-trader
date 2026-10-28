import { performance } from 'node:perf_hooks';
import type { AccountingSource } from './source-service.js';
import { accountingHash, type AutomaticClockRecoveryStatus } from './types.js';

export class AccountingClockRecoveryCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private readonly abort = new AbortController();
  private stableIdentity = '';
  private stableSince = 0;
  private time: { monotonic: number; wall: number; database: number } | undefined;
  private capture: Promise<unknown> | undefined;
  private notification: Promise<void> | undefined;
  private notified = '';
  constructor(private readonly options: {
    source: AccountingSource;
    requestFreshCapture: () => Promise<unknown>;
    onState?: (snapshot: AutomaticClockRecoveryStatus) => void | Promise<void>;
    monotonicNow?: () => number;
  }) {}
  start(): void {
    if (this.timer || this.stopped) return;
    const next = () => { this.timer=setTimeout(() => { this.timer=undefined; void this.tick().catch(() => undefined).finally(() => { if(!this.stopped) next(); }); },5000); this.timer.unref(); };
    next();
  }
  async stop(): Promise<void> { this.stopped=true; clearTimeout(this.timer); this.abort.abort(); await this.running; }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running=this.run().finally(() => { this.running=undefined; }); return this.running;
  }
  private async notify(): Promise<void> {
    if(this.notification) return;
    const snapshot=this.options.source.status().automaticClockRecovery, hash=accountingHash(snapshot);
    if (hash===this.notified) return;
    const notification=Promise.resolve().then(()=>this.options.onState?.(snapshot)).then(()=>{this.notified=hash;});
    this.notification=notification;
    void notification.catch(()=>undefined).finally(()=>{if(this.notification===notification)this.notification=undefined;});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([notification,new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]); }
    finally {clearTimeout(timer);}
  }
  private async freshCapture(): Promise<void> {
    if(this.capture) return;
    const capture=Promise.resolve().then(()=>this.options.requestFreshCapture());
    this.capture=capture;
    void capture.catch(()=>undefined).finally(()=>{if(this.capture===capture) this.capture=undefined;});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([capture,new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]); }
    finally {clearTimeout(timer);}
  }
  private async run(): Promise<void> {
    const source=this.options.source;
    try {
      await source.refreshRecoveryState();
      const status=source.status().automaticClockRecovery;
      if (!status.enabled || !status.entryBlocked || ['OPERATOR_REQUIRED','OUTCOME_UNKNOWN'].includes(status.state)) return;
      const mono=this.options.monotonicNow?.() ?? performance.now(), wall=Date.now();
      const database=await source.recoveryDatabaseTime();
      if(this.time && (Math.abs((wall-this.time.wall)-(mono-this.time.monotonic))>2000 || Math.abs((database-this.time.database)-(mono-this.time.monotonic))>2000)) {
        if (status.attemptLimit === null) { this.time = undefined; this.stableIdentity = ''; }
        await source.requireRecoveryOperator('ACCOUNTING_CLOCK_RECOVERY_TIME_DISCONTINUITY'); return;
      }
      this.time={monotonic:mono,wall,database};
      if(status.state==='VERIFYING' && await source.verificationExpired(database)) { await source.requireRecoveryOperator('ACCOUNTING_CLOCK_RECOVERY_VERIFY_TIMEOUT'); return; }
      const identity=source.recoveryIdentity(), hash=accountingHash(identity);
      if(!identity.connected || identity.accountId!==source.settings.accountId) { this.stableIdentity=''; return; }
      if(hash!==this.stableIdentity) { this.stableIdentity=hash; this.stableSince=mono; return; }
      if(status.state==='VERIFYING') {
        await this.freshCapture(); await source.refreshRecoveryState(); return;
      }
      if(mono-this.stableSince<10000) return;
      try {
        const receipt=await source.automaticRecovery(this.abort.signal);
        if(receipt && !this.stopped) { await this.freshCapture(); await source.refreshRecoveryState(); }
      } catch(error) {
        const code=error instanceof Error ? error.message : '';
        if(code==='ACCOUNTING_SOURCE_BUSY') return;
        if(['ACCOUNTING_QUALIFICATION_REQUIRED','ACCOUNTING_QUALIFICATION_EXPIRED','ACCOUNTING_SETTINGS_MISMATCH'].includes(code)) await source.requireRecoveryOperator(code);
      }
    } finally { await this.notify(); }
  }
}
