import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { ExecutionRepository } from "../repository.js";
import { TwsExecutionClient } from "../tws-execution-client.js";
import { fixture as orderFixture } from "../lifecycle/close-test-fixture.js";
import { runMigrations } from "../migrations.js";
import { paperAccountDayStart, readPaperDailyLoss, assertPaperDailyLossUnchanged } from "../paper-daily-loss.js";
import { IbBrokerReconciliationAdapter } from "../reconciliation/ib-broker-adapter.js";
import { AccountingSourceService } from "./source-service.js";
import { AccountingSourceStore } from "./source-store.js";
import type { AccountingSocket } from "./source-collector.js";
import { accountingHash, accountingReference, type AccountingCapture, type SourceSettingsV1 } from "./types.js";

const url = process.env.TEST_POSTGRES_URL;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function ibTime(time: number) { return new Date(time).toISOString().slice(0, 19).replaceAll("-", "").replace("T", " "); }
class Socket extends EventEmitter implements AccountingSocket {
  serverVersion = 178;
  fills: Array<{ contract: Record<string, unknown>; exec: Record<string, unknown>; fee?: Record<string, unknown> }> = [];
  feesAfterEnd = false; omitEnd = false; afterReplay?: () => void;
  constructor(readonly account: string) { super(); }
  connect() { this.emit("server", 178, "test server time"); this.emit("nextValidId", 1); }
  disconnect() { this.emit("disconnected"); }
  reqManagedAccts() { this.emit("managedAccounts", this.account); }
  reqCurrentTime() { this.emit("currentTime", Math.floor(Date.now() / 1000)); }
  reqExecutions(id: number) {
    for (const fill of this.fills) { this.emit("execDetails", id, fill.contract, fill.exec); if (fill.fee && !this.feesAfterEnd) this.emit("commissionReport", fill.fee); }
    if (!this.omitEnd) this.emit("execDetailsEnd", id);
    if (this.feesAfterEnd) setTimeout(() => { for (const fill of this.fills) if (fill.fee) this.emit("commissionReport", fill.fee); }, 20);
    this.afterReplay?.();
  }
  fill(execId: string = randomUUID(), time = Math.max(paperAccountDayStart(Date.now()), Date.now() - 60_000)) {
    return { contract: { conId: 123, secType: "STK", symbol: "TEST", currency: "USD", exchange: "NASDAQ" },
      exec: { execId, orderId: 1, acctNumber: this.account, shares: 1, price: 100, side: "BOT", exchange: "NASDAQ", time: ibTime(time) },
      fee: { execId, commission: 1, currency: "USD", realizedPNL: -2 } };
  }
}
test("F1 durable production source, qualification, capture and admission", { skip: !url }, async t => {
  const connection = new URL(url!);
  assert.ok(connection.pathname.includes("test") || connection.pathname.includes("validation"), "isolated TEST_POSTGRES_URL required");
  const pool = new Pool({ connectionString: url, max: 6 });
  await runMigrations(pool);
  async function fixture() {
    const account = "F1_" + randomUUID(), process = "session_" + randomUUID();
    const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: "ibkr-tws-seven-day-v1", environment: "paper", accountId: account,
      endpoint: { host: "test.invalid", port: 1 }, sourceClientId: 0, executionTimeZone: "UTC" };
    const socket = new Socket(account), identity = { connected: true, accountId: account, sessionId: process, generation: 1 };
    const store = new AccountingSourceStore(pool, randomUUID(), process), service = new AccountingSourceService(store, settings, "a".repeat(64), () => identity, () => socket);
    await service.initialize(); service.start();
    await pool.query(`INSERT INTO broker_snapshot_syncs(account_id,session_id,observed_at,complete,generation) VALUES($1,$2,clock_timestamp(),true,1)`, [account, process]);
    const qualify = async () => {
      const inspection = await service.inspect(), now = new Date().toISOString();
      const q = await service.qualify({ schemaVersion: 1, sourceKind: "ibkr-tws-seven-day-v1", settingsSha256: "a".repeat(64), inspectionId: inspection.id,
        operator: "test operator", observedAt: now, product: "TWS", productVersion: "test version", productBuild: "test build", tradeLogDays: 7, masterClientId: 0, executionTimeZone: "UTC",
        confirmations: { exactEndpointAndAccount: true, evidenceBelongsToCurrentHostSession: true, noSettingsChangeSinceEvidence: true, pauseAndRequalifyBeforeSettingsChange: true },
        artifacts: ["tws-product-build", "tws-trade-log-seven-days", "tws-master-client-zero", "execution-timezone"].map(kind => ({ kind, relativePath: "settings.txt", sha256: "b".repeat(64), observedAt: now })) });
      return { inspection, q };
    };
    const capture = async (activeService = service) => {
      const positionGeneration = Number((await pool.query("SELECT generation FROM broker_snapshot_syncs WHERE account_id=$1", [account])).rows[0].generation);
      const runId = Number((await pool.query(`INSERT INTO reconciliation_runs(account_id,session_id,status,position_generation) VALUES($1,$2,'RUNNING',$3) RETURNING id`, [account, process, positionGeneration])).rows[0].id);
      const executionSocket = { isConnected: () => identity.connected, getConnectionGeneration: () => identity.generation,
        getManagedAccounts: async () => [account], reqPositionsSnapshot: async () => ({ ok: true, rows: [] }),
        reqAllOpenOrdersSnapshot: async () => ({ ok: true, rows: [] }), reqExecutionsSnapshot: async () => ({ ok: true, rows: [], endObserved: true }) } as unknown as TwsExecutionClient;
      const adapter = new IbBrokerReconciliationAdapter(executionSocket, { load: async () => ({ ok: true, rows: [], endObserved: true }) }, activeService);
      const joined = await adapter.capture({ accountId: account, sessionId: process, sessionStartedAt: new Date(), safetyMarginMs: 1000,
        sourceTimeoutMs: 500, abortSignal: new AbortController().signal, reconciliationRunId: runId, positionGeneration });
      if (!joined.accounting) throw new Error("ACCOUNTING_REPLAY_INCOMPLETE");
      await pool.query(`UPDATE reconciliation_runs SET status='CLEAN',snapshot_complete=true,completed_at=$2,broker_snapshot=$3,source_coverage=$4 WHERE id=$1`, [runId, new Date(), joined, joined.sourceCoverage]);
      const context = { accountId: account, sessionId: process, connectionGeneration: identity.generation, nowMs: Date.now(), lastBrokerFillObservedAt: Date.now(), accounting: activeService };
      return { joined, context, day: await readPaperDailyLoss(pool, context) };
    };
    const drained = async () => { for (let n = 0; n < 200 && service.status().pending; n++) await delay(2); assert.equal(service.status().pending, 0); };
    return { pool, account, process, settings, socket, identity, store, service, qualify, capture, drained };
  }
  try {
    await t.test("empty first account qualifies without historical sample and zero day reaches production reader", async () => {
      const f = await fixture();
      const { inspection } = await f.qualify(); assert.equal(inspection.corroboration, "NOT_OBSERVED");
      const { day, context, joined } = await f.capture(); assert.equal(day.ok, true, JSON.stringify(day));
      if (!day.ok) return;
      assert.deepEqual(day.evidence.debits, { USD: 0, PLN: 0 });
      await assertPaperDailyLossUnchanged(pool, day.evidence, context);
      await assert.rejects(f.service.readCapture(pool, { ...joined.accounting!, fingerprint: "0".repeat(64) }), /REVISION_CHANGED/);
      await assert.rejects(f.service.readCapture(pool, { ...joined.accounting!, positionGeneration: 999 }), /REVISION_CHANGED/);
      for (const table of ["broker_accounting_observations", "broker_accounting_qualifications", "broker_accounting_captures"]) {
        await assert.rejects(pool.query(`DELETE FROM ${table} WHERE source_id=$1`, [f.store.sourceId]), /ACCOUNTING_APPEND_ONLY/);
      }
      await f.service.close();
    });
    await t.test("filled day waits for post-end fees and exact late duplicates on either socket remain positive", async () => {
      const f = await fixture(); f.socket.feesAfterEnd = true; f.socket.fills = [f.socket.fill()];
      await f.qualify(); await delay(25); await f.drained(); f.socket.feesAfterEnd = false;
      const { joined, context } = await f.capture();
      const day = await readPaperDailyLoss(pool, { ...context, nowMs: Date.now() }); assert.equal(day.ok, true, JSON.stringify(day));
      if (day.ok) assert.deepEqual(day.evidence.debits, { USD: 3, PLN: 0 });
      const fill = f.socket.fills[0];
      f.socket.emit("execDetails", -1, fill.contract, fill.exec); f.socket.emit("commissionReport", fill.fee);
      assert.throws(() => f.service.assertCurrent(joined.accounting), /PERSISTENCE_PENDING/); await f.drained(); f.service.assertCurrent(joined.accounting);
      f.service.observeExecution({ execId: String(fill.exec.execId), accountId: f.account, orderId: 1, conid: "123", symbol: "TEST", secType: "STK", currency: "USD", exchange: "NASDAQ",
        side: "BUY", shares: 1, price: 100, executedAt: new Date(Date.parse(String(fill.exec.time).replace(/^(\d{4})(\d{2})(\d{2}) /, "$1-$2-$3T") + "Z")).toISOString() }, async () => {});
      f.service.observeCommission({ execId: String(fill.exec.execId), commission: 1, currency: "USD", realizedPnL: -2 }, async () => {});
      assert.throws(() => f.service.assertCurrent(joined.accounting), /PERSISTENCE_PENDING/); await f.drained(); f.service.assertCurrent(joined.accounting);
      await f.service.close();
    });
    await t.test("missing or unset fees cannot qualify a filled current day", async () => {
      for (const mode of ["missing", "unset"]) {
        const f = await fixture(), fill = f.socket.fill(); f.socket.fills = [{ ...fill, fee: mode === "missing" ? undefined : { ...fill.fee, realizedPNL: Number.MAX_VALUE } }];
        await assert.rejects(f.service.inspect(50), /FEE_PENDING|VALUE_UNSET/); await f.service.close();
      }
    });
    await t.test("execution-only new information and revision changes during final transaction fence deny", async () => {
      const f = await fixture(); await f.qualify(); const { joined } = await f.capture();
      const db = await pool.connect(); await db.query("BEGIN");
      await f.service.readCapture(db, joined.accounting!, true);
      const fill = f.socket.fill();
      f.service.observeExecution({ execId: String(fill.exec.execId), accountId: f.account, orderId: 1, conid: "123", symbol: "TEST", secType: "STK", currency: "USD", exchange: "NASDAQ",
        side: "BUY", shares: 1, price: 100, executedAt: new Date(Math.max(paperAccountDayStart(Date.now()), Date.now() - 60_000)).toISOString() }, async () => {});
      assert.throws(() => f.service.assertCurrent(joined.accounting), /PERSISTENCE_PENDING/);
      await db.query("COMMIT"); db.release(); await f.drained();
      assert.throws(() => f.service.assertCurrent(joined.accounting), /REVISION_CHANGED/);
      await f.service.close();
    });
    await t.test("new execution during replay, missing end and post-end disconnect cannot publish", async () => {
      for (const mode of ["new", "end", "disconnect"]) {
        const f = await fixture(); await f.qualify();
        if (mode === "end") f.socket.omitEnd = true;
        else f.socket.afterReplay = () => {
          if (mode === "disconnect") f.socket.disconnect();
          else { const fill = f.socket.fill(); f.socket.emit("execDetails", -1, fill.contract, fill.exec); }
        };
        await assert.rejects(f.capture(), /REVISION_CHANGED|REPLAY_INCOMPLETE|SOURCE_GAP/);
        assert.equal((await pool.query(`SELECT count(*) FROM broker_accounting_captures WHERE source_id=$1`, [f.store.sourceId])).rows[0].count, "0");
        await f.service.close();
      }
    });
    await t.test("unchanged qualification survives process restart but old capture does not", async () => {
      const f = await fixture(); await f.qualify(); const original = await f.capture(), qualification = f.service.status().qualificationId;
      await f.service.close();
      const replacement = new AccountingSourceService(new AccountingSourceStore(pool, f.store.sourceId, randomUUID()), f.settings, "a".repeat(64), () => f.identity, () => new Socket(f.account));
      await replacement.initialize(); replacement.start();
      assert.throws(() => replacement.assertCurrent(original.joined.accounting));
      const next = await f.capture(replacement); assert.equal(next.day.ok, true, JSON.stringify(next.day));
      assert.equal(replacement.status().qualificationId, qualification);
      assert.notEqual(next.joined.accounting!.barrier.sourceProcessSessionId, original.joined.accounting!.barrier.sourceProcessSessionId);
      const now = Date.now;
      try { Date.now = () => now() + 8 * 86400_000; assert.throws(() => replacement.assertCurrent(next.joined.accounting), /QUALIFICATION_EXPIRED/); }
      finally { Date.now = now; }
      await replacement.close();
    });
    await t.test("FILLED before execDetails denies actual final dispatch while its database locks delay invalidation, then full replay repairs", async () => {
      const f = await fixture(); await f.qualify(); const initial = await f.capture();
      const order = { ...orderFixture().order, executionAccountId: f.account };
      order.id = Number((await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,strategy,client_order_hash)
        VALUES('TEST','test','123','BUY','LMT',1,100,99,102,'test',.8,'PASS','SUBMITTED','test_strategy',$1) RETURNING id`, [computeClientOrderHash(order)])).rows[0].id);
      let reference = initial.joined.accounting!, deliverFilled = true, sends = 0, invalidated = false;
      let invalidation: Promise<unknown> | undefined;
      const socket = new EventEmitter();
      const repo = new ExecutionRepository(pool, undefined, undefined, async () => ({ ok: true, generation: 1, endsAtMs: Date.now() + 60_000 }), undefined, undefined,
        async () => ({ validUntilMs: Date.now() + 60_000, assertCurrent: () => {} }), {
          permit: async db => { await f.service.readCapture(db, reference, true); return { validUntilMs: Date.now() + 9000, assertCurrent: () => f.service.assertCurrent(reference) }; },
          pin: async () => {}, deadline: async () => {
            if (deliverFilled) {
              socket.emit("orderStatus", 100, "Filled", 1, 0);
              await delay(20); assert.equal(invalidated, false, "dispatch still holds snap lock");
              assert.throws(() => f.service.assertCurrent(reference), /PERSISTENCE_PENDING|EVIDENCE_STALE/);
            }
            return Date.now() + 60_000;
          },
        });
      new TwsExecutionClient({ host: "unused", port: 0, clientId: 1, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 }, () => {}, update => {
        f.service.observeOrderStatus(update);
        invalidation = repo.invalidatePositionSnapshot({ accountId: f.account, sessionId: f.process, observedAt: new Date() }).then(() => { invalidated = true; });
      }, undefined, undefined, { ib: socket });
      await assert.rejects(repo.withEntryDispatchPermit(order, f.account, () => { sends++; }), /PERSISTENCE_PENDING|EVIDENCE_STALE/);
      assert.equal(sends, 0); await invalidation; await f.drained(); assert.equal(invalidated, true);
      assert.throws(() => f.service.assertCurrent(reference), /EVIDENCE_STALE|REVISION_CHANGED/);
      f.socket.fills = [f.socket.fill()];
      await pool.query("UPDATE broker_snapshot_syncs SET complete=true,observed_at=clock_timestamp() WHERE account_id=$1", [f.account]);
      const repaired = await f.capture(); assert.equal(repaired.day.ok, true, JSON.stringify(repaired.day)); reference = repaired.joined.accounting!;
      deliverFilled = false; await repo.withEntryDispatchPermit(order, f.account, () => { sends++; }); assert.equal(sends, 1);
      await f.service.close();
    });
    await t.test("rehashed persisted captures cannot alter costs, membership, bounds or receipt binding", async () => {
      const f = await fixture(); f.socket.fills = [f.socket.fill()]; await f.qualify(); const initial = await f.capture();
      const original = await f.service.readCapture(pool, initial.joined.accounting!);
      const mutations: Array<(c: AccountingCapture) => void> = [
        c => { c.commissions[0].commission = 0; c.commissions[0].realizedPnL = 0; },
        c => { c.executions = []; c.commissions = []; }, c => { c.observationIds = []; },
        c => { c.certifiedFrom = new Date(Date.parse(c.certifiedFrom) - 86400_000).toISOString(); },
        c => { c.barrier.executionSessionId = "forged-session"; },
      ];
      for (const mutate of mutations) {
        const forged = structuredClone(original); forged.captureId = randomUUID(); forged.connectionReceiptId = randomUUID(); mutate(forged);
        forged.fingerprint = accountingHash({ ...forged, fingerprint: undefined });
        const receipt = { reference: accountingReference(forged), accountId: forged.accountId, replayId: forged.replayId, replayEndId: forged.replayEndId, observationIds: forged.observationIds };
        await pool.query(`INSERT INTO broker_accounting_observations(id,source_id,process_session_id,connection_generation,lane,lane_sequence,kind,received_at,payload,payload_hash)
          VALUES($1,$2,$3,$4,'accounting',0,'connection_receipt',clock_timestamp(),$5,$6)`, [forged.connectionReceiptId, f.store.sourceId, f.process,
          forged.barrier.sourceConnectionGeneration, { value: receipt }, accountingHash(receipt)]);
        await pool.query(`INSERT INTO broker_accounting_captures(id,source_id,qualification_id,receipt_id,reconciliation_run_id,position_generation,semantic_revision,record,fingerprint)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [forged.captureId, f.store.sourceId, forged.qualificationId, forged.connectionReceiptId,
          forged.reconciliationRunId, forged.positionGeneration, forged.barrier.semanticRevision, forged, forged.fingerprint]);
        await assert.rejects(f.service.readCapture(pool, accountingReference(forged)), /CAPTURE_INVALID|REVISION_CHANGED/);
      }
      const reusedReceipt = { ...structuredClone(original), captureId: randomUUID() };
      reusedReceipt.fingerprint = accountingHash({ ...reusedReceipt, fingerprint: undefined });
      await pool.query(`INSERT INTO broker_accounting_captures(id,source_id,qualification_id,receipt_id,reconciliation_run_id,position_generation,semantic_revision,record,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [reusedReceipt.captureId, f.store.sourceId, reusedReceipt.qualificationId, reusedReceipt.connectionReceiptId,
        reusedReceipt.reconciliationRunId, reusedReceipt.positionGeneration, reusedReceipt.barrier.semanticRevision, reusedReceipt, reusedReceipt.fingerprint]);
      await assert.rejects(f.service.readCapture(pool, accountingReference(reusedReceipt)), /CAPTURE_INVALID/);
      await f.service.close();
    });
    await t.test("qualification rechecks freshness and socket identity after waiting for the source lock", async () => {
      for (const mode of ["inspection-age", "artifact-age", "disconnect"]) {
        const f = await fixture(), holder = await pool.connect(), original = f.store.recordQualification.bind(f.store);
        let entered!: () => void; const atLock = new Promise<void>(resolve => { entered = resolve; });
        f.store.recordQualification = async (record, guard) => {
          await holder.query("BEGIN"); await holder.query("SELECT 1 FROM broker_accounting_sources WHERE source_id=$1 FOR UPDATE", [f.store.sourceId]);
          entered(); return original(record, guard);
        };
        const qualifying = f.qualify(); const rejected = assert.rejects(qualifying, /INSPECTION_INVALID|QUALIFICATION_INVALID|SOURCE_GAP/);
        await atLock; const now = Date.now;
        try {
          if (mode === "disconnect") f.socket.disconnect();
          else Date.now = () => now() + (mode === "inspection-age" ? 11000 : 31 * 60_000);
          await holder.query("COMMIT"); await rejected;
        } finally { Date.now = now; await holder.query("ROLLBACK"); holder.release(); }
        assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_qualifications WHERE source_id=$1", [f.store.sourceId])).rows[0].count, "0");
        assert.equal(f.service.status().qualificationId, null); await f.service.close();
      }
    });
    await t.test("malformed legacy execution and commission callbacks invalidate admission before persistence", async () => {
      for (const mode of ["id", "side", "shares", "price", "null-execution", "commission-id", "null-commission"]) {
        const f = await fixture(); await f.qualify(); const initial = await f.capture(), socket = new EventEmitter();
        new TwsExecutionClient({ host: "unused", port: 0, clientId: 1, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 }, () => {}, undefined,
          fill => f.service.observeExecution(fill, async () => {}), fee => f.service.observeCommission(fee, async () => {}),
          { ib: socket, onAccountingIngressFailure: (kind, raw) => f.service.observeIngressFailure(kind, raw) });
        const fill = f.socket.fill();
        if (mode === "commission-id") socket.emit("commissionReport", { commission: 1, currency: "USD" });
        else if (mode === "null-commission") socket.emit("commissionReport", null);
        else socket.emit("execDetails", -1, fill.contract, mode === "null-execution" ? null : { ...fill.exec,
          ...(mode === "id" ? { execId: "" } : {}), ...(mode === "side" ? { side: "invalid" } : {}),
          ...(mode === "shares" ? { shares: NaN } : {}), ...(mode === "price" ? { price: Infinity } : {}) });
        assert.throws(() => f.service.assertCurrent(initial.joined.accounting), /PERSISTENCE_PENDING|EVIDENCE_STALE/);
        await f.drained(); assert.throws(() => f.service.assertCurrent(initial.joined.accounting), /IDENTITY_INVALID/); await f.service.close();
      }
    });
    await t.test("corrections hold durably, including after restart", async () => {
      const f = await fixture(); f.socket.fills = [f.socket.fill("family.01")]; await f.qualify(); const { joined } = await f.capture();
      f.socket.emit("execDetails", -1, f.socket.fills[0].contract, { ...f.socket.fills[0].exec, execId: "family.02", price: 99 }); await f.drained();
      assert.throws(() => f.service.assertCurrent(joined.accounting), /CORRECTION_UNRESOLVED/);
      await f.service.close();
      const replacement = new AccountingSourceService(new AccountingSourceStore(pool, f.store.sourceId, randomUUID()), f.settings, "a".repeat(64), () => f.identity, () => new Socket(f.account));
      await replacement.initialize(); replacement.start(); await assert.rejects(replacement.inspect(100), /CORRECTION_UNRESOLVED/); await replacement.close();
    });
    await t.test("reconnect reuses unchanged unexpired settings only after new full replay; revocation is immediate", async () => {
      const f = await fixture(); await f.qualify(); const first = await f.capture(); const q = f.service.status().qualificationId;
      f.socket.disconnect(); assert.throws(() => f.service.assertCurrent(first.joined.accounting));
      const next = await f.capture(); assert.equal(next.day.ok, true, JSON.stringify(next.day)); assert.equal(f.service.status().qualificationId, q);
      assert.notEqual(next.joined.accounting!.connectionReceiptId, first.joined.accounting!.connectionReceiptId);
      const invalidating = f.service.invalidate("operator settings changed"); assert.throws(() => f.service.assertCurrent(next.joined.accounting)); await invalidating;
      assert.equal(f.service.status().qualificationId, null); await f.service.close();
    });
  } finally { await pool.end(); }
});
