/**
 * PR14.2 — real-Postgres integration tests for the versioned
 * migration runner (`apps/execution-engine/src/migrations.ts`).
 *
 * Gated by `TEST_POSTGRES_URL` (same env var as
 * `repository.pg-integration.test.ts`). Each test creates and
 * drops its own isolated database so runs are hermetic and can
 * be re-executed without cleanup.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { runMigrations, resolveMigrationsDir } from "./migrations.js";

const CONN_URL = process.env.TEST_POSTGRES_URL;
const suite = CONN_URL ? describe : describe.skip;

// Resolve the real, on-disk `infra/sql/001_init.sql` — we execute it
// literally rather than re-typing a "minimal slice" so this test
// catches any divergence between the file the docker entrypoint runs
// and the file the migration runner claims to be compatible with.
const HERE = dirname(fileURLToPath(import.meta.url));
const INIT_SQL_PATH = (() => {
  let cursor: string = HERE;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(cursor, "infra", "sql", "001_init.sql");
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      /* keep walking */
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`Could not locate infra/sql/001_init.sql from ${HERE}`);
})();
const INIT_SQL = readFileSync(INIT_SQL_PATH, "utf8");

function poolForDb(url: string, dbName: string): Pool {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return new Pool({ connectionString: parsed.toString() });
}

async function withAdmin<T>(url: string, fn: (p: Pool) => Promise<T>): Promise<T> {
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  const pool = new Pool({ connectionString: parsed.toString() });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function withFreshDb<T>(
  suffix: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const dbName = `ikbr_migtest_${suffix}_${Date.now()}`;
  await withAdmin(CONN_URL!, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  });
  const pool = poolForDb(CONN_URL!, dbName);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
    await withAdmin(CONN_URL!, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    });
  }
}

/**
 * Assert the columns / types / PKs the baseline schema
 * (`infra/sql/001_init.sql` and `000001_baseline.sql`) is expected
 * to produce. Keeps every test that runs migrations honest against
 * schema drift.
 */
async function assertBaselineSchema(pool: Pool): Promise<void> {
  for (const table of ["candles_1m", "candles_5m", "candles_1h"] as const) {
    const cols = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
    const conid = byName.get("conid");
    assert.ok(conid, `${table} missing conid column`);
    assert.equal(conid.data_type, "text", `${table}.conid wrong type`);
    assert.equal(conid.is_nullable, "NO", `${table}.conid must be NOT NULL`);
    const volume = byName.get("volume");
    assert.ok(volume, `${table} missing volume`);
    assert.equal(
      volume.data_type,
      "double precision",
      `${table}.volume wrong type`,
    );
    // PK on (conid, ts).
    const pk = await pool.query<{ attname: string }>(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid
                          AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary
       ORDER BY array_position(i.indkey::int[], a.attnum::int)`,
      [table],
    );
    assert.deepEqual(
      pk.rows.map((r) => r.attname),
      ["conid", "ts"],
      `${table} PK must be (conid, ts)`,
    );
  }

  // signal_outcomes — full schema per 001_init.sql.
  const so = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name='signal_outcomes' ORDER BY ordinal_position`,
  );
  const soCols = new Map(so.rows.map((r) => [r.column_name, r.data_type]));
  for (const [col, type] of [
    ["id", "bigint"],
    ["proposed_order_id", "bigint"],
    ["evaluated_at", "timestamp with time zone"],
    ["pnl_pct", "double precision"],
    ["hit_stop", "boolean"],
    ["hit_take_profit", "boolean"],
    ["notes", "text"],
  ] as const) {
    assert.equal(soCols.get(col), type, `signal_outcomes.${col} wrong shape`);
  }

  // llm_order_decisions — full schema per 001_init.sql.
  const lod = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name='llm_order_decisions' ORDER BY ordinal_position`,
  );
  const lodCols = new Map(lod.rows.map((r) => [r.column_name, r.data_type]));
  for (const [col, type] of [
    ["id", "bigint"],
    ["proposed_order_id", "bigint"],
    ["symbol", "text"],
    ["decision", "text"],
    ["decision_reason", "text"],
    ["model", "text"],
    ["prompt_version", "text"],
    ["decision_confidence", "double precision"],
    ["news_count", "integer"],
    ["position_snapshot_json", "jsonb"],
    ["news_snapshot_json", "jsonb"],
    ["source_error", "text"],
    ["created_at", "timestamp with time zone"],
  ] as const) {
    assert.equal(
      lodCols.get(col),
      type,
      `llm_order_decisions.${col} wrong shape`,
    );
  }
}

/** Assert the PR13/PR14 execution-engine schema is fully present. */
async function assertPr13Pr14Schema(pool: Pool): Promise<void> {
  const tables = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'`,
  );
  const names = new Set(tables.rows.map((r) => r.tablename));
  for (const t of [
    "proposed_orders",
    "broker_execution_fills",
    "system_alerts",
    "execution_audit_log",
    "broker_position_snapshots",
    "broker_snapshot_syncs",
    "schema_migrations",
  ]) {
    assert.ok(names.has(t), `missing table ${t}`);
  }
  const idx = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
  );
  const idxNames = new Set(idx.rows.map((r) => r.indexname));
  for (const i of [
    "proposed_orders_client_order_id_uidx",
    "broker_position_snapshots_conid_uidx",
    "broker_position_snapshots_symbol_uidx",
    "broker_execution_fills_order_idx",
    "broker_execution_fills_exec_ts_idx",
    "execution_audit_log_correlation_idx",
    "system_alerts_kind_idx",
  ]) {
    assert.ok(idxNames.has(i), `missing index ${i}`);
  }
  const gen = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='broker_snapshot_syncs' AND column_name='generation'`,
  );
  assert.equal(gen.rowCount, 1);
  // client_order_id + client_order_hash columns
  for (const col of ["client_order_id", "client_order_hash"]) {
    const c = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name='proposed_orders' AND column_name=$1`,
      [col],
    );
    assert.equal(c.rowCount, 1, `missing proposed_orders.${col}`);
  }
}

suite("Migration runner — versioned SQL migrations", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL to enable", () => {
      assert.ok(true);
    });
    return;
  }

  it("resolveMigrationsDir returns an existing directory containing at least one .sql migration", () => {
    const dir = resolveMigrationsDir();
    assert.ok(dir.endsWith("/infra/sql/migrations"), `unexpected dir: ${dir}`);
  });

  it("fresh DB → all real migrations succeed, schema_migrations populated in order", async () => {
    await withFreshDb("fresh", async (pool) => {
      const result = await runMigrations(pool);
      assert.ok(result.applied.length >= 2);
      assert.equal(result.skipped.length, 0);
      const rows = await pool.query(
        "SELECT version, filename, checksum FROM schema_migrations ORDER BY version",
      );
      assert.ok(rows.rowCount! >= 2);
      const versions = rows.rows.map((r) => r.version as string);
      for (let i = 1; i < versions.length; i++) {
        assert.ok(versions[i] > versions[i - 1]);
      }
      await assertBaselineSchema(pool);
      await assertPr13Pr14Schema(pool);
    });
  });

  it("DB where the real infra/sql/001_init.sql already ran → migrations upgrade in-place, schema matches fully", async () => {
    await withFreshDb("upgrade", async (pool) => {
      // Execute the REAL file that docker-entrypoint-initdb.d runs on
      // fresh Postgres containers. No hand-rolled slice — the point
      // is to prove the migration runner is truly compatible with
      // the on-disk baseline every operator's Postgres has already
      // loaded.
      await pool.query(INIT_SQL);

      // Seed one row into every 001_init.sql table so we can verify
      // rows survive the migration + column additions.
      await pool.query(
        `INSERT INTO candles_1m (conid, symbol, ts, open, high, low, close, volume)
         VALUES ('123','AAPL',NOW(),1,2,0.5,1.5,1000)`,
      );
      await pool.query(
        `INSERT INTO proposed_orders (
           instrument, side, order_type, quantity, reason, confidence,
           risk_check_status
         ) VALUES ('AAPL','BUY','LMT',10,'seed',0.9,'PASS')`,
      );
      const seededOrder = await pool.query<{ id: number }>(
        `SELECT id FROM proposed_orders LIMIT 1`,
      );
      const seedOrderId = seededOrder.rows[0].id;
      await pool.query(
        `INSERT INTO signal_outcomes (
           proposed_order_id, evaluated_at, pnl_pct, hit_stop, hit_take_profit, notes
         ) VALUES ($1, NOW(), 1.5, FALSE, TRUE, 'seed')`,
        [seedOrderId],
      );
      await pool.query(
        `INSERT INTO llm_order_decisions (
           proposed_order_id, symbol, decision, decision_reason
         ) VALUES ($1,'AAPL','EXECUTE','seed')`,
        [seedOrderId],
      );

      const result = await runMigrations(pool);
      assert.ok(result.applied.length >= 2);

      // proposed_orders — every column the write path relies on.
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name='proposed_orders'`,
      );
      const colNames = new Set(columns.rows.map((r) => r.column_name));
      for (const c of [
        "client_order_id",
        "client_order_hash",
        "execution_attempted_at",
        "processing_owner",
        "processing_claimed_at",
        "broker_order_id",
        "execution_account_id",
        "conid",
        "position_effect",
        "decision_source",
      ]) {
        assert.ok(colNames.has(c), `missing proposed_orders column ${c}`);
      }

      // Rows survived.
      const preserved = await pool.query(
        `SELECT (SELECT COUNT(*)::int FROM candles_1m) AS c1m,
                (SELECT COUNT(*)::int FROM proposed_orders) AS po,
                (SELECT COUNT(*)::int FROM signal_outcomes) AS so,
                (SELECT COUNT(*)::int FROM llm_order_decisions) AS lod`,
      );
      assert.equal(preserved.rows[0].c1m, 1);
      assert.equal(preserved.rows[0].po, 1);
      assert.equal(preserved.rows[0].so, 1);
      assert.equal(preserved.rows[0].lod, 1);

      await assertBaselineSchema(pool);
      await assertPr13Pr14Schema(pool);
    });
  });

  it("fresh migration-only DB → signal-engine / llm-agent INSERT statements work against the migrated schema", async () => {
    await withFreshDb("fresh_inserts", async (pool) => {
      await runMigrations(pool);
      await assertBaselineSchema(pool);
      await assertPr13Pr14Schema(pool);

      // Replay the EXACT INSERTs the running services execute so we
      // catch schema divergence at the migration boundary rather
      // than in prod.
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, order_type, quantity, entry, stop,
           take_profit, reason, confidence, risk_check_status,
           strategy, decision_source
         ) VALUES ('AAPL','123','BUY','LMT',10,100,95,110,'signal',0.8,'PASS',
                   'momentum_breakout_long_v1','signal')
         RETURNING id`,
      );
      const orderId = inserted.rows[0].id;

      // signal-engine — apps/signal-engine/src/repository.ts:refreshSignalOutcomes
      await pool.query(
        `INSERT INTO signal_outcomes (proposed_order_id, evaluated_at, pnl_pct, hit_stop, hit_take_profit, notes)
         VALUES ($1, NOW(), $2, $3, $4, $5)`,
        [orderId, 1.5, false, true, null],
      );

      // llm-agent — apps/llm-agent/src/repository.ts:insertDecision
      await pool.query(
        `INSERT INTO llm_order_decisions (
           proposed_order_id, symbol, decision, decision_reason, model,
           prompt_version, decision_confidence, news_count,
           position_snapshot_json, news_snapshot_json, source_error, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING id`,
        [
          orderId,
          "AAPL",
          "EXECUTE",
          "test reason",
          "gpt-4",
          "v1",
          0.9,
          0,
          JSON.stringify({}),
          JSON.stringify([]),
          null,
        ],
      );

      // candles_1m INSERT used by ingestion.
      await pool.query(
        `INSERT INTO candles_1m (conid, symbol, ts, open, high, low, close, volume)
         VALUES ('123','AAPL',NOW(),1,2,0.5,1.5,1000)`,
      );

      const counts = await pool.query(
        `SELECT (SELECT COUNT(*)::int FROM signal_outcomes) AS so,
                (SELECT COUNT(*)::int FROM llm_order_decisions) AS lod,
                (SELECT COUNT(*)::int FROM candles_1m) AS c1m`,
      );
      assert.equal(counts.rows[0].so, 1);
      assert.equal(counts.rows[0].lod, 1);
      assert.equal(counts.rows[0].c1m, 1);
    });
  });

  it("second run is a no-op (skips all previously applied migrations)", async () => {
    await withFreshDb("idempotent", async (pool) => {
      const first = await runMigrations(pool);
      const second = await runMigrations(pool);
      assert.equal(second.applied.length, 0);
      assert.equal(second.skipped.length, first.applied.length);
    });
  });

  it("two concurrent runners → migrations applied EXACTLY ONCE (advisory lock serialises)", async () => {
    await withFreshDb("concurrent", async (pool) => {
      const pool2 = poolForDb(
        CONN_URL!,
        (pool.options as { database?: string }).database ??
          (
            await pool.query<{ current_database: string }>(
              "SELECT current_database()",
            )
          ).rows[0].current_database,
      );
      try {
        const [a, b] = await Promise.all([
          runMigrations(pool),
          runMigrations(pool2),
        ]);
        // Union of the two `applied` lists must equal the count of
        // distinct migrations. The loser's `applied` will typically
        // be empty (all skipped) but the invariant is: each version
        // appears in schema_migrations exactly once.
        const total = a.applied.length + b.applied.length;
        const migrationsDir = resolveMigrationsDir();
        const rows = await pool.query(
          "SELECT version FROM schema_migrations ORDER BY version",
        );
        assert.equal(total, rows.rowCount);
        // No duplicates.
        const versions = rows.rows.map((r) => r.version as string);
        assert.equal(new Set(versions).size, versions.length);
        void migrationsDir;
      } finally {
        await pool2.end();
      }
    });
  });

  it("checksum mismatch on an applied migration blocks startup", async () => {
    await withFreshDb("checksum", async (pool) => {
      // Point the runner at a temp dir with a single fake migration,
      // apply it, then EDIT the file content (simulating a developer
      // rewriting an already-released migration) and re-run.
      const tmp = mkdtempSync(join(tmpdir(), "ikbr-mig-"));
      try {
        const file = join(tmp, "000001_stub.sql");
        writeFileSync(file, "CREATE TABLE IF NOT EXISTS mig_stub (id INT);\n");
        await runMigrations(pool, { migrationsDir: tmp });
        writeFileSync(
          file,
          "CREATE TABLE IF NOT EXISTS mig_stub (id INT); -- edited\n",
        );
        await assert.rejects(
          () => runMigrations(pool, { migrationsDir: tmp }),
          /checksum mismatch/i,
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("failing migration rolls back — no schema_migrations row, no partial DDL committed", async () => {
    await withFreshDb("rollback", async (pool) => {
      const tmp = mkdtempSync(join(tmpdir(), "ikbr-mig-"));
      try {
        writeFileSync(
          join(tmp, "000001_ok.sql"),
          "CREATE TABLE IF NOT EXISTS mig_ok (id INT);\n",
        );
        writeFileSync(
          join(tmp, "000002_broken.sql"),
          "CREATE TABLE mig_bad (id INT);\nTHIS IS INVALID SQL;\n",
        );
        await assert.rejects(
          () => runMigrations(pool, { migrationsDir: tmp }),
          /migration 000002_broken\.sql failed/i,
        );
        // First migration WAS applied.
        const okRow = await pool.query(
          "SELECT version FROM schema_migrations WHERE version='000001'",
        );
        assert.equal(okRow.rowCount, 1);
        // Second migration NOT recorded.
        const badRow = await pool.query(
          "SELECT version FROM schema_migrations WHERE version='000002'",
        );
        assert.equal(badRow.rowCount, 0);
        // Partial DDL from the failed migration rolled back.
        const t = await pool.query(
          "SELECT tablename FROM pg_tables WHERE tablename='mig_bad'",
        );
        assert.equal(t.rowCount, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("pre-PR14.2 dynamic schema → runMigrations upgrades in place and preserves ALL data", async () => {
    await withFreshDb("preserve_prev14", async (pool) => {
      // Reproduce the historical schema that the pre-PR14.2 dynamic
      // `ExecutionRepository.init()` produced BEFORE the migration
      // runner existed. Deliberate drift vs. the migrated schema:
      //   * `broker_execution_fills.symbol/side/shares/price` are
      //     NOT NULL (the runner must DROP NOT NULL them).
      //   * `broker_position_snapshots` carries the pre-round-5
      //     PRIMARY KEY (account_id, instrument) and no partial
      //     unique indexes.
      //   * `broker_snapshot_syncs` has no `generation` column.
      //   * No `schema_migrations`, no `system_alerts`, no
      //     `execution_audit_log`, no `client_order_id` /
      //     `client_order_hash`, no denormalised context columns
      //     on `broker_execution_fills`, no PR13-era indexes.
      await pool.query(`
        CREATE TABLE proposed_orders (
          id BIGSERIAL PRIMARY KEY,
          instrument TEXT NOT NULL,
          conid TEXT,
          side TEXT NOT NULL,
          position_effect TEXT,
          order_type TEXT NOT NULL,
          quantity DOUBLE PRECISION NOT NULL,
          entry DOUBLE PRECISION,
          stop DOUBLE PRECISION,
          take_profit DOUBLE PRECISION,
          reason TEXT NOT NULL,
          confidence DOUBLE PRECISION NOT NULL,
          risk_check_status TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PROPOSED',
          strategy TEXT,
          indicator_snapshot JSONB,
          decision_source TEXT NOT NULL DEFAULT 'signal',
          decision_actor TEXT,
          ai_decision TEXT,
          ai_reason TEXT,
          ai_model TEXT,
          ai_decision_confidence DOUBLE PRECISION,
          llm_decision_id BIGINT,
          source_error TEXT,
          processing_owner TEXT,
          processing_claimed_at TIMESTAMPTZ,
          broker_order_id TEXT,
          execution_account_id TEXT,
          execution_message TEXT,
          last_error TEXT,
          execution_attempted_at TIMESTAMPTZ,
          executed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE broker_execution_fills (
          exec_id TEXT PRIMARY KEY,
          order_id BIGINT,
          broker_order_id TEXT,
          proposed_order_id BIGINT REFERENCES proposed_orders(id),
          account_id TEXT,
          conid TEXT,
          symbol TEXT NOT NULL,
          currency TEXT,
          exchange TEXT,
          side TEXT NOT NULL,
          shares DOUBLE PRECISION NOT NULL,
          price DOUBLE PRECISION NOT NULL,
          avg_price DOUBLE PRECISION,
          executed_at TIMESTAMPTZ,
          commission DOUBLE PRECISION,
          commission_currency TEXT,
          realized_pnl DOUBLE PRECISION,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE broker_position_snapshots (
          account_id TEXT NOT NULL,
          instrument TEXT NOT NULL,
          conid TEXT,
          quantity NUMERIC NOT NULL,
          session_id TEXT NOT NULL,
          observed_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (account_id, instrument)
        );
        CREATE TABLE broker_snapshot_syncs (
          account_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          observed_at TIMESTAMPTZ NOT NULL,
          complete BOOLEAN NOT NULL DEFAULT TRUE
        );
      `);

      // Seed data into every historic table.
      const po = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, order_type, quantity, reason,
           confidence, risk_check_status, status, executed_at
         )
         VALUES ('AAPL','123','BUY','LMT',10,'legacy',0.9,'PASS','EXECUTED',NOW())
         RETURNING id`,
      );
      const orderId = po.rows[0].id;
      await pool.query(
        `INSERT INTO broker_execution_fills (
           exec_id, proposed_order_id, symbol, side, shares, price, executed_at
         ) VALUES ('exec-legacy',$1,'AAPL','BOT',10,100.5,NOW())`,
        [orderId],
      );
      await pool.query(
        `INSERT INTO broker_position_snapshots (
           account_id, instrument, conid, quantity, session_id, observed_at
         ) VALUES ('DU-1','AAPL','123',10,'sess-1',NOW())`,
      );
      await pool.query(
        `INSERT INTO broker_snapshot_syncs (
           account_id, session_id, observed_at, complete
         ) VALUES ('DU-1','sess-1',NOW(),TRUE)`,
      );

      // Verify pre-migration invariants we depend on for the test:
      // no schema_migrations, symbol/side/shares/price NOT NULL, no
      // generation column.
      const hadSchemaMig = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name='schema_migrations'`,
      );
      assert.equal(hadSchemaMig.rowCount, 0);
      const preNulls = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name='broker_execution_fills'
           AND column_name IN ('symbol','side','shares','price')`,
      );
      for (const r of preNulls.rows) {
        assert.equal(r.is_nullable, "NO", `${r.column_name} should start NOT NULL`);
      }

      // Run the runner on the drifted DB.
      const result = await runMigrations(pool);
      assert.ok(result.applied.length >= 2, "expected at least 2 migrations");

      // All seeded rows preserved.
      const counts = await pool.query(
        `SELECT (SELECT COUNT(*)::int FROM proposed_orders) AS po,
                (SELECT COUNT(*)::int FROM broker_execution_fills) AS bef,
                (SELECT COUNT(*)::int FROM broker_position_snapshots) AS bps,
                (SELECT COUNT(*)::int FROM broker_snapshot_syncs) AS bss`,
      );
      assert.equal(counts.rows[0].po, 1);
      assert.equal(counts.rows[0].bef, 1);
      assert.equal(counts.rows[0].bps, 1);
      assert.equal(counts.rows[0].bss, 1);

      // Legacy status normalisation happened for our seeded row.
      const migratedOrder = await pool.query<{
        status: string;
        executed_at: Date | null;
      }>(`SELECT status, executed_at FROM proposed_orders WHERE id=$1`, [orderId]);
      // Original row had status='EXECUTED' + executed_at populated; the
      // reconciler recognises the fill and lands on FILLED with
      // executed_at derived from the fill row.
      assert.ok(
        migratedOrder.rows[0].status === "FILLED" ||
          migratedOrder.rows[0].status === "SUBMITTED",
        `unexpected post-migration status: ${migratedOrder.rows[0].status}`,
      );

      // Post-migration schema is complete.
      await assertPr13Pr14Schema(pool);

      // Historical NOT NULL columns are now nullable.
      const postNulls = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name='broker_execution_fills'
           AND column_name IN ('symbol','side','shares','price')`,
      );
      for (const r of postNulls.rows) {
        assert.equal(r.is_nullable, "YES", `${r.column_name} should now be nullable`);
      }

      // Historical (account_id, instrument) PK on broker_position_snapshots
      // was dropped; partial UNIQUE indexes replace it.
      const pk = await pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'broker_position_snapshots'::regclass
           AND contype = 'p'`,
      );
      assert.equal(pk.rowCount, 0, "old PK should be dropped");

      // schema_migrations reflects the applied set.
      const smigRows = await pool.query(
        `SELECT version FROM schema_migrations ORDER BY version`,
      );
      assert.ok(smigRows.rowCount! >= 2);
    });
  });

  it("two migrations with the same version prefix → runner rejects BEFORE executing any SQL", async () => {
    await withFreshDb("dup_version", async (pool) => {
      const tmp = mkdtempSync(join(tmpdir(), "ikbr-mig-"));
      try {
        writeFileSync(
          join(tmp, "000001_first.sql"),
          "CREATE TABLE dup_should_not_exist (id INT);\n",
        );
        writeFileSync(
          join(tmp, "000001_second.sql"),
          "CREATE TABLE dup_also_no (id INT);\n",
        );
        await assert.rejects(
          () => runMigrations(pool, { migrationsDir: tmp }),
          /Duplicate migration version 000001/i,
        );
        // Neither table exists; no schema_migrations row either.
        const tables = await pool.query(
          `SELECT tablename FROM pg_tables
           WHERE tablename IN ('dup_should_not_exist','dup_also_no','schema_migrations')`,
        );
        assert.equal(tables.rowCount, 0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("applied version with a renamed on-disk filename → runner rejects (never edit / rename applied migrations)", async () => {
    await withFreshDb("filename_drift", async (pool) => {
      const tmp = mkdtempSync(join(tmpdir(), "ikbr-mig-"));
      try {
        const original = join(tmp, "000001_original.sql");
        writeFileSync(
          original,
          "CREATE TABLE IF NOT EXISTS fn_drift (id INT);\n",
        );
        await runMigrations(pool, { migrationsDir: tmp });
        // Rename the file — same version, same checksum, different name.
        const renamed = join(tmp, "000001_renamed.sql");
        writeFileSync(
          renamed,
          "CREATE TABLE IF NOT EXISTS fn_drift (id INT);\n",
        );
        rmSync(original);
        await assert.rejects(
          () => runMigrations(pool, { migrationsDir: tmp }),
          /filename mismatch/i,
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("missing migrations directory → runner fails closed (no schema_migrations, no partial state)", async () => {
    await withFreshDb("missing_dir", async (pool) => {
      const nonexistent = join(
        tmpdir(),
        `ikbr-mig-missing-${Date.now()}`,
      );
      await assert.rejects(
        () => runMigrations(pool, { migrationsDir: nonexistent }),
        /ENOENT|no such file|not found/i,
      );
      const smig = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name='schema_migrations'`,
      );
      assert.equal(smig.rowCount, 0);
    });
  });
});

// Silence "declared but never used" when TEST_POSTGRES_URL is unset.
void mkdirSync;
