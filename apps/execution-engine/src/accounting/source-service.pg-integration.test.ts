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
import { OFFICIAL_SDK_SHA256 } from "./official-sdk-bridge.js";
import type { AccountingSocket } from "./source-collector.js";
import { accountingHash, accountingReference, type AccountingCapture, type SourceSettingsV1 } from "./types.js";

const url = process.env.TEST_POSTGRES_URL;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function ibTime(time: number) { return new Date(time).toISOString().slice(0, 19).replaceAll("-", "").replace("T", " "); }
class Socket extends EventEmitter implements AccountingSocket {
  serverVersion = 178; sdkSha256 = OFFICIAL_SDK_SHA256;
  fills: Array<{ contract: Record<string, unknown>; exec: Record<string, unknown>; fee?: Record<string, unknown> }> = [];
  feesAfterEnd = false; omitEnd = false; afterReplay?: () => void;
  constructor(readonly account: string, readonly automatic = false) { super(); if (automatic) this.serverVersion = 226; }
  async reqConfig() { return { masterClientIdPresent: true as const, masterClientId: 0 as const }; }
  connect() { this.emit("server", this.serverVersion, "test server time"); this.emit("nextValidId", 1); }
  disconnect() { this.emit("disconnected"); this.emit("transportClosed"); }
  reqManagedAccts() { this.emit("managedAccounts", this.account); }
  reqCurrentTime() { if (this.automatic) this.emit("currentTimeInMillis", Date.now()); else this.emit("currentTime", Math.floor(Date.now() / 1000)); }
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
  const connection = new URL(url!), database = `pp7_f1_${randomUUID().replaceAll("-", "")}`;
  connection.pathname = "/postgres";
  const admin = new Pool({ connectionString: connection.href });
  connection.pathname = `/${database}`;
  const pool = new Pool({ connectionString: connection.href, max: 6 });
  let created = false;
  let endpointPort=20000;
  async function fixture(automaticClockRecoveryEnabled=false, automaticSourceRecoveryEnabled=false) {
    const account = "F1_" + randomUUID(), process = automaticSourceRecoveryEnabled ? randomUUID() : "session_" + randomUUID();
    const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: "ibkr-tws-seven-day-v1", environment: "paper", accountId: account,
      endpoint: { host: "127.0.0.1", port: endpointPort++ }, sourceClientId: 0, executionTimeZone: "UTC" };
    let socket = new Socket(account, automaticSourceRecoveryEnabled), initialSocket = true;
    const next = { configure: (_socket: Socket) => {} };
    const identity = { connected: true, accountId: account, sessionId: process, generation: 1 };
    const store = new AccountingSourceStore(pool, randomUUID(), process), service = new AccountingSourceService(store, settings, "a".repeat(64), () => identity, () => {
      if (initialSocket) initialSocket = false;
      else { const replacement = new Socket(account, automaticSourceRecoveryEnabled); replacement.fills = socket.fills; socket = replacement; next.configure(socket); }
      return socket;
    },undefined,{automaticClockRecoveryEnabled,automaticSourceRecoveryEnabled});
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
    return { pool, account, process, settings, get socket() { return socket; }, next, identity, store, service, qualify, capture, drained };
  }
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    await runMigrations(pool);
    await t.test("automatic v2 qualifies without manual artifacts, stores request proof, and rejects forged interval", async () => {
      const f = await fixture(false, true);
      try {
        const { joined, day } = await f.capture(); assert.equal(day.ok, true, JSON.stringify(day));
        const q = await f.store.qualification(); assert.equal(q?.input.schemaVersion, 2); assert.equal(q?.expiresAt, null);
        assert.ok(joined.accounting);
        const { capture } = await f.store.readCapture(pool, joined.accounting!.captureId, false);
        assert.equal(Date.parse(capture.certifiedFrom) % 1000, 0);
        const forged = { ...capture, captureId: randomUUID(), connectionReceiptId: randomUUID(), certifiedFrom: new Date(Date.parse(capture.certifiedFrom)-86400000).toISOString() };
        forged.fingerprint = accountingHash({ ...forged, fingerprint: undefined });
        await assert.rejects(f.store.publish(forged, () => {}), /CAPTURE_INVALID|REVISION_CHANGED/);
        const observations = (await pool.query(`SELECT kind,payload->'value' AS value FROM broker_accounting_observations WHERE source_id=$1`, [f.store.sourceId])).rows;
        assert.equal(observations.filter(r => r.kind === 'configuration').length, 2);
        const start = observations.find(r => r.kind === 'replay_start'); assert.equal(start.value.capability.filter.lastNDays, 7);
        const second = await f.capture(); assert.equal(second.day.ok, true);
        assert.equal((await f.store.qualification())?.id, q?.id);
        assert.equal(await f.service.collector.retire(), true); f.service.start();
        const rejoined = await f.capture(); assert.equal(rejoined.day.ok, true);
        const replacement = await f.store.qualification(); assert.notEqual(replacement?.id, q?.id);
        assert.equal((await pool.query('SELECT count(*) AS n FROM broker_accounting_qualifications WHERE source_id=$1', [f.store.sourceId])).rows[0].n, '2');
        assert.throws(() => f.service.assertCurrent(joined.accounting!), /EVIDENCE_STALE|REVISION_CHANGED/);
      } finally { await f.service.close(); }
    });
    await t.test("automatic v2 persists configured timestamp provenance and waits for actual fees", async () => {
      const f = await fixture(false, true);
      try {
        f.socket.fills = [f.socket.fill()]; f.socket.feesAfterEnd = true;
        const { day } = await f.capture(); assert.equal(day.ok, true, JSON.stringify(day));
        const row = (await pool.query(`SELECT payload->'raw' AS raw FROM broker_accounting_observations WHERE source_id=$1 AND kind='execution' LIMIT 1`, [f.store.sourceId])).rows[0];
        assert.equal(row.raw.timestampMode, 'CONFIGURED_ZONE'); assert.equal(row.raw.settingsHash, 'a'.repeat(64));
      } finally { await f.service.close(); }
    });
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
      await f.service.inspect(); await f.drained();
      const observations = (await pool.query(`SELECT kind FROM broker_accounting_observations WHERE source_id=$1
        AND kind IN ('replay_end','commission') ORDER BY sequence`, [f.store.sourceId])).rows.map(row => row.kind);
      assert.deepEqual(observations, ["replay_end", "commission"]);
      f.socket.feesAfterEnd = false;
      await f.qualify();
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
    for (const fence of [1, 2]) await t.test(`late duplicate commission at qualification fence ${fence} rejects and rolls back`, async () => {
      const f = await fixture(); f.socket.fills = [f.socket.fill()];
      const recordQualification = f.store.recordQualification.bind(f.store);
      let checks = 0;
      f.store.recordQualification = (record, assertCurrent) => recordQualification(record, () => {
        assertCurrent();
        if (++checks === fence) f.socket.emit("commissionReport", f.socket.fills[0].fee);
        assertCurrent();
      });
      try {
        await assert.rejects(f.qualify(), /ACCOUNTING_INSPECTION_INVALID/);
        assert.equal(checks, fence);
        await f.drained();
        assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_qualifications WHERE source_id=$1", [f.store.sourceId])).rows[0].count, "0");
        assert.equal((await f.store.control()).qualification_id, null);
      } finally { await f.service.close(); }
    });
    await t.test("missing or unset fees cannot qualify a filled current day", async () => {
      for (const mode of ["missing", "unset"]) {
        const f = await fixture(), fill = f.socket.fill(); f.socket.fills = [{ ...fill, fee: mode === "missing" ? undefined : { ...fill.fee, realizedPNL: Number.MAX_VALUE } }];
        await assert.rejects(f.service.inspect(50), /FEE_PENDING|VALUE_UNSET/); await f.service.close();
      }
    });
    await t.test("execution-only new information and revision changes during final transaction fence deny", async () => {
      const f = await fixture(); await f.qualify(); const { joined } = await f.capture();
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await f.service.readCapture(db, joined.accounting!, true);
        const fill = f.socket.fill();
        f.service.observeExecution({ execId: String(fill.exec.execId), accountId: f.account, orderId: 1, conid: "123", symbol: "TEST", secType: "STK", currency: "USD", exchange: "NASDAQ",
          side: "BUY", shares: 1, price: 100, executedAt: new Date(Math.max(paperAccountDayStart(Date.now()), Date.now() - 60_000)).toISOString() }, async () => {});
        assert.throws(() => f.service.assertCurrent(joined.accounting), /PERSISTENCE_PENDING/);
        await db.query("COMMIT");
      } finally { try { await db.query("ROLLBACK"); } finally { db.release(); } }
      await f.drained();
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
        const now = Date.now;
        try {
          let entered!: () => void; const atLock = new Promise<void>(resolve => { entered = resolve; });
          f.store.recordQualification = async (record, guard) => {
            await holder.query("BEGIN"); await holder.query("SELECT 1 FROM broker_accounting_sources WHERE source_id=$1 FOR UPDATE", [f.store.sourceId]);
            entered(); return original(record, guard);
          };
          const qualifying = f.qualify(); const rejected = assert.rejects(qualifying, /INSPECTION_INVALID|QUALIFICATION_INVALID|SOURCE_GAP/);
          await Promise.race([atLock, rejected.then(() => { throw new Error("qualification ended before acquiring its lock"); })]);
          if (mode === "disconnect") f.socket.disconnect();
          else Date.now = () => now() + (mode === "inspection-age" ? 11000 : 31 * 60_000);
          await holder.query("COMMIT"); await rejected;
        } finally { Date.now = now; try { await holder.query("ROLLBACK"); } finally { holder.release(); } }
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
    await t.test("pure durable clock hold recovers only on a fresh complete replay and preserves qualification", async () => {
      for (const qualified of [false, true]) {
        const f = await fixture(); if (qualified) { f.socket.fills = [f.socket.fill()]; await f.qualify(); await f.capture(); }
        await f.drained(); const q = f.service.status().qualificationId;
        const old = f.socket; await f.store.gap(f.service.status().sourceGeneration, "ACCOUNTING_CLOCK_INVALID");
        const receipt = await f.service.recoverClock();
        assert.notEqual(old, f.socket); assert.equal(receipt.qualificationId, q); assert.equal(receipt.gap, true);
        const control = await f.store.control(); assert.equal(control.hold, null); assert.equal(control.gap, true); assert.equal(control.qualification_id, q);
        assert.throws(() => f.service.assertCurrent(), /CLOCK_RECOVERY_VERIFYING/);
        assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_recovery'", [f.store.sourceId])).rows[0].count, "1");
        await assert.rejects(f.service.recoverClock(), /HOLD_MISMATCH/);
        if (qualified) assert.equal((await f.capture()).day.ok, true);
        await f.service.close();
      }
    });
    await t.test("clock cannot overwrite stronger holds and old overwritten failures cannot recover", async () => {
      for (const mode of ["stronger", "historical", "invalid", "correction", "family"]) {
        const f = await fixture(); await f.drained();
        if (mode === "invalid") { f.service.observeIngressFailure("execution", null); await f.drained(); }
        else if (mode === "correction" || mode === "family") {
          const fill = f.socket.fill(mode === "family" ? "a.b.01" : "corrected.01", paperAccountDayStart(Date.now())-3600_000);
          f.socket.emit("execDetails", -1, fill.contract, fill.exec);
          f.socket.emit("execDetails", -1, fill.contract, { ...fill.exec, ...(mode === "family" ? { execId: "a.02" } : { price: 99 }) }); await f.drained();
        } else await f.store.gap(f.service.status().sourceGeneration, "ACCOUNTING_IDENTITY_INVALID");
        await f.store.gap(f.service.status().sourceGeneration, "ACCOUNTING_CLOCK_INVALID");
        assert.notEqual((await f.store.control()).hold, "ACCOUNTING_CLOCK_INVALID");
        let active = f.service;
        if (mode !== "stronger") {
          await pool.query("UPDATE broker_accounting_sources SET hold='ACCOUNTING_CLOCK_INVALID' WHERE source_id=$1", [f.store.sourceId]);
          await f.service.close();
          active = new AccountingSourceService(new AccountingSourceStore(pool, f.store.sourceId, randomUUID()), f.settings, "a".repeat(64), () => f.identity, () => new Socket(f.account));
          await active.initialize();
        }
        await assert.rejects(active.recoverClock(), mode === "stronger" ? /IDENTITY_INVALID|HOLD_MISMATCH/ : /HISTORY_CONFLICT/);
        assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_recovery'", [f.store.sourceId])).rows[0].count, "0");
        await active.close();
      }
    });
    await t.test("recovery rejects bad clocks, missing costs and new replay gaps", async () => {
      for (const mode of ["clock", "fee", "end", "gap", "orphan", "future"]) {
        const f = await fixture(); await f.drained(); await f.store.gap(f.service.status().sourceGeneration, "ACCOUNTING_CLOCK_INVALID");
        f.next.configure = socket => {
          if (mode === "clock") socket.reqCurrentTime = () => { socket.emit("currentTime", NaN); socket.emit("currentTime", Math.floor(Date.now()/1000)); };
          if (mode === "fee") socket.fills = [{ ...socket.fill(), fee: undefined }];
          if (mode === "end") socket.omitEnd = true;
          if (mode === "gap") socket.afterReplay = () => socket.disconnect();
          if (mode === "orphan") socket.afterReplay = () => socket.emit("commissionReport", { execId: "orphan", currency: "USD", commission: 1, realizedPNL: 0 });
          if (mode === "future") socket.fills = [socket.fill("future", Date.now()+60_000)];
        };
        await assert.rejects(f.service.recoverClock(100));
        assert.equal((await f.store.control()).hold, "ACCOUNTING_CLOCK_INVALID");
        assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_recovery'", [f.store.sourceId])).rows[0].count, "0");
        await f.service.close();
      }
    });
    await t.test("recovery fences callbacks and staleness while awaiting the source row lock", async () => {
      for (const mode of ["clock", "correction", "disconnect", "execution-session", "revocation", "age"]) {
        const f = await fixture(), holder = await pool.connect(), original = f.store.recoverClock.bind(f.store), now = Date.now;
        await f.drained(); if (mode === "correction") f.socket.fills = [f.socket.fill("race.01")];
        await f.store.gap(f.service.status().sourceGeneration, "ACCOUNTING_CLOCK_INVALID");
        let entered!: () => void; const atLock = new Promise<void>(resolve => { entered = resolve; });
        f.store.recoverClock = async (e, guard, reservation) => {
          await holder.query("BEGIN"); await holder.query("SELECT 1 FROM broker_accounting_sources WHERE source_id=$1 FOR UPDATE", [f.store.sourceId]);
          entered(); return original(e, guard,reservation);
        };
        try {
          const operation = f.service.recoverClock(), rejection = assert.rejects(operation);
          await Promise.race([atLock, rejection.then(() => { throw Error("recovery failed before lock"); })]);
          if (mode === "clock") f.socket.emit("currentTime", NaN);
          if (mode === "correction") { const fill = f.socket.fills[0]; f.socket.emit("execDetails", -1, fill.contract, { ...fill.exec, price: 99 }); }
          if (mode === "disconnect") f.socket.disconnect();
          if (mode === "execution-session") f.identity.generation++;
          const invalidating = mode === "revocation" ? f.service.invalidate("fixture revocation") : undefined;
          if (mode === "age") Date.now = () => now()+11_000;
          await holder.query("COMMIT"); await rejection; await invalidating;
        } finally { Date.now = now; await holder.query("ROLLBACK"); holder.release(); }
        assert.equal((await f.store.control()).hold, mode === "correction" ? "ACCOUNTING_CORRECTION_UNRESOLVED" : "ACCOUNTING_CLOCK_INVALID");
        assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_recovery'", [f.store.sourceId])).rows[0].count, "0");
        await f.service.close();
      }
    });
    await t.test("clock recovery receipt and clear roll back together after an injected database failure", async () => {
      const f = await fixture(); await f.drained(); await f.store.gap(f.service.status().sourceGeneration, "ACCOUNTING_CLOCK_INVALID");
      await pool.query(`CREATE FUNCTION clock_recovery_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.hold='ACCOUNTING_CLOCK_INVALID' AND NEW.hold IS NULL THEN RAISE EXCEPTION 'fixture injected failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER clock_recovery_fixture_failure BEFORE UPDATE ON broker_accounting_sources FOR EACH ROW EXECUTE FUNCTION clock_recovery_fixture_failure()`);
      try {
        await assert.rejects(f.service.recoverClock(), /fixture injected failure/);
        assert.equal((await f.store.control()).hold, "ACCOUNTING_CLOCK_INVALID");
        assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_recovery'", [f.store.sourceId])).rows[0].count, "0");
      } finally {
        await pool.query("DROP TRIGGER clock_recovery_fixture_failure ON broker_accounting_sources; DROP FUNCTION clock_recovery_fixture_failure()");
        await f.service.close();
      }
    });
    await t.test("restart preserves old clock hold and recovery requires new current evidence", async () => {
      const f = await fixture(); await f.qualify(); const q = f.service.status().qualificationId;
      await f.store.gap(f.service.status().sourceGeneration, "ACCOUNTING_CLOCK_INVALID"); await f.service.close();
      const store = new AccountingSourceStore(pool, f.store.sourceId, randomUUID());
      const replacement = new AccountingSourceService(store, f.settings, "a".repeat(64), () => f.identity, () => new Socket(f.account));
      await replacement.initialize();
      assert.equal((await store.control()).hold, "ACCOUNTING_CLOCK_INVALID");
      await assert.rejects(replacement.inspect(), /CLOCK_INVALID/);
      const receipt = await replacement.recoverClock();
      assert.equal(receipt.qualificationId, q); assert.equal((await store.control()).hold, null);
      assert.throws(() => replacement.assertCurrent(), /CLOCK_RECOVERY_VERIFYING/); await replacement.close();
    });
    await t.test("a callback immediately before recovery commit prevents a stale clear", async () => {
      const f = await fixture(); await f.drained(); await f.store.gap(f.service.status().sourceGeneration, "ACCOUNTING_CLOCK_INVALID");
      const original = f.store.transaction.bind(f.store);
      f.store.transaction = (fn, beforeCommit) => original(async db => {
        const result = await fn(db);
        if (result && typeof result === "object" && "receipt" in result) f.socket.emit("currentTime", NaN);
        return result;
      }, beforeCommit);
      await assert.rejects(f.service.recoverClock(), /PERSISTENCE_PENDING|CLOCK_RECOVERY_CHANGED/);
      assert.equal((await f.store.control()).hold, "ACCOUNTING_CLOCK_INVALID");
      assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_recovery'", [f.store.sourceId])).rows[0].count, "0");
      await f.service.close();
    });
    await t.test("final database clock freshness rejects a stale transaction independently of process time", async () => {
      const f = await fixture(); await f.drained(); await f.store.gap(f.service.status().sourceGeneration, "ACCOUNTING_CLOCK_INVALID");
      const original = f.store.transaction.bind(f.store), now = Date.now, frozen = Date.now();
      f.store.transaction = (fn, beforeCommit) => original(db => fn(new Proxy(db, { get(target, property) {
        if (property !== "query") return Reflect.get(target, property);
        return async (text: string, values?: unknown[]) => {
          const result = await db.query(text, values);
          if (text.includes("AS recovery_database_now")) result.rows[0].recovery_database_now = new Date(frozen+11_000);
          return result;
        };
      } })), beforeCommit);
      try { Date.now = () => frozen; await assert.rejects(f.service.recoverClock(), /CLOCK_RECOVERY_STALE/); }
      finally { Date.now = now; }
      assert.equal((await f.store.control()).hold, "ACCOUNTING_CLOCK_INVALID");
      assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_recovery'", [f.store.sourceId])).rows[0].count, "0");
      await f.service.close();
    });
    await t.test("automatic recovery charges once, keeps arbiter fast and gates entry through joined capture", async () => {
      const f=await fixture(true); await f.qualify(); await f.capture(); await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,"ACCOUNTING_CLOCK_INVALID");
      let release!:()=>void, entered!:()=>void;
      const started=new Promise<void>(resolve=>{entered=resolve;});
      f.next.configure=socket=>{const read=socket.reqExecutions.bind(socket);socket.reqExecutions=id=>{release=()=>read(id);entered();};};
      const recovering=f.service.automaticRecovery(new AbortController().signal);
      await started;
      const before=Date.now();
      await assert.rejects(f.service.inspect(),/SOURCE_BUSY/);
      await assert.rejects(f.service.recoverClock(),/SOURCE_BUSY/);
      await assert.rejects(f.capture(),/REPLAY_INCOMPLETE/);
      assert.ok(Date.now()-before<500);
      assert.throws(()=>f.service.assertCurrent());
      release(); const receipt=await recovering; assert.ok(receipt);
      assert.equal(f.service.status().automaticClockRecovery.state,'VERIFYING');
      assert.throws(()=>f.service.assertCurrent(),/CLOCK_RECOVERY_VERIFYING/);
      f.socket.reqExecutions=id=>f.socket.emit('execDetailsEnd',id);
      assert.equal((await f.capture()).day.ok,true);
      assert.equal(f.service.status().automaticClockRecovery.state,'RECOVERED');
      assert.equal(f.service.status().automaticClockRecovery.attemptCount,1);
      await f.service.close();
    });
    await t.test("three failed automatic attempts exhaust durably; manual proof preserves automatic budget", async () => {
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      f.next.configure=socket=>{socket.reqCurrentTime=()=>socket.emit('currentTime',NaN);};
      let episodeId:string|null=null;
      for(let count=1;count<=3;count++) {
        await assert.rejects(f.service.automaticRecovery(new AbortController().signal),/CLOCK_INVALID/);
        const status=f.service.status().automaticClockRecovery;
        episodeId ??=status.episodeId; assert.equal(status.episodeId,episodeId);assert.equal(status.attemptCount,count);
        assert.equal(status.state,count===3?'OPERATOR_REQUIRED':'BACKOFF');
        if(count<3) {
          const remaining=Date.parse(status.nextAttemptAt!)-Date.now();assert.ok(remaining>(count===1?29000:119000));
          await pool.query("UPDATE broker_accounting_clock_episodes SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[episodeId]);
        }
      }
      assert.equal(await f.service.automaticRecovery(new AbortController().signal),null);
      f.next.configure=()=>{};
      await f.service.recoverClock(); await f.capture();
      assert.equal(f.service.status().automaticClockRecovery.attemptCount,3);
      assert.equal(f.service.status().automaticClockRecovery.state,'RECOVERED');
      assert.equal((await pool.query('SELECT count(*) FROM broker_accounting_clock_attempts WHERE source_id=$1',[f.store.sourceId])).rows[0].count,'4');
      await assert.rejects(pool.query('UPDATE broker_accounting_clock_attempts SET automatic=false WHERE source_id=$1',[f.store.sourceId]),/immutable/i);
      await f.service.close();
    });
    await t.test("rolling source cap spans recovered episodes and refuses seventh acquisition", async () => {
      const f=await fixture(true);await f.qualify();await f.drained();
      for(let n=0;n<6;n++) {
        await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
        assert.ok(await f.service.automaticRecovery(new AbortController().signal));await f.capture();
      }
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      assert.equal(await f.service.automaticRecovery(new AbortController().signal),null);
      assert.equal(f.service.status().automaticClockRecovery.state,'OPERATOR_REQUIRED');
      await assert.rejects(f.service.recoverClock(),/LIMIT/);
      assert.equal((await pool.query('SELECT count(*) FROM broker_accounting_clock_attempts WHERE source_id=$1',[f.store.sourceId])).rows[0].count,'6');
      await f.service.close();
    });
    await t.test("lost claim response resolves charged attempt without another socket or uncharged retry", async()=>{
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      const before=f.socket,claim=f.store.recovery.claim.bind(f.store.recovery);
      f.store.recovery.claim=async(...args)=>{await claim(...args);throw Object.assign(new Error('lost claim response'),{commitUnknown:true});};
      await assert.rejects(f.service.automaticRecovery(new AbortController().signal),/lost claim/);
      assert.equal(f.socket,before);assert.equal(f.service.status().automaticClockRecovery.attemptCount,1);
      assert.equal(f.service.status().automaticClockRecovery.state,'OPERATOR_REQUIRED');
      assert.equal((await pool.query('SELECT count(*) FROM broker_accounting_clock_attempts WHERE source_id=$1',[f.store.sourceId])).rows[0].count,'1');
      await f.service.close();
    });
    await t.test("lost receipt COMMIT resolves stable attempt to VERIFYING with no second recovery",async()=>{
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      const recover=f.store.recoverClock.bind(f.store);
      f.store.recoverClock=async(...args)=>{await recover(...args);throw Object.assign(new Error('lost receipt response'),{commitUnknown:true});};
      const receipt=await f.service.automaticRecovery(new AbortController().signal);assert.ok(receipt);
      assert.equal(f.service.status().automaticClockRecovery.state,'VERIFYING');
      assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_recovery'",[f.store.sourceId])).rows[0].count,'1');
      await f.capture();assert.equal(f.service.status().automaticClockRecovery.state,'RECOVERED');await f.service.close();
    });
    await t.test("manual evidence-only completion requires current capture and never opens a socket or resets limits",async()=>{
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      const receipt=await f.service.automaticRecovery(new AbortController().signal);
      await f.service.requireRecoveryOperator('ACCOUNTING_CLOCK_RECOVERY_VERIFY_TIMEOUT');
      await assert.rejects(f.service.recoverClock(),/HOLD_MISMATCH/);
      assert.equal((await f.capture()).day.ok,false);
      assert.throws(()=>f.service.assertCurrent(),/OPERATOR_REQUIRED/);
      const socket=f.socket,done=await f.service.recoverClock();
      assert.equal(done.id,receipt!.id);assert.equal(f.socket,socket);
      assert.equal(f.service.status().automaticClockRecovery.attemptCount,1);
      assert.equal(f.service.status().automaticClockRecovery.state,'RECOVERED');
      await f.capture();await f.service.close();
    });
    await t.test("invalid clock in VERIFYING preserves episode and applies second-attempt backoff",async()=>{
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      await f.service.automaticRecovery(new AbortController().signal);
      const episode=f.service.status().automaticClockRecovery.episodeId;
      f.socket.emit('currentTime',NaN);await f.drained();
      assert.equal(f.service.status().automaticClockRecovery.state,'BACKOFF');
      await pool.query("UPDATE broker_accounting_clock_episodes SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[episode]);
      await f.service.automaticRecovery(new AbortController().signal);
      f.socket.emit('currentTime',NaN);await f.drained();
      const state=f.service.status().automaticClockRecovery;
      assert.equal(state.episodeId,episode);assert.equal(state.attemptCount,2);
      assert.ok(Date.parse(state.nextAttemptAt!)-Date.now()>119000);
      await f.service.close();
    });
    await t.test("lifetime endpoint owner prevents a second service from begin even with automatic flag disabled",async()=>{
      const f=await fixture(false);await f.drained();const original=(await f.store.control()).process_session_id;
      let sockets=0;
      const otherStore=new AccountingSourceStore(pool,f.store.sourceId,randomUUID());
      const other=new AccountingSourceService(otherStore,f.settings,'a'.repeat(64),()=>f.identity,()=>{sockets++;return new Socket(f.account);});
      await assert.rejects(other.initialize(),/SOURCE_OWNER_CONFLICT/);
      assert.equal(sockets,0);assert.equal((await f.store.control()).process_session_id,original);
      await f.service.close();
    });
    await t.test("disabled automatic recovery cannot spend an attempt and restart preserves exhaustion",async()=>{
      const disabled=await fixture(false);await disabled.qualify();await disabled.drained();
      await disabled.store.gap(disabled.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      assert.equal(await disabled.service.automaticRecovery(new AbortController().signal),null);
      assert.equal((await pool.query('SELECT count(*) FROM broker_accounting_clock_attempts WHERE source_id=$1',[disabled.store.sourceId])).rows[0].count,'0');
      await disabled.service.close();
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      f.next.configure=socket=>{socket.reqCurrentTime=()=>socket.emit('currentTime',NaN);};
      await assert.rejects(f.service.automaticRecovery(new AbortController().signal));
      const episode=f.service.status().automaticClockRecovery.episodeId;await f.service.close();
      const restarted=new AccountingSourceService(new AccountingSourceStore(pool,f.store.sourceId,randomUUID()),f.settings,'a'.repeat(64),()=>f.identity,()=>new Socket(f.account),undefined,{automaticClockRecoveryEnabled:true});
      await restarted.initialize();
      assert.equal(restarted.status().automaticClockRecovery.episodeId,episode);
      assert.equal(restarted.status().automaticClockRecovery.state,'OPERATOR_REQUIRED');
      assert.equal(await restarted.automaticRecovery(new AbortController().signal),null);
      await restarted.close();
    });
    await t.test("uncertain receipt result stays OUTCOME_UNKNOWN and cannot silently rearm",async()=>{
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      f.store.recoverClock=async()=>{throw Object.assign(new Error('connection lost'),{commitUnknown:true});};
      f.store.recovery.resolve=async()=> 'unknown';
      await assert.rejects(f.service.automaticRecovery(new AbortController().signal),/connection lost/);
      assert.equal(f.service.status().automaticClockRecovery.state,'OUTCOME_UNKNOWN');
      await assert.rejects(f.service.automaticRecovery(new AbortController().signal),/OUTCOME_UNKNOWN/);
      await assert.rejects(f.service.recoverClock(),/OUTCOME_UNKNOWN/);
      assert.equal((await pool.query('SELECT count(*) FROM broker_accounting_clock_attempts WHERE source_id=$1',[f.store.sourceId])).rows[0].count,'1');
      await f.service.close();
    });
    await t.test("database lock delay is bounded and cannot publish receipt after its transaction deadline",async()=>{
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      const holder=await pool.connect(),recover=f.store.recoverClock.bind(f.store);
      f.store.recoverClock=async(...args)=>{await holder.query('BEGIN');await holder.query('SELECT 1 FROM broker_accounting_sources WHERE source_id=$1 FOR UPDATE',[f.store.sourceId]);return recover(...args);};
      const start=Date.now();
      const operation=f.service.automaticRecovery(new AbortController().signal);
      const release=setTimeout(()=>void holder.query('ROLLBACK'),2500);
      try {await assert.rejects(operation);assert.ok(Date.now()-start<5000);}
      finally {clearTimeout(release);await holder.query('ROLLBACK');holder.release();}
      assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_recovery'",[f.store.sourceId])).rows[0].count,'0');
      assert.throws(()=>f.service.assertCurrent());
      await f.service.close();
    });
    await t.test("late capture cannot automatically complete expired VERIFYING; current proof permits manual closure",async()=>{
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      await f.service.automaticRecovery(new AbortController().signal);
      const episode=f.service.status().automaticClockRecovery.episodeId;
      await pool.query("UPDATE broker_accounting_clock_episodes SET verifying_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",[episode]);
      const capture=await f.capture();assert.equal(capture.day.ok,false);
      assert.equal(f.service.status().automaticClockRecovery.state,'OPERATOR_REQUIRED');
      assert.throws(()=>f.service.assertCurrent(),/OPERATOR_REQUIRED/);
      await f.service.recoverClock();assert.equal(f.service.status().automaticClockRecovery.state,'RECOVERED');
      await f.service.close();
    });
    await t.test("retired socket keeps lifetime owner for concurrent execution persistence and next bounded acquisition",async()=>{
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      f.next.configure=socket=>{socket.reqCurrentTime=()=>socket.emit('currentTime',NaN);};
      await assert.rejects(f.service.automaticRecovery(new AbortController().signal),/CLOCK_INVALID/);
      let legacy=0;
      f.service.observeExecution({execId:'after-retirement',accountId:f.account,conid:'123',symbol:'TEST',secType:'STK',currency:'USD',exchange:'NASDAQ',side:'BUY',shares:1,price:100,orderId:1,executedAt:new Date(Date.now()-60000).toISOString()},async()=>{legacy++;});
      f.service.observeCommission({execId:'after-retirement',currency:'USD',commission:1,realizedPnL:-2},async()=>{});
      await f.drained();assert.equal(legacy,1);assert.notEqual(f.service.status().hold,'ACCOUNTING_PERSISTENCE_FAILED');
      assert.equal((await pool.query("SELECT count(*) FROM broker_accounting_observations WHERE source_id=$1 AND lane='execution' AND kind='execution'",[f.store.sourceId])).rows[0].count,'1');
      assert.equal(f.service.status().automaticClockRecovery.state,'BACKOFF');
      assert.throws(()=>f.service.assertCurrent(),/SOURCE_OWNER_LOST/);
      await f.service.close();
    });
    await t.test("clock diagnostics retain observed timing and sanitized original failure cause",async()=>{
      const f=await fixture(true);await f.qualify();await f.drained();
      await f.store.gap(f.service.status().sourceGeneration,'ACCOUNTING_CLOCK_INVALID');
      f.next.configure=socket=>{socket.reqCurrentTime=()=>socket.emit('currentTime',NaN);};
      await assert.rejects(f.service.automaticRecovery(new AbortController().signal));
      const status=f.service.status().automaticClockRecovery;
      assert.equal(status.rejectedClock?.reportedSeconds,'NaN');assert.equal(status.rejectedClock?.skewMs,undefined);
      assert.ok(status.rejectedClock?.requestedAt);assert.ok(status.rejectedClock?.receivedAt);
      assert.equal(status.originalCause?.name,'Error');assert.equal(status.originalCause?.message,'ACCOUNTING_CLOCK_INVALID');assert.equal(status.originalCause?.code,null);
      await f.service.close();
    });
    await t.test("reconnect reuses unchanged unexpired settings only after new full replay; revocation is immediate", async () => {
      const f = await fixture(); await f.qualify(); const first = await f.capture(); const q = f.service.status().qualificationId;
      f.socket.disconnect(); assert.throws(() => f.service.assertCurrent(first.joined.accounting));
      const next = await f.capture(); assert.equal(next.day.ok, true, JSON.stringify(next.day)); assert.equal(f.service.status().qualificationId, q);
      assert.notEqual(next.joined.accounting!.connectionReceiptId, first.joined.accounting!.connectionReceiptId);
      const invalidating = f.service.invalidate("operator settings changed"); assert.throws(() => f.service.assertCurrent(next.joined.accounting)); await invalidating;
      assert.equal(f.service.status().qualificationId, null); await f.service.close();
    });
  } finally {
    try {
      let remaining = pool.totalCount;
      const removed = new Promise<void>(resolve => {
        if (remaining === 0) resolve();
        else pool.on("remove", () => { if (--remaining === 0) resolve(); });
      });
      try { await pool.end(); await removed; }
      finally { if (created) await admin.query(`DROP DATABASE ${database}`); }
    } finally { await admin.end(); }
  }
});
