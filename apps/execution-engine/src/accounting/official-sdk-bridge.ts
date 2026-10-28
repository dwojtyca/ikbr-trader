import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { accountingError, type SourceSettingsV1 } from './types.js';

export const OFFICIAL_SDK_SHA256 = '50a459ed09f0030df25125a177e57b69bdf576ec3a89fcb1f81fdff95bbf6316';
export interface ConfigEvidence { masterClientIdPresent: true; masterClientId: 0 }
export interface ExplicitExecutionFilter { clientId: number; acctCode: string; time: string; symbol: string; secType: string; exchange: string; side: string; lastNDays?: number }
const safeInt = z.number().int().safe();
const text = z.string().min(1).max(200);
const finite = z.number().finite().min(-1e99).max(1e99);
const envelope = z.object({ v: z.literal(1), sessionId: z.string().uuid(), generation: safeInt.positive(), seq: safeInt.positive(),
  type: text, commandId: safeInt.positive().optional(), requestId: safeInt.positive().optional(), payload: z.unknown() }).strict();
const execPayload = z.object({ ibRequestId: safeInt, contract: z.object({ conId: safeInt.positive(), symbol: text, secType: text, currency: text }).strict(),
  execution: z.object({ orderId: safeInt, execId: text, time: text, acctNumber: text, exchange: text, side: z.enum(['BOT', 'SLD', 'BUY', 'SELL']),
    shares: z.string().max(80).regex(/^\d+(?:\.\d+)?$/), price: finite.positive(), permId: z.string().regex(/^\d+$/).max(30).optional(),
    clientId: safeInt.nonnegative().optional(), orderRef: z.string().max(200).optional(), pendingPriceRevision: z.boolean().optional() }).strict() }).strict();
const empty = z.object({}).strict();
interface Pending { type: string; timer: ReturnType<typeof setTimeout>; externalId?: number; resolve?: (value: ConfigEvidence) => void; reject?: (error: Error) => void }
export class OfficialAccountingSocket extends EventEmitter {
  readonly automatic = true;
  readonly sdkSha256 = OFFICIAL_SDK_SHA256;
  serverVersion = 0;
  private child?: ChildProcessWithoutNullStreams;
  private readonly sessionId = randomUUID();
  private sequence = 0;
  private received = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private closing = false;
  private closed = false;
  private terminateTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly endpoint: SourceSettingsV1['endpoint'], private readonly accountId: string,
    private readonly launch: typeof spawn = spawn) { super(); }
  connect(): void {
    if (this.child || this.closing) throw accountingError('SOCKET_REUSED');
    this.child = this.launch('/opt/ikbr-sdk/bin/python', ['-I', '-u', fileURLToPath(new URL('../../python/accounting_reader.py', import.meta.url))],
      { shell: false, env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on('data', () => this.fail(accountingError('SDK_STDERR')));
    this.child.on('error', () => this.fail(accountingError('SDK_PROCESS_FAILED')));
    this.child.stdin.on('error', () => this.fail(accountingError('SDK_INPUT_FAILED')));
    this.child.on('close', () => {
      this.closed = true;
      clearTimeout(this.terminateTimer); clearTimeout(this.killTimer);
      const incomplete = this.buffer.length > 0 || this.pending.size > 0;
      this.rejectPending(accountingError('SOURCE_GAP'));
      if (!this.closing || incomplete) this.emit('error', accountingError('SDK_PROCESS_EXIT'));
      this.emit('disconnected'); this.emit('transportClosed');
    });
    this.command('connect', { ...this.endpoint, clientId: 0, accountId: this.accountId });
  }
  private rejectPending(error: Error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject?.(error); } this.pending.clear(); }
  private fail(error: Error): void { if (!this.closing) { this.emit('error', error); this.disconnect(); } }
  private command(type: string, payload: unknown, extra: Partial<Pending> = {}): number {
    if (!this.child || this.closing || this.pending.size >= 32 || [...this.pending.values()].some(p => p.type === type)) throw accountingError('SDK_COMMAND_UNAVAILABLE');
    const id = ++this.sequence;
    const message = JSON.stringify({ v: 1, sessionId: this.sessionId, generation: 1, seq: id, type, commandId: id, requestId: id, payload }) + '\n';
    if (Buffer.byteLength(message) > 16384 || this.child.stdin.writableLength + Buffer.byteLength(message) > 1048576) throw accountingError('SDK_INPUT_OVERFLOW');
    const timer = setTimeout(() => this.fail(accountingError('SDK_COMMAND_TIMEOUT')), 30000);
    this.pending.set(id, { type, timer, ...extra });
    this.child.stdin.write(message);
    return id;
  }
  private receive(chunk: Buffer): void {
    if (this.closing) return;
    try {
      if (this.buffer.length + chunk.length > 1048576) throw accountingError('SDK_OUTPUT_OVERFLOW');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end: number;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        if (end > 65535) throw accountingError('SDK_OUTPUT_OVERFLOW');
        const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        this.event(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
      }
      if (this.buffer.length > 65535) throw accountingError('SDK_OUTPUT_OVERFLOW');
    } catch { this.fail(accountingError('SDK_PROTOCOL_INVALID')); }
  }
  private event(raw: unknown): void {
    const message = envelope.parse(raw);
    if (message.sessionId !== this.sessionId || message.generation !== 1 || message.seq !== ++this.received) throw accountingError('SDK_GENERATION_INVALID');
    const p = message.commandId === undefined ? undefined : this.pending.get(message.commandId);
    if (message.commandId !== message.requestId || message.commandId !== undefined && !p) throw accountingError('SDK_CORRELATION_INVALID');
    const complete = (family: string) => { if (!p || p.type !== family) throw accountingError('SDK_CORRELATION_INVALID'); clearTimeout(p.timer); this.pending.delete(message.commandId!); return p; };
    switch (message.type) {
      case 'connected': {
        const v = z.object({ sdkVersion: z.literal('1051.1'), protobufVersion: z.literal('5.29.5'), sdkSha256: z.literal(OFFICIAL_SDK_SHA256), serverVersion: safeInt.min(219).max(226), connectionTime: z.string().max(200) }).strict().parse(message.payload);
        complete('connect'); this.serverVersion = v.serverVersion; this.emit('server', v.serverVersion, v.connectionTime); this.emit('nextValidId', 0); break;
      }
      case 'managedAccounts': { const v = z.object({ accounts: z.array(text).max(100) }).strict().parse(message.payload); complete('managedAccounts'); this.emit('managedAccounts', v.accounts.join(',')); break; }
      case 'clock': { const v = z.object({ milliseconds: safeInt.positive() }).strict().parse(message.payload); complete('clock'); this.emit('currentTimeInMillis', v.milliseconds); break; }
      case 'config': { const v = z.object({ masterClientIdPresent: z.literal(true), masterClientId: z.literal(0) }).strict().parse(message.payload); complete('config').resolve?.(v); break; }
      case 'execution': {
        const v = execPayload.parse(message.payload);
        if (v.execution.acctNumber !== this.accountId || !Number.isFinite(Number(v.execution.shares)) || Number(v.execution.shares) <= 0) throw accountingError('IDENTITY_INVALID');
        if (v.ibRequestId !== -1 && (!p || p.type !== 'executions' || v.ibRequestId !== message.requestId) || v.ibRequestId === -1 && p) throw accountingError('SDK_CORRELATION_INVALID');
        this.emit('execDetails', v.ibRequestId === -1 ? -1 : p!.externalId, v.contract, { ...v.execution, shares: Number(v.execution.shares) }); break;
      }
      case 'commission': {
        if (p) throw accountingError('SDK_CORRELATION_INVALID');
        const v = z.object({ execId: text, currency: text, commission: finite.nullable(), realizedPNL: finite.nullable() }).strict().parse(message.payload);
        this.emit('commissionReport', v); break;
      }
      case 'executionsEnd': empty.parse(message.payload); this.emit('execDetailsEnd', complete('executions').externalId); break;
      case 'disconnected': empty.parse(message.payload); this.fail(accountingError('SOURCE_GAP')); break;
      case 'error': {
        const v = z.object({ origin: z.enum(['ibkr', 'sdk', 'bridge']), name: z.string().max(100).nullable(), code: z.union([safeInt, z.string().max(100), z.null()]), message: z.string().max(512).nullable() }).strict().parse(message.payload);
        const error = Object.assign(new Error(v.message ?? 'SDK error detail unavailable'), { name: v.name ?? 'Error', code: v.code });
        this.emit('error', error, v.code);
        if (![2104, 2106, 2107, 2108, 2158].includes(Number(v.code))) this.disconnect();
        break;
      }
      default: throw accountingError('SDK_EVENT_UNSUPPORTED');
    }
  }
  reqManagedAccts() { this.command('managedAccounts', {}); }
  reqCurrentTime() { this.command('clock', {}); }
  reqConfig(): Promise<ConfigEvidence> { return new Promise((resolve, reject) => { try { this.command('config', {}, { resolve, reject }); } catch (e) { reject(e); } }); }
  reqExecutions(requestId: number, filter: ExplicitExecutionFilter) { this.command('executions', filter, { externalId: requestId }); }
  disconnect(): void {
    if (this.closing) return;
    this.closing = true;
    this.rejectPending(accountingError('SOURCE_GAP'));
    if (!this.child) { this.closed = true; this.emit('transportClosed'); return; }
    this.child.stdin.end();
    this.terminateTimer = setTimeout(() => { if (!this.closed) this.child?.kill('SIGTERM'); }, 2000);
    this.killTimer = setTimeout(() => { if (!this.closed) this.child?.kill('SIGKILL'); }, 4000);
  }
}
