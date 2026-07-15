# Database Migrations

PR14.2 introduces versioned SQL migrations for the schema
previously created dynamically in `ExecutionRepository.init()`.
The runner lives in
[apps/execution-engine/src/migrations.ts](../../apps/execution-engine/src/migrations.ts);
migration files live in
[infra/sql/migrations/](../../infra/sql/migrations/).

## How it works

- Every migration file is named `NNNNNN_<slug>.sql` (six-digit
  zero-padded version, lowercase slug). Versions are strictly
  ascending.
- Each file is executed in its own transaction.
- A session-scoped Postgres advisory lock
  (`pg_advisory_lock(0x69_6B_62_72_31_34_32)`) serialises
  concurrent runners so two execution-engine processes starting
  simultaneously cannot double-apply.
- The `schema_migrations` table tracks `version`, `filename`,
  `checksum` (SHA-256 of file bytes), `applied_at`.
- On startup the runner:
  1. ensures `schema_migrations` exists;
  2. reads the persisted set of applied versions;
  3. for each on-disk file in ascending order:
     - if applied AND checksum matches → skip;
     - if applied AND checksum differs → **abort startup** with a
       clear error (never edit a released migration; add a new
       one instead);
     - if not applied → apply inside a fresh transaction, then
       insert the `schema_migrations` row in the SAME
       transaction. A failure ROLLBACK's — no partial state is
       recorded.

The runner is idempotent: rerunning against an already-migrated
database is a no-op (all files match by checksum).

## Adding a new migration

1. Pick the next unused six-digit version (currently the next
   file would be `000003_*`).
2. Write ONLY forward-compatible DDL. Every statement must be
   safe to run against a database where the target objects
   already exist:
   - `CREATE TABLE IF NOT EXISTS ...`
   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
   - `CREATE INDEX IF NOT EXISTS ...`
   - `DROP CONSTRAINT IF EXISTS ...`
   - `ALTER COLUMN ... DROP NOT NULL` is already a no-op when the
     column is nullable, so it is safe to write bare. **DO NOT**
     wrap it (or any other DDL) in `DO $$ ... EXCEPTION WHEN
     others THEN NULL END $$` — that pattern swallows permission
     errors, missing-column drift, and other real failures. Every
     expected variant of the source schema must be handled
     explicitly (e.g. check `information_schema.columns` before
     issuing a targeted `UPDATE`, or add a preceding `ALTER TABLE
     ADD COLUMN IF NOT EXISTS`). Migrations must be fail-closed:
     any unexpected error aborts startup so a human can inspect
     the drift.
3. Data migrations (`UPDATE ... WHERE ...`) must be
   **convergent** — a follow-up run finds nothing to update.
4. NEVER edit a migration file after it has landed on `main`.
   The checksum comparison will block startup for every operator
   who has already applied it. If a schema change turned out
   wrong, add a new migration that fixes it.

## Startup flow

`ExecutionRepository.init()` is now a thin wrapper that only
calls `runMigrations(pool)`. The execution-engine `main()`
function calls `repo.init()` BEFORE:

- registering the auth / audit / env-guard hooks
- listening on the HTTP port
- attempting broker reconnection / reconciliation

A migration failure throws out of `main()`, is logged as
`"database migrations failed — refusing to start"`, and the
process exits non-zero. The scheduler, TWS reconnect logic, and
the trading loop never come online against a partial or
inconsistent schema.

## Path resolution

The runner picks its migrations directory from the first of
these that exists:

1. `EXECUTION_MIGRATIONS_DIR` (explicit override — CI, tests,
   containerised deployments with a non-default layout).
2. Walking up from the compiled or source location of
   `migrations.ts` toward `infra/sql/migrations`. Works for
   both `tsx src/index.ts` (dev) and `node dist/index.js`
   (Docker).
3. `<cwd>/infra/sql/migrations` (fallback for Docker
   `WORKDIR /app`).

If none exist, startup fails with a clear error listing every
attempted path.

## Recovery from a failed migration

1. Read the error emitted by the failing runner (SQLSTATE,
   original SQL fragment).
2. Inspect the database — the failing migration was rolled
   back. Preceding migrations remain applied and are recorded
   in `schema_migrations`.
3. Fix the SQL in the migration file (BEFORE it lands on
   `main` and reaches anyone else's database).
4. Re-run — the fixed migration applies from scratch.

If a migration has ALREADY been applied to a downstream
database and later found to be wrong, you MUST add a new
migration (e.g. `000004_undo_bad_000003.sql`) rather than
editing the offending file. The checksum guard blocks any
attempt to rewrite history.

## Interaction with `docker-entrypoint-initdb.d`

`docker-compose.yml` mounts `./infra/sql` into
`/docker-entrypoint-initdb.d`, which causes Postgres to run
`001_init.sql` (and all top-level `.sql` files) on FIRST BOOT
of the container. The migration runner then applies its
migrations on top; because every DDL is idempotent
(`IF NOT EXISTS`, etc.), no conflict arises. `001_init.sql` is
retained for compatibility with older bootstrapping paths and
MUST NOT be edited.

## Running the PostgreSQL integration test

```bash
# Local: install Postgres via Homebrew (or use the compose service)
brew install postgresql@15
brew services start postgresql@15

TEST_POSTGRES_URL=postgresql://postgres@localhost:5432/postgres \
  pnpm test:integration
```

The migration runner tests live at
[apps/execution-engine/src/migrations.pg-integration.test.ts](../../apps/execution-engine/src/migrations.pg-integration.test.ts).
They create and drop hermetic per-test databases so runs can be
repeated without cleanup.

## Excluded from PR14.2

- Reconciliation loop (PR15).
- Instrument activation / `executionPolicy` rollout.
- Live-trading readiness.
- Automatic schema drift detection between the runner's applied
  state and the running application's ORM view (there is no
  ORM; PR14 uses raw SQL throughout).
