import { Socket } from 'node:net';
import { IBApi } from '@stoqey/ib';
import { safeDiagnosticText, type DiagnosticPrivacy } from '@ikbr/shared/diagnostics';

export interface OwnerRecoverySocket {
  on(event: string, callback: (...args: unknown[]) => void): unknown;
  connect(): void;
  disconnect(): void;
  reqManagedAccts(): void;
}
export interface OwnerRecoveryTransportResult {
  accountId: string;
  clientId: 0;
  protocolVersion: number;
  nextValidId: number;
  connectedAt: string;
  readyAt: string;
  closedAt: string;
  transportClosed: true;
}
export interface OwnerRecoveryTransportDependencies {
  socket: () => OwnerRecoverySocket;
  now: () => number;
  monotonicNow: () => number;
  schedule: (callback: () => void, milliseconds: number) => unknown;
  cancel: (timer: unknown) => void;
}

export function createOwnerRecoverySocket(endpoint: { host: string; port: number }): OwnerRecoverySocket {
  const api = new IBApi({ ...endpoint, clientId: 0 });
  let transport: Socket | undefined;
  let connected = false;
  const closeListeners = new Set<() => void>();
  return {
    on(event, callback) {
      if (event === 'transportClosed') { closeListeners.add(callback); return; }
      // Only the read-only handshake surface is exposed to the recovery state machine.
      (api.on as (name: string, listener: (...args: unknown[]) => void) => unknown)(event, callback);
    },
    connect() {
      if (connected) throw new Error('ACCOUNTING_OWNER_RECOVERY_HANDSHAKE_UNKNOWN');
      connected = true;
      try { api.connect(); }
      finally {
        const candidate = (api as unknown as { controller?: { socket?: { client?: unknown } } }).controller?.socket?.client;
        if (candidate instanceof Socket) {
          transport = candidate;
          let notified = false;
          const notify = () => { if (!notified) { notified = true; for (const listener of closeListeners) listener(); } };
          transport.once('close', notify);
          if (transport.closed) notify();
        }
      }
      if (!transport) { api.disconnect(); throw new Error('ACCOUNTING_OWNER_RECOVERY_CLOSURE_UNKNOWN'); }
    },
    disconnect() { try { api.disconnect(); } finally { transport?.destroy(); } },
    reqManagedAccts() { api.reqManagedAccts(); },
  };
}

function failure(code: string, cause: unknown, privacy: DiagnosticPrivacy): Error {
  const source = cause && typeof cause === 'object' ? cause as { name?: unknown; code?: unknown; message?: unknown } : undefined;
  const safe = (value: unknown) => typeof value === 'string' ? safeDiagnosticText(value, privacy)
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  return new Error(`ACCOUNTING_OWNER_RECOVERY_${code}`, source ? {
    cause: { name: safe(source.name), code: safe(source.code), message: safe(source.message) },
  } : undefined);
}

/** One connection, one bounded handshake, and positively observed native close. */
export function runOwnerRecoveryHandshake(input: {
  endpoint: { host: string; port: number }; accountId: string; signal?: AbortSignal; privacy?: DiagnosticPrivacy;
}, injected?: OwnerRecoveryTransportDependencies): Promise<OwnerRecoveryTransportResult> {
  const deps = injected ?? { socket: () => createOwnerRecoverySocket(input.endpoint), now: Date.now,
    monotonicNow: () => performance.now(), schedule: (fn: () => void, ms: number) => setTimeout(fn, ms),
    cancel: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
  const privacy = { ...input.privacy, accountIds: [...(input.privacy?.accountIds ?? []), input.accountId] };
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) { reject(failure('HANDSHAKE_UNKNOWN', undefined, privacy)); return; }
    const started = deps.monotonicNow(), wallStarted = deps.now();
    let socket: OwnerRecoverySocket;
    try { socket = deps.socket(); } catch (error) { reject(failure('HANDSHAKE_UNKNOWN', error, privacy)); return; }
    let done = false, closing = false, closed = false, requested = false, protocol = 0;
    let nextId: number | undefined, accountConfirmed = false, error: Error | undefined;
    let connectedAt: string | undefined, readyAt: string | undefined;
    const clockValid = () => {
      const elapsed = deps.monotonicNow() - started, wall = deps.now() - wallStarted;
      return elapsed >= 0 && elapsed < 10000 && wall >= 0 && Math.abs(elapsed - wall) <= 1000;
    };
    const finish = () => {
      if (done || !closed) return;
      done = true; deps.cancel(handshakeTimer); deps.cancel(totalTimer); input.signal?.removeEventListener('abort', abort);
      if (!clockValid()) error ??= failure('CLOCK_UNCERTAIN', undefined, privacy);
      if (error || !connectedAt || !readyAt || !accountConfirmed || !protocol || nextId === undefined) {
        reject(error ?? failure('HANDSHAKE_UNKNOWN', undefined, privacy)); return;
      }
      resolve({ accountId: input.accountId, clientId: 0, protocolVersion: protocol, nextValidId: nextId,
        connectedAt, readyAt, closedAt: new Date(deps.now()).toISOString(), transportClosed: true });
    };
    const close = (reason?: Error) => {
      if (done) return;
      error ??= reason;
      if (!closing) {
        closing = true; deps.cancel(handshakeTimer);
        try { socket.disconnect(); } catch (cause) { error ??= failure('CLOSURE_UNKNOWN', cause, privacy); }
      }
      finish();
    };
    const abort = () => close(failure('HANDSHAKE_UNKNOWN', undefined, privacy));
    const progress = () => {
      if (done || closing) return;
      if (!clockValid()) { close(failure('CLOCK_UNCERTAIN', undefined, privacy)); return; }
      if (protocol && nextId !== undefined && accountConfirmed) { readyAt = new Date(deps.now()).toISOString(); close(); }
    };
    const listen = (name: string, callback: (...args: unknown[]) => void) => socket.on(name, (...args) => {
      if (done || closing) return;
      try { callback(...args); } catch (cause) { close(failure('HANDSHAKE_UNKNOWN', cause, privacy)); }
    });
    socket.on('transportClosed', () => {
      if (done) return;
      closed = true;
      if (!closing) error ??= failure('HANDSHAKE_UNKNOWN', undefined, privacy);
      finish();
    });
    listen('server', version => {
      if (!Number.isSafeInteger(version) || Number(version) <= 0 || (protocol && protocol !== version)) {
        close(failure('HANDSHAKE_UNKNOWN', undefined, privacy)); return;
      }
      connectedAt ??= new Date(deps.now()).toISOString(); protocol = Number(version); progress();
    });
    listen('nextValidId', value => {
      if (!Number.isSafeInteger(value) || Number(value) < 0 || (nextId !== undefined && nextId !== value)) {
        close(failure('HANDSHAKE_UNKNOWN', undefined, privacy)); return;
      }
      nextId = Number(value);
      if (!requested) { requested = true; socket.reqManagedAccts(); }
      progress();
    });
    listen('managedAccounts', value => {
      if (typeof value !== 'string' || value.length > 400 || value.split(',').map(v => v.trim()).filter(Boolean).join(',') !== input.accountId) {
        close(failure('ACCOUNT_MISMATCH', undefined, privacy)); return;
      }
      accountConfirmed = true; progress();
    });
    listen('disconnected', () => close(failure('HANDSHAKE_UNKNOWN', undefined, privacy)));
    listen('error', (cause, code) => {
      if ([2104, 2106, 2107, 2108, 2158].includes(Number(code))) return;
      const original = cause instanceof Error ? { name: cause.name, message: cause.message,
        code: code ?? (cause as Error & { code?: unknown }).code } : { code };
      close(failure('HANDSHAKE_UNKNOWN', original, privacy));
    });
    const handshakeTimer = deps.schedule(() => close(failure('HANDSHAKE_UNKNOWN', undefined, privacy)), 8000);
    const totalTimer = deps.schedule(() => {
      if (done) return;
      close(failure('CLOSURE_UNKNOWN', undefined, privacy));
      if (!done) {
        done = true; deps.cancel(handshakeTimer); input.signal?.removeEventListener('abort', abort);
        reject(failure('CLOSURE_UNKNOWN', error, privacy));
      }
    }, 10000);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) { close(failure('HANDSHAKE_UNKNOWN', undefined, privacy)); return; }
    try { socket.connect(); } catch (cause) { close(failure('HANDSHAKE_UNKNOWN', cause, privacy)); }
  });
}
