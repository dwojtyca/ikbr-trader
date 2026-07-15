/**
 * PR14.2 — versioned database migration runner.
 *
 * Contract:
 *   - Migrations live in `infra/sql/migrations/NNNNNN_<slug>.sql`, sorted
 *     numerically by the leading version prefix.
 *   - Each migration runs in its own transaction; a partial failure
 *     rolls back and is NOT recorded in `schema_migrations`.
 *   - A Postgres session advisory lock serialises concurrent runners
 *     across processes (e.g. two execution-engine instances starting
 *     simultaneously).
 *   - An already-applied migration whose checksum differs from the
 *     on-disk file blocks startup with a clear error — never edit a
 *     released migration; add a new one.
 *   - The runner tolerates every combination of "fresh DB", "DB where
 *     only `001_init.sql` ran" (via `docker-entrypoint-initdb.d`) and
 *     "DB that was previously initialised by `repo.init()`", because
 *     every DDL statement inside the migrations is idempotent
 *     (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT
 *     IF EXISTS`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

/** Session-scoped advisory-lock key. Arbitrary but stable. */
const MIGRATION_LOCK_KEY = 0x69_6B_62_72_31_34_32n; // "ikbr142" in hex

const MIGRATION_FILENAME_RE = /^(\d{6,})_[a-z0-9][a-z0-9_-]*\.sql$/i;

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly migrationsDir: string;
}

/**
 * Resolve the migrations directory. Order:
 *   1. Explicit override via `EXECUTION_MIGRATIONS_DIR`.
 *   2. Walk up from this module's own directory to the repo root and
 *      look for `infra/sql/migrations`. Works for both source
 *      (`tsx src/index.ts`) and compiled (`node dist/index.js`) runs
 *      because both start under `apps/execution-engine/{src,dist}/`.
 *   3. `<cwd>/infra/sql/migrations` (dev shell run from repo root or
 *      Docker `WORKDIR /app`).
 *
 * The first candidate that exists AND is a directory wins. Throws a
 * clear error if none exist so startup fails loudly rather than
 * silently skipping migrations.
 */
export function resolveMigrationsDir(): string {
  const candidates: string[] = [];
  const override = process.env.EXECUTION_MIGRATIONS_DIR?.trim();
  if (override) candidates.push(resolve(override));

  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up looking for `infra/sql/migrations` — this catches both
  // apps/execution-engine/src/... and apps/execution-engine/dist/...
  let cursor: string | undefined = here;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    candidates.push(resolve(cursor, "infra", "sql", "migrations"));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  candidates.push(resolve(process.cwd(), "infra", "sql", "migrations"));

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  throw new Error(
    `Migrations directory not found. Tried: ${candidates.join(", ")}. ` +
      `Set EXECUTION_MIGRATIONS_DIR to override.`,
  );
}

interface DiscoveredMigration {
  readonly version: string;
  readonly filename: string;
  readonly path: string;
  readonly content: string;
  readonly checksum: string;
}

function discoverMigrations(dir: string): readonly DiscoveredMigration[] {
  const files = readdirSync(dir).filter((f) =>
    MIGRATION_FILENAME_RE.test(f),
  );
  files.sort();
  const seenVersions = new Map<string, string>();
  return files.map((filename) => {
    const match = MIGRATION_FILENAME_RE.exec(filename);
    if (!match) throw new Error(`bad migration filename: ${filename}`);
    const version = match[1];
    const prior = seenVersions.get(version);
    if (prior) {
      throw new Error(
        `Duplicate migration version ${version}: ${prior} and ${filename}. ` +
          `Each migration must have a unique numeric prefix.`,
      );
    }
    seenVersions.set(version, filename);
    const path = resolve(dir, filename);
    const content = readFileSync(path, "utf8");
    const checksum = createHash("sha256").update(content).digest("hex");
    return { version, filename, path, content, checksum };
  });
}

async function ensureSchemaMigrationsTable(
  client: PoolClient,
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/**
 * Apply every pending migration. Throws on any failure — the caller
 * MUST NOT proceed to serve HTTP traffic if this rejects.
 */
export async function runMigrations(
  pool: Pool,
  opts?: { readonly migrationsDir?: string; readonly logger?: (msg: string) => void },
): Promise<MigrationResult> {
  const dir = opts?.migrationsDir ?? resolveMigrationsDir();
  const log = opts?.logger ?? (() => undefined);
  const discovered = discoverMigrations(dir);

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // Session-level lock — held for the entire run, released in
    // `finally`. Every concurrent runner blocks on the same key.
    await client.query("SELECT pg_advisory_lock($1)", [
      MIGRATION_LOCK_KEY.toString(),
    ]);
    try {
      await ensureSchemaMigrationsTable(client);
      const existing = await client.query<{
        version: string;
        checksum: string;
        filename: string;
      }>("SELECT version, checksum, filename FROM schema_migrations");
      const alreadyApplied = new Map(
        existing.rows.map((r) => [r.version, r]),
      );
      for (const m of discovered) {
        const prior = alreadyApplied.get(m.version);
        if (prior) {
          if (prior.checksum !== m.checksum) {
            throw new Error(
              `Migration ${m.filename} checksum mismatch. ` +
                `Applied checksum (in schema_migrations) = ${prior.checksum}; ` +
                `on-disk checksum = ${m.checksum}. ` +
                `Never edit an applied migration — add a new file instead.`,
            );
          }
          if (prior.filename !== m.filename) {
            throw new Error(
              `Migration version ${m.version} filename mismatch. ` +
                `Applied filename (in schema_migrations) = ${prior.filename}; ` +
                `on-disk filename = ${m.filename}. ` +
                `Do not rename an applied migration — add a new file instead.`,
            );
          }
          skipped.push(m.filename);
          continue;
        }
        log(`applying migration ${m.filename}`);
        await client.query("BEGIN");
        try {
          await client.query(m.content);
          await client.query(
            `INSERT INTO schema_migrations (version, filename, checksum)
             VALUES ($1, $2, $3)`,
            [m.version, m.filename, m.checksum],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw new Error(
            `Migration ${m.filename} failed and was rolled back: ${
              (err as Error).message
            }`,
          );
        }
        applied.push(m.filename);
      }
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY.toString()])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
  return { applied, skipped, migrationsDir: dir };
}
