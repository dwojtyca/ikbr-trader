import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { accountingError, type SourceSettingsV1 } from "./types.js";

export interface SourceOwnerFence { endpointKey: string; ownerId: string; generation: number }
async function resolveAccountingEndpoint(endpoint: SourceSettingsV1["endpoint"]): Promise<{ key: string; endpoint: SourceSettingsV1["endpoint"] }> {
  const host = endpoint.host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw accountingError("IDENTITY_INVALID");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(value => value.address);
  const canonical = [...new Set(addresses.map(address => address === "::1" || /^127\./.test(address) || address === "::ffff:127.0.0.1" ? "loopback" : address.replace(/^::ffff:/, "")))].sort();
  // Pin one resolved transport: ambiguous DNS sets cannot prove a single client-zero owner.
  if (canonical.length !== 1) throw accountingError("IDENTITY_INVALID");
  return { key: JSON.stringify({ address: canonical[0], port: endpoint.port, clientId: 0 }), endpoint: { host: addresses[0], port: endpoint.port } };
}
export async function canonicalAccountingEndpoint(endpoint: SourceSettingsV1["endpoint"]): Promise<string> {
  return (await resolveAccountingEndpoint(endpoint)).key;
}

/** A session lock authorizes ownership; the durable row prevents crash/lease takeover. */
export class AccountingSourceOwner {
  private client: PoolClient | undefined;
  private current: SourceOwnerFence | undefined;
  private state: "NEW" | "ACTIVE" | "RETIRED" | "LOST" | "RELEASED" = "NEW";
  private lockKey = "";
  private resolvedEndpoint: SourceSettingsV1["endpoint"] | undefined;
  private lastProof = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private acquiring = false;
  constructor(private readonly pool: Pool, private readonly settings: SourceSettingsV1, private readonly onLost: () => void = () => {}) {}
  private lose = (): void => {
    if (this.state === "LOST" || this.state === "RELEASED" || this.state === "NEW") return;
    this.state = "LOST"; clearInterval(this.timer); this.onLost();
  };
  endpoint(): SourceSettingsV1["endpoint"] { this.assertCurrent(); return { ...this.resolvedEndpoint! }; }
  fence(): SourceOwnerFence { this.assertCurrent(); return { ...this.current! }; }
  assertHeld(): void {
    if ((this.state === "ACTIVE" || this.state === "RETIRED") && performance.now() - this.lastProof > 2000) this.lose();
    if (!['ACTIVE', 'RETIRED'].includes(this.state) || !this.client || !this.current) throw accountingError("SOURCE_OWNER_LOST");
  }
  assertCurrent(): void {
    this.assertHeld();
    if (this.state !== "ACTIVE") throw accountingError("SOURCE_OWNER_LOST");
  }
  async acquire(): Promise<void> {
    if (this.state === "ACTIVE") { await this.verifyCurrent(); return; }
    if (this.state !== "NEW" || this.acquiring) throw accountingError("SOURCE_OWNER_LOST");
    this.acquiring = true;
    let client: PoolClient | undefined;
    try {
      const resolved = await resolveAccountingEndpoint(this.settings.endpoint);
      const endpointKey = resolved.key; this.resolvedEndpoint = resolved.endpoint;
      this.lockKey = BigInt.asIntN(64, BigInt(`0x${createHash("sha256").update(endpointKey).digest("hex").slice(0, 16)}`)).toString();
      client = await this.pool.connect(); this.client = client;
      client.on("error", this.lose); client.on("end", this.lose);
      await client.query("SET statement_timeout = '2000ms'");
      await client.query("SET lock_timeout = '2000ms'");
      const lock = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [this.lockKey]);
      if (lock.rows[0]?.locked !== true) throw accountingError("SOURCE_OWNER_CONFLICT");
      const ownerId = randomUUID();
      const claimed = await client.query(`INSERT INTO accounting_source_owners(endpoint_key,owner_id,generation,retirement_state)
        VALUES($1,$2,1,'ACTIVE') ON CONFLICT(endpoint_key) DO UPDATE SET owner_id=EXCLUDED.owner_id,
        generation=accounting_source_owners.generation+1,retirement_state='ACTIVE',acquired_at=clock_timestamp(),retired_at=NULL,updated_at=clock_timestamp()
        WHERE accounting_source_owners.retirement_state='RETIRED' RETURNING generation`, [endpointKey, ownerId]);
      if (claimed.rowCount !== 1) throw accountingError("SOURCE_OWNER_UNRETIRED");
      const generation = Number(claimed.rows[0].generation);
      if (!Number.isSafeInteger(generation)) throw accountingError("SOURCE_OWNER_LOST");
      this.current = { endpointKey, ownerId, generation }; this.state = "ACTIVE"; this.lastProof = performance.now();
      this.timer = setInterval(() => {
        if (this.checking || !["ACTIVE", "RETIRED"].includes(this.state)) return;
        this.checking = true;
        void this.verifyHeld().catch(() => this.lose()).finally(() => { this.checking = false; });
      }, 500); this.timer.unref();
    } catch (error) {
      this.state = "LOST"; this.client = undefined;
      // Destroy the dedicated session: no advisory lock may escape back into the pool.
      client?.release(true); throw error;
    } finally { this.acquiring = false; }
  }
  private async verifyLock(): Promise<void> {
    if (!this.client) throw accountingError("SOURCE_OWNER_LOST");
    const key = BigInt.asUintN(64, BigInt(this.lockKey));
    const query = { text: `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
      AND pid=pg_backend_pid() AND granted AND classid=$1::oid AND objid=$2::oid AND objsubid=1) AS held`,
    values: [(key >> 32n).toString(), (key & 0xffffffffn).toString()], query_timeout: 2000 };
    const proof = await this.client.query(query);
    if (proof.rows[0]?.held !== true) throw accountingError("SOURCE_OWNER_LOST");
  }
  async verifyCurrent(): Promise<void> {
    this.assertCurrent(); await this.verifyHeld(); this.assertCurrent();
  }
  private async verifyHeld(): Promise<void> {
    this.assertHeld();
    try {
      await this.verifyLock();
      const fence = this.current!;
      const query = { text: `SELECT 1 FROM accounting_source_owners WHERE endpoint_key=$1 AND owner_id=$2
        AND generation=$3 AND retirement_state IN ('ACTIVE','RETIRED')`, values: [fence.endpointKey, fence.ownerId, fence.generation], query_timeout: 2000 };
      const row = await this.client!.query(query);
      this.assertHeld();
      if (row.rowCount !== 1) throw accountingError("SOURCE_OWNER_LOST");
      this.lastProof = performance.now();
    } catch (error) { this.lose(); throw error; }
  }
  async assertInTransaction(db: Pick<PoolClient, "query">): Promise<void> {
    this.assertHeld(); const fence = this.current!;
    const row = await db.query(`SELECT 1 FROM accounting_source_owners WHERE endpoint_key=$1 AND owner_id=$2
      AND generation=$3 AND retirement_state IN ('ACTIVE','RETIRED') FOR SHARE`, [fence.endpointKey, fence.ownerId, fence.generation]);
    this.assertHeld(); if (row.rowCount !== 1) { this.lose(); throw accountingError("SOURCE_OWNER_LOST"); }
  }
  async retire(acknowledged: boolean): Promise<void> {
    if (!this.current || this.state === "RELEASED") throw accountingError("SOURCE_OWNER_LOST");
    const fence = this.current;
    if (this.state !== "LOST") this.state = "RETIRED";
    const query = { text: `UPDATE accounting_source_owners SET retirement_state=$4,
      retired_at=CASE WHEN $4='RETIRED' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
      WHERE endpoint_key=$1 AND owner_id=$2 AND generation=$3`,
    values: [fence.endpointKey, fence.ownerId, fence.generation, acknowledged ? "RETIRED" : "UNKNOWN"], query_timeout: 2000 };
    let row;
    try { row = await this.pool.query(query); } catch (error) { this.lose(); throw error; }
    if (row.rowCount !== 1) { this.lose(); throw accountingError("SOURCE_OWNER_LOST"); }
    if (!acknowledged) { this.lose(); throw accountingError("SOURCE_RETIREMENT_UNKNOWN"); }
    if (this.state !== "LOST") this.state = "RETIRED";
  }
  async activate(): Promise<void> {
    if (this.state !== "RETIRED" || !this.current) throw accountingError("SOURCE_OWNER_LOST");
    try {
      await this.verifyLock(); const fence = this.current;
      const row = await this.client!.query(`UPDATE accounting_source_owners SET retirement_state='ACTIVE',retired_at=NULL,updated_at=clock_timestamp()
        WHERE endpoint_key=$1 AND owner_id=$2 AND generation=$3 AND retirement_state='RETIRED'`, [fence.endpointKey, fence.ownerId, fence.generation]);
      if (this.state !== "RETIRED" || row.rowCount !== 1) throw accountingError("SOURCE_OWNER_LOST");
      this.lastProof = performance.now(); this.state = "ACTIVE";
    } catch (error) { this.lose(); throw error; }
  }
  async release(): Promise<void> {
    clearInterval(this.timer);
    if (this.state === "ACTIVE") this.lose();
    this.state = "RELEASED";
    const client = this.client; this.client = undefined;
    // Session destruction also drops the lock when explicit unlock has an unknown outcome.
    client?.release(true);
  }
}
