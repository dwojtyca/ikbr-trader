/**
 * Market Data Runtime — readiness probe.
 *
 * PR12 readiness reflects ONLY the dependencies the dry-run path
 * actually needs:
 *
 *   - Instrument Registry is instantiated (checked at construction).
 *   - Redis read is available (needed for the price provider —
 *     ingestion publishes market state to `market-state:<conid>`).
 *   - Postgres read is available (needed by the contract resolver
 *     to translate `Instrument.brokerSymbol` → conid via the
 *     `instrument_contracts` table ingestion populates at
 *     bootstrap).
 *
 * PR12 does NOT require a broker / IBKR / execution-engine
 * connection — dry-run performs no submission. Consequently a
 * broker outage MUST NOT flip this endpoint red.
 */

export interface RuntimeReadinessDeps {
  /** Redis client with a `ping()` method (ioredis-compatible). */
  readonly redis: { ping: () => Promise<unknown> };
  /**
   * Postgres pool with a `query(text)` method (pg-compatible).
   * The runtime uses a trivial `SELECT 1` — no schema assumptions.
   */
  readonly postgres: { query: (text: string) => Promise<unknown> };
}

export interface RuntimeReadinessResult {
  readonly ready: boolean;
  readonly checks: {
    readonly redis: { ok: boolean; error?: string };
    readonly postgres: { ok: boolean; error?: string };
  };
}

export async function checkRuntimeReadiness(
  deps: RuntimeReadinessDeps,
): Promise<RuntimeReadinessResult> {
  const [redis, postgres] = await Promise.all([
    probe(() => deps.redis.ping()),
    probe(() => deps.postgres.query("SELECT 1")),
  ]);
  return {
    ready: redis.ok && postgres.ok,
    checks: { redis, postgres },
  };
}

async function probe(
  fn: () => Promise<unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
