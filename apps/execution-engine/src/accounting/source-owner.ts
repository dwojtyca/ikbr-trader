import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { accountingError, type SourceSettingsV1 } from "./types.js";

export interface SourceOwnerFence { endpointKey: string; ownerId: string; generation: number }
export async function resolveAccountingEndpoint(endpoint: SourceSettingsV1["endpoint"]): Promise<{ key: string; endpoint: SourceSettingsV1["endpoint"] }> {
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

export function accountingOwnerLockKey(endpointKey: string): string {
  return BigInt.asIntN(64, BigInt(`0x${createHash("sha256").update(endpointKey).digest("hex").slice(0, 16)}`)).toString();
}

/** A session lock authorizes ownership; the durable row prevents crash/lease takeover. */
export class AccountingSourceOwner {
  private client: PoolClient | undefined;
  private current: SourceOwnerFence | undefined;
  private state: "NEW" | "ACTIVE" | "RETIRED" | "LOST" | "RELEASING" | "RELEASED" = "NEW";
  private lockKey = "";
  private resolvedEndpoint: SourceSettingsV1["endpoint"] | undefined;
  private lastProof = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private acquiring = false;
  private releasing: Promise<void> | undefined;
  private readonly destroyedClients = new WeakSet<PoolClient>();
  constructor(private readonly pool: Pool, private readonly settings: SourceSettingsV1, private readonly onLost: () => void = () => {}) {}
  private lose = (): void => {
    if (this.state === "LOST" || this.state === "RELEASED" || this.state === "RELEASING" || this.state === "NEW") return;
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
  private assertAcquiring(): void {
    if(this.state!=="NEW" || !this.acquiring)throw accountingError("SOURCE_OWNER_LOST");
  }
  private destroyClient(client: PoolClient | undefined): void {
    if(!client || this.destroyedClients.has(client))return;
    this.destroyedClients.add(client);client.release(true);
  }
  async acquire(): Promise<void> {
    if (this.state === "ACTIVE") { await this.verifyCurrent(); return; }
    if (this.state !== "NEW" || this.acquiring) throw accountingError("SOURCE_OWNER_LOST");
    this.acquiring = true;
    let client: PoolClient | undefined;
    try {
      const resolved = await resolveAccountingEndpoint(this.settings.endpoint); this.assertAcquiring();
      const endpointKey = resolved.key; this.resolvedEndpoint = resolved.endpoint;
      this.lockKey = accountingOwnerLockKey(endpointKey);
      client = await this.pool.connect(); this.assertAcquiring(); this.client = client;
      client.on("error", this.lose); client.on("end", this.lose);
      await client.query("SET statement_timeout = '2000ms'"); this.assertAcquiring();
      await client.query("SET lock_timeout = '2000ms'"); this.assertAcquiring();
      const lock = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [this.lockKey]);
      this.assertAcquiring();
      if (lock.rows[0]?.locked !== true) throw accountingError("SOURCE_OWNER_CONFLICT");
      await client.query("BEGIN"); this.assertAcquiring();
      const maintenance = await client.query("SELECT pending_operation_id FROM accounting_owner_recovery_maintenance WHERE singleton FOR SHARE");
      this.assertAcquiring();
      if (maintenance.rowCount !== 1 || maintenance.rows[0].pending_operation_id !== null) throw accountingError("SOURCE_OWNER_MAINTENANCE_PENDING");
      const ownerId = randomUUID();
      const claimed = await client.query(`INSERT INTO accounting_source_owners(endpoint_key,owner_id,generation,retirement_state)
        VALUES($1,$2,1,'ACTIVE') ON CONFLICT(endpoint_key) DO UPDATE SET owner_id=EXCLUDED.owner_id,
        generation=accounting_source_owners.generation+1,retirement_state='ACTIVE',acquired_at=clock_timestamp(),retired_at=NULL,updated_at=clock_timestamp()
        WHERE accounting_source_owners.retirement_state='RETIRED' RETURNING generation`, [endpointKey, ownerId]);
      this.assertAcquiring();
      if (claimed.rowCount !== 1) throw accountingError("SOURCE_OWNER_UNRETIRED");
      const generation = Number(claimed.rows[0].generation);
      if (!Number.isSafeInteger(generation)) throw accountingError("SOURCE_OWNER_LOST");
      await client.query("COMMIT"); this.assertAcquiring();
      this.current = { endpointKey, ownerId, generation }; this.state = "ACTIVE"; this.lastProof = performance.now();
      this.timer = setInterval(() => {
        if (this.checking || !["ACTIVE", "RETIRED"].includes(this.state)) return;
        this.checking = true;
        void this.verifyHeld().catch(() => this.lose()).finally(() => { this.checking = false; });
      }, 500); this.timer.unref();
    } catch (error) {
      if(!this.releasing)this.state = "LOST";
      if(this.client===client)this.client = undefined;
      // Destroy the dedicated session: no advisory lock may escape back into the pool.
      this.destroyClient(client); throw error;
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
      await this.verifyLock(); this.assertHeld();
      const fence = this.current!;
      const query = { text: `SELECT 1 FROM accounting_source_owners WHERE endpoint_key=$1 AND owner_id=$2
        AND generation=$3 AND retirement_state IN ('ACTIVE','RETIRED')
        AND EXISTS(SELECT 1 FROM accounting_owner_recovery_maintenance WHERE singleton AND pending_operation_id IS NULL)`, values: [fence.endpointKey, fence.ownerId, fence.generation], query_timeout: 2000 };
      const row = await this.client!.query(query);
      this.assertHeld();
      if (row.rowCount !== 1) throw accountingError("SOURCE_OWNER_LOST");
      this.lastProof = performance.now();
    } catch (error) { this.lose(); throw error; }
  }
  async assertInTransaction(db: Pick<PoolClient, "query">): Promise<void> {
    this.assertHeld(); const fence = this.current!;
    const row = await db.query(`SELECT 1 FROM accounting_source_owners WHERE endpoint_key=$1 AND owner_id=$2
      AND generation=$3 AND retirement_state IN ('ACTIVE','RETIRED')
      AND EXISTS(SELECT 1 FROM accounting_owner_recovery_maintenance WHERE singleton AND pending_operation_id IS NULL) FOR SHARE`, [fence.endpointKey, fence.ownerId, fence.generation]);
    this.assertHeld(); if (row.rowCount !== 1) { this.lose(); throw accountingError("SOURCE_OWNER_LOST"); }
  }
  async retire(acknowledged: boolean): Promise<void> {
    if (!this.current || this.state === "RELEASED" || this.state === "RELEASING") throw accountingError("SOURCE_OWNER_LOST");
    const fence = this.current;
    if (this.state !== "LOST") this.state = "RETIRED";
    const query = { text: `UPDATE accounting_source_owners SET retirement_state=$4,
      retired_at=CASE WHEN $4='RETIRED' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
      WHERE endpoint_key=$1 AND owner_id=$2 AND generation=$3`,
    values: [fence.endpointKey, fence.ownerId, fence.generation, acknowledged ? "RETIRED" : "UNKNOWN"], query_timeout: 2000 };
    let row;
    try { row = await this.pool.query(query); } catch (error) { this.lose(); throw error; }
    if (this.releasing || row.rowCount !== 1) { this.lose(); throw accountingError("SOURCE_OWNER_LOST"); }
    if (!acknowledged) { this.lose(); throw accountingError("SOURCE_RETIREMENT_UNKNOWN"); }
    if (this.state !== "LOST") this.state = "RETIRED";
  }
  async activate(): Promise<void> {
    if (this.state !== "RETIRED" || !this.current) throw accountingError("SOURCE_OWNER_LOST");
    try {
      await this.verifyLock(); this.assertHeld();
      if(this.state!=="RETIRED")throw accountingError("SOURCE_OWNER_LOST");
      const fence = this.current;
      const row = await this.client!.query(`UPDATE accounting_source_owners SET retirement_state='ACTIVE',retired_at=NULL,updated_at=clock_timestamp()
        WHERE endpoint_key=$1 AND owner_id=$2 AND generation=$3 AND retirement_state='RETIRED'`, [fence.endpointKey, fence.ownerId, fence.generation]);
      if (this.state !== "RETIRED" || row.rowCount !== 1) throw accountingError("SOURCE_OWNER_LOST");
      this.lastProof = performance.now(); this.state = "ACTIVE";
    } catch (error) { this.lose(); throw error; }
  }
  release(): Promise<void> {
    if(this.releasing)return this.releasing;
    const client=this.client,fence=this.current,retired=this.state==="RETIRED",deadline=performance.now()+2000;
    clearInterval(this.timer);
    this.releasing=Promise.resolve().then(async()=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        if(!retired || !client || !fence)return;
        const remaining=()=>{const ms=Math.floor(deadline-performance.now());if(ms<=0)throw accountingError("SOURCE_OWNER_RELEASE_TIMEOUT");return ms;};
        const proof=async()=>{
          const unlockQuery={text:`SELECT pg_advisory_unlock($1::bigint) AS unlocked
            WHERE EXISTS(SELECT 1 FROM accounting_source_owners WHERE endpoint_key=$2 AND owner_id=$3 AND generation=$4 AND retirement_state='RETIRED')`,
          values:[this.lockKey,fence.endpointKey,fence.ownerId,fence.generation],query_timeout:remaining()};
          const unlocked=await client.query(unlockQuery);
          remaining();
          if(unlocked.rowCount!==1 || unlocked.rows[0]?.unlocked!==true)throw accountingError("SOURCE_OWNER_RELEASE_UNCONFIRMED");
          const key=BigInt.asUintN(64,BigInt(this.lockKey));
          const absenceQuery={text:`SELECT NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
            AND pid=pg_backend_pid() AND granted AND classid=$1::oid AND objid=$2::oid AND objsubid=1) AS absent`,
          values:[(key>>32n).toString(),(key&0xffffffffn).toString()],query_timeout:remaining()};
          const absent=await client.query(absenceQuery);
          remaining();
          if(absent.rowCount!==1 || absent.rows[0]?.absent!==true)throw accountingError("SOURCE_OWNER_RELEASE_UNCONFIRMED");
        };
        await Promise.race([proof(),new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(accountingError("SOURCE_OWNER_RELEASE_TIMEOUT")),Math.max(0,deadline-performance.now()));
        })]);
      } catch(error) {throw new Error("ACCOUNTING_SOURCE_OWNER_RELEASE_UNKNOWN",{cause:error});}
      finally {clearTimeout(timer);this.state="RELEASED";this.destroyClient(client);}
    });
    if(this.state==="ACTIVE")this.lose();
    this.state="RELEASING";this.client=undefined;
    return this.releasing;
  }
}
