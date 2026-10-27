import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
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
  const { on, connect, disconnect, reqManagedAccts } = createOwnerRecoveryProbeSocket(endpoint);
  return { on, connect, disconnect, reqManagedAccts };
}

export interface OwnerRecoveryProbeSocket extends OwnerRecoverySocket {
  reqPositions(): void;
  reqAllOpenOrders(): void;
}

export function createOwnerRecoveryProbeSocket(endpoint: { host: string; port: number }): OwnerRecoveryProbeSocket {
  const api = new IBApi({ ...endpoint, clientId: 0 });
  let transport: Socket | undefined;
  let connected = false;
  const closeListeners = new Set<() => void>();
  return {
    on(event, callback) {
      if (event === 'transportClosed') { closeListeners.add(callback); return; }
      // Only read-only requests and lifecycle methods are exposed to recovery.
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
    reqPositions() { api.reqPositions(); },
    reqAllOpenOrders() { api.reqAllOpenOrders(); },
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

export interface OwnerRecoveryAccountProbeResult {
  accountId: string;
  clientId: 0;
  protocolVersion: number | null;
  sdkVersion: '@stoqey/ib@1.6.10';
  connectedAt: string | null;
  readyAt: string | null;
  positionsRequestedAt: string | null;
  openOrdersRequestedAt: string | null;
  positionsEndAt: string | null;
  openOrdersEndAt: string | null;
  completedAt: string | null;
  closedAt: string;
  transportClosed: true;
  positionRows: number;
  openOrderRows: number;
  eventCount: number;
  rowsDigest: string;
  outcome: 'FLAT' | 'NONFLAT' | 'INCOMPLETE';
  error: null | { code: string; cause?: { name: string | null; code: string | null; message: string | null } };
}
export interface OwnerRecoveryProbeDependencies extends Omit<OwnerRecoveryTransportDependencies, 'socket'> {
  socket: () => OwnerRecoveryProbeSocket;
}

/** A single non-binding client-0 snapshot; failure is durable only after native close. */
export function runOwnerRecoveryAccountProbe(input: {
  endpoint: { host: string; port: number }; accountId: string; signal?: AbortSignal; privacy?: DiagnosticPrivacy;
}, injected?: OwnerRecoveryProbeDependencies): Promise<OwnerRecoveryAccountProbeResult> {
  const deps = injected ?? { socket: () => createOwnerRecoveryProbeSocket(input.endpoint), now: Date.now,
    monotonicNow: () => performance.now(), schedule: (fn: () => void, ms: number) => setTimeout(fn, ms),
    cancel: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
  const privacy = { ...input.privacy, accountIds: [...(input.privacy?.accountIds ?? []), input.accountId] };
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) { reject(failure('PROBE_ABORTED', undefined, privacy)); return; }
    const started = deps.monotonicNow(), wallStarted = deps.now();
    let socket: OwnerRecoveryProbeSocket;
    try { socket = deps.socket(); } catch (cause) { reject(failure('CLOSURE_UNKNOWN', cause, privacy)); return; }
    let done = false, closing = false, closed = false, nonflat = false, requestedAccounts = false, confirmed = false;
    let protocolVersion: number | null = null, nextId: number | null = null;
    let connectedAt: string | null = null, readyAt: string | null = null;
    let positionsRequestedAt: string | null = null, openOrdersRequestedAt: string | null = null;
    let positionsEndAt: string | null = null, openOrdersEndAt: string | null = null, completedAt: string | null = null;
    let positionRows = 0, openOrderRows = 0, eventCount = 0;
    let error: OwnerRecoveryAccountProbeResult['error'] = null;
    let closeTimer: unknown, closeStarted: number | null = null;
    const digest = createHash('sha256'), positions = new Map<number, string>();
    const stamp = () => new Date(deps.now()).toISOString();
    const recordError = (code: string, cause?: unknown) => {
      const err = failure(code, cause, privacy);
      const original = err.cause as NonNullable<OwnerRecoveryAccountProbeResult['error']>['cause'];
      const bounded = (value: string | null | undefined, limit: number): string | null => value?.trim().slice(0, limit).trim() || null;
      error ??= { code: err.message, ...(original ? { cause: { name: bounded(original.name, 200),
        code: bounded(original.code, 200), message: bounded(original.message, 1000) } } : {}) };
    };
    const clockValid = () => {
      const elapsed = deps.monotonicNow() - started, wall = deps.now() - wallStarted;
      return Number.isFinite(elapsed) && Number.isFinite(wall) && elapsed >= 0 && elapsed < 20000 && wall >= 0 && Math.abs(elapsed - wall) <= 1000;
    };
    const cleanup = () => {
      done = true;
      for (const timer of [dataTimer, totalTimer, closeTimer]) if (timer !== undefined) deps.cancel(timer);
      input.signal?.removeEventListener('abort', abort);
    };
    const finish = () => {
      if (done || !closed) return;
      if (!clockValid()) recordError('CLOCK_UNCERTAIN');
      if (closeStarted !== null && deps.monotonicNow() - closeStarted >= 2000) recordError('PROBE_CLOSE_TIMEOUT');
      if (!completedAt || !readyAt || !confirmed || !positionsEndAt || !openOrdersEndAt) recordError('PROBE_INCOMPLETE');
      cleanup();
      resolve({ accountId: input.accountId, clientId: 0, protocolVersion, sdkVersion: '@stoqey/ib@1.6.10',
        connectedAt, readyAt, positionsRequestedAt, openOrdersRequestedAt, positionsEndAt, openOrdersEndAt,
        completedAt, closedAt: stamp(), transportClosed: true, positionRows, openOrderRows, eventCount,
        rowsDigest: digest.digest('hex'), outcome: nonflat ? 'NONFLAT' : error ? 'INCOMPLETE' : 'FLAT', error });
    };
    const unknownClose = () => {
      if (done) return;
      cleanup(); reject(failure('CLOSURE_UNKNOWN', error?.cause, privacy));
    };
    const close = (code?: string, cause?: unknown) => {
      if (done) return;
      if (code) recordError(code, cause);
      if (!closing) {
        closing = true; closeStarted = deps.monotonicNow();
        if (dataTimer !== undefined) deps.cancel(dataTimer);
        closeTimer = deps.schedule(unknownClose, Math.max(0, Math.min(2000, 20000 - (deps.monotonicNow() - started))));
        try { socket.disconnect(); } catch (cause) { recordError('PROBE_DISCONNECT_FAILED', cause); }
      }
      finish();
    };
    const abort = () => close('PROBE_ABORTED');
    const counted = () => {
      eventCount = Math.min(4096, eventCount + 1);
      if (eventCount >= 4096) { close('PROBE_OUTPUT_LIMIT'); return false; }
      if (!clockValid()) { close('CLOCK_UNCERTAIN'); return false; }
      if (!closing && deps.monotonicNow() - started >= 18000) { close('PROBE_TIMEOUT'); return false; }
      return true;
    };
    const listen = (name: string, callback: (...args: unknown[]) => void) => socket.on(name, (...args) => {
      if (done) return;
      if (!counted()) return;
      try { callback(...args); } catch (cause) { close('PROBE_INCOMPLETE', cause); }
    });
    const complete = () => {
      if (!closing && positionsEndAt && openOrdersEndAt) { completedAt = stamp(); close(); }
    };
    const progress = () => {
      if (closing || readyAt || protocolVersion === null || nextId === null || !confirmed) return;
      readyAt = stamp();
      positionsRequestedAt = stamp(); socket.reqPositions();
      if (closing) return;
      openOrdersRequestedAt = stamp(); socket.reqAllOpenOrders();
    };
    socket.on('transportClosed', () => {
      if (done) return;
      // Set the closure observation before counting: the cap must not erase native closure.
      closed = true;
      if (!closing) recordError('PROBE_DISCONNECTED');
      counted(); finish();
    });
    listen('server', version => {
      // Pinned SDK 1.6.10: ACCT_SUMMARY=67, maximum CME_TAGGING_FIELDS_IN_OPEN_ORDER=193.
      if (!Number.isSafeInteger(version) || Number(version) < 67 || Number(version) > 193 || protocolVersion !== null) {
        close('PROBE_PROTOCOL_UNSUPPORTED'); return;
      }
      protocolVersion = Number(version); connectedAt = stamp(); progress();
    });
    listen('nextValidId', value => {
      if (!Number.isSafeInteger(value) || Number(value) < 0 || nextId !== null) { close('PROBE_INCOMPLETE'); return; }
      nextId = Number(value);
      if (!closing && !requestedAccounts) { requestedAccounts = true; socket.reqManagedAccts(); }
      progress();
    });
    listen('managedAccounts', value => {
      if (typeof value !== 'string' || value.length > 400 || value.trim() !== input.accountId) { close('ACCOUNT_MISMATCH'); return; }
      confirmed = true; progress();
    });
    const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const boundedText = (value: unknown, required = false) => typeof value === 'string' && value.length <= 128 &&
      (!required || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(value);
    const contractIdentity = (value: unknown): Record<string, string | number | null> | null => {
      if (!object(value) || !Number.isSafeInteger(value.conId) || Number(value.conId) <= 0 ||
        !['symbol', 'secType', 'currency'].every(key => boundedText(value[key], true))) return null;
      const identity: Record<string, string | number | null> = { conId: Number(value.conId), symbol: String(value.symbol),
        secType: String(value.secType), currency: String(value.currency) };
      for (const key of ['exchange', 'localSymbol', 'tradingClass', 'lastTradeDateOrContractMonth', 'right']) {
        if (value[key] !== undefined && !boundedText(value[key])) return null;
        identity[key] = value[key] === undefined ? null : String(value[key]);
      }
      for (const key of ['strike', 'multiplier']) {
        if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return null;
        identity[key] = value[key] === undefined ? null : Number(value[key]);
      }
      return identity;
    };
    const rowDigest = (row: unknown) => digest.update(JSON.stringify(row)).update('\n');
    listen('position', (account, contract, quantity, averageCost) => {
      positionRows++;
      const identity = contractIdentity(contract);
      if (account !== input.accountId || !identity || typeof quantity !== 'number' || !Number.isFinite(quantity) ||
          typeof averageCost !== 'number' || !Number.isFinite(averageCost)) {
        rowDigest(['position', 'invalid']); close('PROBE_ROW_INVALID'); return;
      }
      const normalized = JSON.stringify([input.accountId, identity, quantity, averageCost]);
      rowDigest(['position', normalized]);
      if (quantity !== 0) { nonflat = true; close('PROBE_NONFLAT'); return; }
      if (!positionsRequestedAt || positionsEndAt || closing) { close('PROBE_UNEXPECTED_EVENT'); return; }
      const previous = positions.get(Number(identity.conId));
      if (previous !== undefined && previous !== normalized) { close('PROBE_ROW_CONFLICT'); return; }
      positions.set(Number(identity.conId), normalized);
    });
    listen('openOrder', (orderId, contract, order, state) => {
      openOrderRows++; nonflat = true;
      const identity = contractIdentity(contract);
      if (!Number.isSafeInteger(orderId) || Number(orderId) < 0 || !identity || !object(order) || order.account !== input.accountId ||
          typeof order.totalQuantity !== 'number' || !Number.isFinite(order.totalQuantity) || !object(state) || !boundedText(state.status, true)) {
        rowDigest(['openOrder', 'invalid']); close('PROBE_ROW_INVALID'); return;
      }
      rowDigest(['openOrder', orderId, identity, input.accountId, order.totalQuantity, state.status]);
      close('PROBE_NONFLAT');
    });
    listen('orderStatus', (...args) => {
      nonflat = true;
      // Status-only callbacks have no trustworthy account; their presence already denies flatness.
      rowDigest(['orderStatus', Number.isSafeInteger(args[0]) ? args[0] : null, boundedText(args[1]) ? args[1] : null]);
      close('PROBE_NONFLAT');
    });
    listen('positionEnd', () => {
      if (!positionsRequestedAt || positionsEndAt || closing) { close('PROBE_UNEXPECTED_EVENT'); return; }
      positionsEndAt = stamp(); complete();
    });
    listen('openOrderEnd', () => {
      if (!openOrdersRequestedAt || openOrdersEndAt || closing) { close('PROBE_UNEXPECTED_EVENT'); return; }
      openOrdersEndAt = stamp(); complete();
    });
    listen('disconnected', () => { if (!closing) close('PROBE_DISCONNECTED'); });
    listen('error', (cause, code) => {
      if ([2104, 2106, 2107, 2108, 2158].includes(Number(code))) return;
      const source = object(cause) ? { name: cause.name, code: code ?? cause.code, message: cause.message }
        : { code, message: typeof cause === 'string' ? cause : undefined };
      close('PROBE_BROKER_ERROR', source);
    });
    const dataTimer = deps.schedule(() => close('PROBE_TIMEOUT'), 18000);
    const totalTimer = deps.schedule(() => { close('PROBE_TIMEOUT'); if (!done) unknownClose(); }, 20000);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) { close('PROBE_ABORTED'); return; }
    try { socket.connect(); } catch (cause) { close('PROBE_CONNECT_FAILED', cause); }
  });
}
