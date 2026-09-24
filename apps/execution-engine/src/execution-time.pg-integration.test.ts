import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runMigrations } from "./migrations.js";
import { ExecutionRepository } from "./repository.js";
import { TwsExecutionClient } from "./tws-execution-client.js";
import type { ExecutionTimeZone } from "./execution-time.js";
const url = process.env.TEST_POSTGRES_URL;

test("actual execution callback persists canonical UTC or NULL without dropping the fill", { skip: !url }, async () => {
  const connection = new URL(url!); connection.pathname = "/postgres";
  const admin = new Pool({ connectionString: connection.toString() });
  const name = "filltime_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE ${name}`); connection.pathname = "/" + name;
  const pool = new Pool({ connectionString: connection.toString() });
  try {
    await runMigrations(pool); const repo = new ExecutionRepository(pool);
    const cases: [string | undefined, ExecutionTimeZone | undefined, string | null][] = [
      ["20260924  15:30:21", "Europe/Warsaw", "2026-09-24T13:30:21.000Z"],
      ["20260115 15:30:21", "Europe/Warsaw", "2026-01-15T14:30:21.000Z"],
      ["20260924 15:30:21 UTC", "Europe/Warsaw", "2026-09-24T15:30:21.000Z"],
      ["20260924 15:30:21", "UTC", "2026-09-24T15:30:21.000Z"],
      ["20260924 15:30:21", undefined, null],
      ["20261025 02:30:00", "Europe/Warsaw", null],
      ["20260329 02:30:00", "Europe/Warsaw", null],
      [undefined, "Europe/Warsaw", null],
    ];
    for (const [index, [time, executionTimeZone, expected]] of cases.entries()) {
      const ib = new EventEmitter(); const pending: Promise<void>[] = [];
      new TwsExecutionClient({ host: "unused", port: 0, clientId: 1, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100, executionTimeZone },
        () => {}, undefined, fill => { pending.push(repo.upsertBrokerExecutionFill(fill)); }, undefined, { ib });
      ib.emit("execDetails", 1, { conId: 123, symbol: "TEST", currency: "USD" },
        { execId: `fill-${index}`, orderId: 1, acctNumber: "PAPER-TEST", shares: 1, side: "BOT", price: 100, time });
      assert.equal(pending.length, 1); await Promise.all(pending);
      const { rows } = await pool.query("SELECT executed_at,shares FROM broker_execution_fills WHERE exec_id=$1", [`fill-${index}`]);
      assert.equal(rows.length, 1); assert.equal(Number(rows[0].shares), 1);
      assert.equal(rows[0].executed_at?.toISOString() ?? null, expected);
    }
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
});
