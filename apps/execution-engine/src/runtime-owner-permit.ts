import type { Pool } from 'pg';
import { assertPostgresClientUsable } from '@ikbr/shared/diagnostics';
import type { RuntimeOwnerGuard } from './tws-execution-client.js';

export async function withRuntimeOwnerPermit(pool: Pick<Pool, 'connect'>, owner: RuntimeOwnerGuard, send: () => void): Promise<void> {
  owner.assertCurrent();
  const db = await pool.connect();
  let failed = false;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2000ms'");
    await owner.assertInTransaction(db);
    owner.assertCurrent();
    assertPostgresClientUsable(db);
    send();
    await db.query('COMMIT');
  } catch (error) {
    failed = true;
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { db.release(failed); }
}
