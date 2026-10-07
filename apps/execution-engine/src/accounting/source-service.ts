import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BrokerExecutionFill, BrokerCommissionReport, BrokerOrderStatusUpdate } from "../tws-execution-client.js";
import type { BrokerReconciliationSnapshot } from "../reconciliation/broker-adapter.js";
import { paperAccountDate, paperAccountDayStart } from "../paper-daily-loss.js";
import { parseQualification } from "./config.js";
import { AccountingSourceCollector, type AccountingSocket, type CollectorObservation } from "./source-collector.js";
import { AccountingSourceStore, type SourceControl, type SourceObservation } from "./source-store.js";
import { accountingError, accountingHash, accountingNumber, accountingReference, type AccountingBarrier, type AccountingCapture, type AccountingCaptureReference,
  type AccountingLane, type CanonicalExecution, type CanonicalCommission, type SourceInspection, type SourceSettingsV1, type StoredQualification } from "./types.js";

export interface ExecutionSourceIdentity { connected: boolean; accountId: string | null; sessionId: string; generation: number }
export class AccountingSourceService {
  readonly collector: AccountingSourceCollector;
  private control: SourceControl | undefined;
  private qualification: StoredQualification | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0; private failed = false; private gapEpoch = 0; private busy = false;
  private initialized = false; private gap = true;
  private lanes: AccountingBarrier["lanes"] = { accounting: { received: 0, persisted: 0, pending: 0 }, execution: { received: 0, persisted: 0, pending: 0 } };
  private executions = new Map<string, CanonicalExecution>(); private commissions = new Map<string, CanonicalCommission>();
  private requestObservations = new Map<number, string[]>(); private endIds = new Map<number, string>();
  private valueObservations = new Map<string, string>();
  private connectionObservations = new Map<string, string>();
  private latest: AccountingCaptureReference | undefined;
  constructor(readonly store: AccountingSourceStore, readonly settings: SourceSettingsV1, readonly settingsHash: string,
    private readonly executionIdentity: () => ExecutionSourceIdentity, socketFactory?: () => AccountingSocket) {
    this.collector = new AccountingSourceCollector(settings, { observe: event => this.observe(event), gap: (generation, hold) => this.markGap(generation, hold) }, socketFactory);
  }
  async initialize(): Promise<void> {
    this.control = await this.store.begin(this.settings.accountId, this.settingsHash);
    this.qualification = await this.store.qualification();
    for (const row of await this.store.latestValues()) {
      this.valueObservations.set(`${row.kind}:${(row.value as { execId: string }).execId}`, row.id);
      if (row.kind === "execution") { const value = row.value as CanonicalExecution; this.executions.set(value.execId, value); }
      else { const value = row.value as CanonicalCommission; this.commissions.set(value.execId, value); }
    }
    this.initialized = true;
  }
  start() { if (!this.initialized) throw accountingError("SOURCE_UNINITIALIZED"); this.collector.connect(); }
  async close() { this.collector.close(); await this.drain(); }
  private enqueue(job: () => Promise<void>): void {
    if (this.failed) return;
    if (this.pending >= 10_000) {
      this.failed = true; this.gap = true; this.latest = undefined;
      this.queue = this.queue.then(async () => { this.control = await this.store.gap(this.collector.identity().generation, "ACCOUNTING_BUFFER_OVERFLOW"); }).catch(() => undefined);
      return;
    }
    this.pending++;
    this.queue = this.queue.then(job).catch(() => { this.failed = true; this.gap = true; }).finally(() => { this.pending--; });
  }
  private append(lane: AccountingLane, kind: string, value: unknown, raw?: unknown, requestId?: number, persist?: () => Promise<unknown>, observationId: string = randomUUID()): void {
    if (this.failed) return;
    if (JSON.stringify({ value, raw }).length > 65_536) { this.markGap(this.collector.identity().generation, "ACCOUNTING_IDENTITY_INVALID"); return; }
    const sequence = ++this.lanes[lane].received;
    this.lanes[lane].pending++;
    const observation: SourceObservation = { id: observationId, lane, laneSequence: sequence, generation: this.collector.identity().generation,
      kind, value, raw, requestId, key: kind === "execution" || kind === "commission" ? (value as { execId: string }).execId : undefined, receivedAt: new Date().toISOString() };
    if (kind === "handshake" || kind === "managed_accounts") this.connectionObservations.set(kind, observation.id);
    if (requestId !== undefined && requestId > 0) {
      const refs = this.requestObservations.get(requestId) ?? []; refs.push(observation.id); this.requestObservations.set(requestId, refs);
      if (kind === "replay_end") this.endIds.set(requestId, observation.id);
    }
    this.enqueue(async () => {
      if (!this.initialized) throw accountingError("IDENTITY_INVALID");
      const result = await this.store.append(observation);
      await persist?.();
      this.control = result.control;
      if (kind === "execution") { const row = result.value as CanonicalExecution; this.executions.set(row.execId, row); }
      if (kind === "commission") { const row = result.value as CanonicalCommission; this.commissions.set(row.execId, row); }
      if (observation.key) this.valueObservations.set(`${kind}:${observation.key}`, observation.id);
      this.lanes[lane].persisted = sequence; this.lanes[lane].pending--;
    });
  }
  private observe(event: CollectorObservation) { this.append("accounting", event.kind, event.value, "raw" in event ? event.raw : undefined, "requestId" in event ? event.requestId : undefined); }
  private markGap(generation: number, hold?: string) {
    this.gapEpoch++; this.gap = true; this.latest = undefined;
    this.enqueue(async () => { if (!this.initialized) throw accountingError("SOURCE_UNINITIALIZED"); this.control = await this.store.gap(generation, hold); });
  }
  observeIngressFailure(kind: "execution" | "commission", raw: unknown): void {
    this.markGap(this.collector.identity().generation, "ACCOUNTING_IDENTITY_INVALID");
    this.append("execution", "invalid_broker_event", { kind }, raw);
  }
  observeOrderStatus(update: BrokerOrderStatusUpdate): void {
    if (String(update.status).toUpperCase() !== "FILLED") return;
    // orderStatus may precede execDetails while dispatch holds the database locks.
    this.markGap(this.collector.identity().generation);
    this.append("execution", "filled_order_status", update, { identity: this.executionIdentity() });
  }
  observeExecution(fill: BrokerExecutionFill, persist: () => Promise<unknown>): void {
    let legacy: Promise<unknown>;
    try {
    if (fill.accountId !== this.settings.accountId || !fill.execId || !fill.conid || !fill.currency || !fill.exchange || !fill.secType || !fill.executedAt
      || !Number.isFinite(Date.parse(fill.executedAt)) || !accountingNumber(fill.shares) || fill.shares <= 0 || !accountingNumber(fill.price) || fill.price <= 0
      || !Number.isSafeInteger(fill.orderId)) {
      this.markGap(this.collector.identity().generation, "ACCOUNTING_IDENTITY_INVALID"); return;
    }
    const value: CanonicalExecution = { execId: fill.execId, accountId: fill.accountId, brokerOrderId: String(fill.orderId), conId: fill.conid,
      symbol: fill.symbol, secType: fill.secType, currency: fill.currency, exchange: fill.exchange, side: fill.side, shares: fill.shares,
      price: fill.price, executedAt: new Date(fill.executedAt).toISOString(),
      ...(fill.permId === undefined ? {} : { permId: String(fill.permId) }), ...(fill.orderRef === undefined ? {} : { orderRef: fill.orderRef }),
      ...(fill.clientId === undefined ? {} : { clientId: fill.clientId }) };
    this.append("execution", "execution", value, { fill, identity: this.executionIdentity() }, undefined, () => legacy);
    } finally {
      legacy = persist(); void legacy.catch(() => this.markGap(this.collector.identity().generation, "ACCOUNTING_PERSISTENCE_FAILED"));
    }
  }
  observeCommission(report: BrokerCommissionReport, persist: () => Promise<unknown>): void {
    let legacy: Promise<unknown>;
    try {
    if (!report.execId || !report.currency) { this.markGap(this.collector.identity().generation, "ACCOUNTING_IDENTITY_INVALID"); return; }
    this.append("execution", "commission", { execId: report.execId, currency: report.currency,
      commission: accountingNumber(report.commission) ? report.commission : null, realizedPnL: accountingNumber(report.realizedPnL) ? report.realizedPnL : null },
    { report, identity: this.executionIdentity() }, undefined, () => legacy);
    } finally {
      legacy = persist(); void legacy.catch(() => this.markGap(this.collector.identity().generation, "ACCOUNTING_PERSISTENCE_FAILED"));
    }
  }
  private async drain() { do { const q = this.queue; await q; if (q === this.queue) break; } while (true); if (this.failed) throw accountingError("PERSISTENCE_FAILED"); }
  private barrier(): AccountingBarrier {
    const source = this.collector.identity(), execution = this.executionIdentity();
    return { sourceId: this.store.sourceId, sourceProcessSessionId: this.store.sessionId, sourceConnectionGeneration: source.generation,
      executionSessionId: execution.sessionId, executionConnectionGeneration: execution.generation,
      semanticRevision: Number(this.control?.semantic_revision ?? -1), lanes: structuredClone(this.lanes) };
  }
  private assertDrained() {
    if (!this.initialized || this.failed) throw accountingError("PERSISTENCE_FAILED");
    if (this.pending || Object.values(this.lanes).some(lane => lane.pending || lane.received !== lane.persisted)) throw accountingError("PERSISTENCE_PENDING");
    if (this.control?.hold) throw accountingError(this.control.hold);
  }
  private assertIdentity() {
    const e = this.executionIdentity(), s = this.collector.identity();
    if (!e.connected || e.accountId !== this.settings.accountId || !s.ready) throw accountingError("SOURCE_GAP");
  }
  private assertQualified() {
    const q = this.qualification;
    if (!q) throw accountingError("QUALIFICATION_REQUIRED");
    if (Date.parse(q.expiresAt) <= Date.now()) throw accountingError("QUALIFICATION_EXPIRED");
    if (q.input.settingsSha256 !== this.settingsHash || q.protocolVersion !== this.collector.identity().protocolVersion || accountingHash(q.settings) !== accountingHash(this.settings)) throw accountingError("SETTINGS_MISMATCH");
  }
  assertCurrent(reference = this.latest): void {
    this.assertDrained(); this.assertIdentity(); this.assertQualified();
    if (this.gap || !reference || reference.qualificationId !== this.qualification!.id || Date.now() - Date.parse(reference.coveredThrough) >= 10_000
      || Date.parse(reference.coveredThrough) > Date.now() || reference.accountDate !== paperAccountDate(Date.now())) throw accountingError("EVIDENCE_STALE");
    const current = this.barrier(), expected = reference.barrier;
    if (current.sourceId !== expected.sourceId || current.sourceProcessSessionId !== expected.sourceProcessSessionId || current.sourceConnectionGeneration !== expected.sourceConnectionGeneration
      || current.executionSessionId !== expected.executionSessionId || current.executionConnectionGeneration !== expected.executionConnectionGeneration
      || current.semanticRevision !== expected.semanticRevision) throw accountingError("REVISION_CHANGED");
    for (const lane of ["accounting", "execution"] as const) if (current.lanes[lane].persisted < expected.lanes[lane].persisted) throw accountingError("REVISION_CHANGED");
  }
  private costs(ids: string[], start: number, through: number): { executions: CanonicalExecution[]; commissions: CanonicalCommission[] } {
    const executions: CanonicalExecution[] = [], commissions: CanonicalCommission[] = [];
    const included = new Set(ids);
    for (const execution of this.executions.values()) {
      const time = Date.parse(execution.executedAt);
      if (time < start) continue;
      if (!included.has(execution.execId) || time > through) throw accountingError("REVISION_CHANGED");
      if (execution.pendingPriceRevision) throw accountingError("VALUE_UNSET");
      if (!["USD", "PLN"].includes(execution.currency) || !["STK", "FUT", "OPT", "CASH"].includes(execution.secType)) throw accountingError("VALUE_UNSET");
      const fee = this.commissions.get(execution.execId);
      if (!fee) throw accountingError("FEE_PENDING");
      if (fee.currency !== execution.currency || !accountingNumber(fee.commission) || !accountingNumber(fee.realizedPnL)) throw accountingError("VALUE_UNSET");
      executions.push(execution); commissions.push(fee);
    }
    for (const fee of this.commissions.values()) if (!this.executions.has(fee.execId)) throw accountingError("FEE_PENDING");
    return { executions: executions.sort((a, b) => a.execId.localeCompare(b.execId)), commissions: commissions.sort((a, b) => a.execId.localeCompare(b.execId)) };
  }
  private async inspectInternal(timeoutMs: number, signal: AbortSignal): Promise<SourceInspection> {
    this.requestObservations.clear(); this.endIds.clear();
    this.collector.connect(); const epoch = this.gapEpoch, execution = this.executionIdentity();
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    const replay = await this.collector.replay(timeoutMs, signal);
    const through = Date.parse(replay.brokerTime), start = paperAccountDayStart(Date.now());
    if (paperAccountDate(through) !== paperAccountDate(Date.now())) throw accountingError("EVIDENCE_STALE");
    while (true) {
      await this.drain(); this.assertDrained(); this.assertIdentity();
      if (this.gapEpoch !== epoch || accountingHash(execution) !== accountingHash(this.executionIdentity())) throw accountingError("SOURCE_GAP");
      try { this.costs(replay.executionIds, start, through); break; }
      catch (error) {
        if (!(error instanceof Error) || !["ACCOUNTING_FEE_PENDING", "ACCOUNTING_VALUE_UNSET"].includes(error.message) || Date.now() >= deadline || signal.aborted) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
      }
    }
    const inspection: SourceInspection = { id: randomUUID(), sourceId: this.store.sourceId, processSessionId: this.store.sessionId,
      connectionGeneration: replay.generation, protocolVersion: this.collector.identity().protocolVersion, accounts: this.collector.identity().accounts,
      brokerTime: replay.brokerTime, completedAt: new Date().toISOString(), executionIds: replay.executionIds,
      observationIds: [...this.connectionObservations.values(), ...(this.requestObservations.get(replay.requestId) ?? [])], replayId: replay.requestId, replayEndId: this.endIds.get(replay.requestId) ?? "",
      corroboration: replay.executionIds.some(id => {
        const execution = this.executions.get(id), fee = this.commissions.get(id);
        return execution && Date.parse(execution.executedAt) < start && Date.parse(execution.executedAt) >= Date.now() - 5 * 86400_000
          && fee?.currency === execution.currency && accountingNumber(fee.commission) && accountingNumber(fee.realizedPnL);
      }) ? "OBSERVED" : "NOT_OBSERVED" };
    if (!inspection.replayEndId) throw accountingError("REPLAY_INCOMPLETE");
    this.append("accounting", "inspection", inspection, undefined, undefined, undefined, inspection.id);
    await this.drain();
    return inspection;
  }
  async inspect(timeoutMs = 9000, signal = new AbortController().signal): Promise<SourceInspection> {
    if (this.busy) throw accountingError("SOURCE_BUSY"); this.busy = true;
    try { return await this.inspectInternal(timeoutMs, signal); } finally { this.busy = false; }
  }
  async qualify(value: unknown): Promise<{ qualificationId: string; expiresAt: string; settingsHash: string; corroboration: string }> {
    const input = parseQualification(value, Date.now()), prior = await this.store.inspection(input.inspectionId);
    if (input.settingsSha256 !== this.settingsHash || input.executionTimeZone !== this.settings.executionTimeZone || prior.connectionGeneration !== this.collector.identity().generation
      || prior.processSessionId !== this.store.sessionId) throw accountingError("SETTINGS_MISMATCH");
    const fresh = await this.inspect();
    if (fresh.connectionGeneration !== prior.connectionGeneration || Date.now() - Date.parse(fresh.brokerTime) >= 10_000) throw accountingError("INSPECTION_INVALID");
    const record: StoredQualification = { id: randomUUID(), input, settings: this.settings, protocolVersion: fresh.protocolVersion,
      inspectionId: fresh.id, expiresAt: new Date(Date.parse(input.observedAt) + 7 * 86400_000).toISOString() };
    const barrier = this.barrier(), epoch = this.gapEpoch;
    this.gap = true; this.latest = undefined;
    let rejection: Error | undefined;
    this.enqueue(async () => {
      try {
        this.control = await this.store.recordQualification(record, () => {
          this.assertIdentity();
          if (this.gapEpoch !== epoch || accountingHash(this.barrier()) !== accountingHash(barrier)
            || Date.now() - Date.parse(fresh.brokerTime) >= 10_000) throw accountingError("INSPECTION_INVALID");
        });
        this.qualification = record;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("ACCOUNTING_")) throw error;
        rejection = error; this.qualification = null;
      }
    });
    await this.drain();
    if (rejection) throw rejection;
    return { qualificationId: record.id, expiresAt: record.expiresAt, settingsHash: this.settingsHash, corroboration: fresh.corroboration };
  }
  async invalidate(reason: string): Promise<void> {
    if (!reason.trim() || reason.length > 300) throw accountingError("INVALIDATION_INVALID");
    this.gap = true; this.latest = undefined; this.qualification = null; this.gapEpoch++;
    this.enqueue(async () => { this.control = await this.store.gap(this.collector.identity().generation, undefined, true, reason); });
    await this.drain();
  }
  status() {
    let hold: string | null = null;
    try { this.assertCurrent(); } catch (error) { hold = error instanceof Error ? error.message : "ACCOUNTING_SOURCE_GAP"; }
    return { configured: true, sourceId: this.store.sourceId, qualificationId: this.qualification?.id ?? null,
      expiresAt: this.qualification?.expiresAt ?? null, sourceGeneration: this.collector.identity().generation,
      semanticRevision: Number(this.control?.semantic_revision ?? 0), pending: this.pending, hold, captureId: this.latest?.captureId ?? null,
      settingsHash: this.settingsHash, brokerReadOnly: true };
  }
  async join(snapshot: BrokerReconciliationSnapshot, input: { runId: number; positionGeneration: number; recoveryStart: Date; timeoutMs: number; abortSignal: AbortSignal }): Promise<BrokerReconciliationSnapshot> {
    if (this.busy) throw accountingError("SOURCE_BUSY"); this.busy = true;
    try {
      const inspection = await this.inspectInternal(input.timeoutMs, input.abortSignal);
      await this.drain(); this.assertDrained(); this.assertIdentity(); this.assertQualified();
      const barrier = this.barrier(), through = Date.parse(inspection.brokerTime), floor = through - 48 * 3600_000;
      if (!snapshot.exposureComplete || !snapshot.recoveryComplete || snapshot.accountId !== this.settings.accountId
        || snapshot.sessionId !== barrier.executionSessionId || snapshot.connectionGeneration !== barrier.executionConnectionGeneration
        || input.recoveryStart.getTime() < floor) throw accountingError("REPLAY_INCOMPLETE");
      const rows = this.costs(inspection.executionIds, paperAccountDayStart(through), through);
      const fullExecutions = inspection.executionIds.map(id => this.executions.get(id)!);
      if (fullExecutions.some(e => !e || Date.parse(e.executedAt) > through)) throw accountingError("REVISION_CHANGED");
      const capture: AccountingCapture = { captureId: randomUUID(), qualificationId: this.qualification!.id, connectionReceiptId: randomUUID(),
        barrier, reconciliationRunId: input.runId, positionGeneration: input.positionGeneration, accountDate: paperAccountDate(through),
        periodStart: new Date(paperAccountDayStart(through)).toISOString(), certifiedFrom: new Date(floor).toISOString(),
        coveredThrough: inspection.brokerTime, capturedAt: new Date().toISOString(), fingerprint: "", accountId: this.settings.accountId,
        ...rows, observationIds: [...new Set([...inspection.observationIds, inspection.id,
          ...rows.executions.flatMap(e => [this.valueObservations.get(`execution:${e.execId}`), this.valueObservations.get(`commission:${e.execId}`)])])]
          .filter((id): id is string => id !== undefined), replayId: inspection.replayId, replayEndId: inspection.replayEndId };
      capture.fingerprint = accountingHash({ ...capture, fingerprint: undefined });
      const epoch = this.gapEpoch;
      await this.store.publish(capture, () => {
        this.assertDrained(); this.assertIdentity(); this.assertQualified();
        if (this.gapEpoch !== epoch || accountingHash(this.barrier()) !== accountingHash(barrier)) throw accountingError("REVISION_CHANGED");
      });
      this.gap = false; this.latest = capture;
      this.assertCurrent(capture);
      const accounting = accountingReference(capture);
      return { ...snapshot, accounting, capturedAt: new Date(capture.capturedAt), executions: fullExecutions.map(e => ({ ...e, executedAt: new Date(e.executedAt) })),
        sourceCoverage: { ...snapshot.sourceCoverage, executions: { ...snapshot.sourceCoverage.executions, count: fullExecutions.length,
          window: { ...snapshot.sourceCoverage.executions.window, certifiedFrom: capture.certifiedFrom, from: input.recoveryStart.toISOString(), to: capture.coveredThrough } } } };
    } finally { this.busy = false; }
  }
  async readCapture(db: Pick<Pool | PoolClient, "query">, reference: AccountingCaptureReference, lock = false): Promise<AccountingCapture> {
    this.assertCurrent(reference);
    const { capture, control, qualification } = await this.store.readCapture(db, reference.captureId, lock);
    if (accountingHash(accountingReference(capture)) !== accountingHash(reference) || capture.accountId !== this.settings.accountId || control.gap || control.hold
      || Number(control.semantic_revision) !== capture.barrier.semanticRevision || control.qualification_id !== capture.qualificationId
      || !qualification || Date.parse(qualification.expiresAt) <= Date.now()) throw accountingError("REVISION_CHANGED");
    this.assertCurrent(reference); return capture;
  }
}
