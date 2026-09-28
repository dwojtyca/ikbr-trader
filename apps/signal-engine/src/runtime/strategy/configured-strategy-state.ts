import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, buildStrategyEconomicEvidence } from "@ikbr/shared/trading-config";
import type { ConfiguredStrategyState } from "./configured-strategy-runtime.js";

type Row = Record<string, unknown>;
export interface ConfiguredOutcomeReader { read(proposalId: number): Promise<unknown> }
export class HttpConfiguredOutcomeReader implements ConfiguredOutcomeReader {
  constructor(private readonly options: { baseUrl: string; bearerToken: string; timeoutMs: number; fetchImpl?: typeof fetch }) {}
  async read(proposalId: number): Promise<unknown> {
    if (!this.options.bearerToken) throw Error("OUTCOME_AUTH_UNAVAILABLE");
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/execution/lifecycle/${proposalId}/round-trip`, {
      headers:{ Authorization:`Bearer ${this.options.bearerToken}` }, redirect:"error", signal:AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw Error("OUTCOME_UNAVAILABLE");
    return response.json();
  }
}
const object = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const iso = (v: unknown): string => { const ms = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN; if (!Number.isFinite(ms)) throw Error("OUTCOME_TIME_INVALID"); return new Date(ms).toISOString(); };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fingerprint = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");

export interface ConfiguredStrategyStateOptions {
  pool: Pool;
  getInheritanceSourceHash(): Promise<string>;
  outcomeReader: ConfiguredOutcomeReader;
  cooldownMs: number;
}
export class ConfiguredStrategyStateRepository implements ConfiguredStrategyState {
  constructor(private readonly options: ConfiguredStrategyStateOptions) {}
  async sync(input: { accountId: string; conId: string; implementationId: string }) {
    const sourceHash = await this.options.getInheritanceSourceHash();
    const db = await this.options.pool.connect();
    const args = [input.accountId, input.conId, input.implementationId];
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1820018))", [args.join("|")]);
      await db.query(`INSERT INTO strategy_binding_state(account_id,broker,conid,implementation_id,source_hash,enabled,permanently_disabled,cooldown_until,consecutive_loss_count,cooldown_count)
        SELECT $1,'ibkr',$2,implementation_id,source_hash,enabled,permanently_disabled,cooldown_until,consecutive_loss_count,cooldown_count
        FROM strategy_binding_legacy_inheritance WHERE source_hash=$4 AND implementation_id=$3
        ON CONFLICT DO NOTHING`, [...args, sourceHash]);
      const row = (await db.query(`SELECT *,clock_timestamp() AS now FROM strategy_binding_state WHERE account_id=$1 AND broker='ibkr' AND conid=$2 AND implementation_id=$3 FOR UPDATE`, args)).rows[0];
      if (!row || row.source_hash !== sourceHash) throw Error("PP2_STATE_CONVERSION_REQUIRED");
      for (const value of [row.cooldown_until,row.last_exit_at,row.now]) {
        if (value !== null && value !== undefined) {
          const ms=value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
          if (!Number.isFinite(ms)) throw Error("PP2_STATE_TIME_INVALID");
        }
      }
      const expose = () => ({ enabled:row.enabled === true, permanentlyDisabled:row.permanently_disabled === true,
        ...(row.cooldown_until != null ? {cooldownUntil:new Date(iso(row.cooldown_until))} : {}), ...(row.hold_reason ? {holdReason:String(row.hold_reason)} : {}) });
      const hold = async (reason: string) => {
        await db.query(`UPDATE strategy_binding_state SET hold_reason=$4,updated_at=clock_timestamp() WHERE account_id=$1 AND broker='ibkr' AND conid=$2 AND implementation_id=$3`, [...args,reason]);
        row.hold_reason=reason; await db.query("COMMIT"); return expose();
      };
      if (row.hold_reason) { await db.query("COMMIT"); return expose(); }
      const consumed = (await db.query(`SELECT * FROM strategy_binding_outcomes WHERE account_id=$1 AND conid=$2 AND implementation_id=$3 ORDER BY final_exit_at,original_proposal_id`, args)).rows;
      for (const old of consumed) {
        const evidence = await this.readEconomicEvidence(db, Number(old.original_proposal_id));
        if (fingerprint(evidence) !== old.economic_fingerprint) return hold("OUTCOME_EVIDENCE_CHANGED");
      }
      const proposals = (await db.query(`SELECT p.* FROM proposed_orders p WHERE execution_account_id=$1 AND conid=$2 AND strategy=$3
        AND strategy_attribution IS NOT NULL AND execution_attempted_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM strategy_binding_outcomes o WHERE o.original_proposal_id=p.id) ORDER BY p.id`,args)).rows;
      const outcomes: Array<{proposal:Row; report:Row; evidence:Row; finalExitAt:string; net:number; currency:string}> = [];
      for (const proposal of proposals) {
        const report = await this.options.outcomeReader.read(Number(proposal.id));
        if (!object(report) || report.status !== "COMPLETED" || report.accounting !== "COMPLETE" ||
            report.proposalId !== Number(proposal.id) || report.accountId !== input.accountId || report.conid !== input.conId ||
            report.clientOrderHash !== proposal.client_order_hash || canonicalJson(report.strategyAttribution ?? null) !== canonicalJson(proposal.strategy_attribution) ||
            !Array.isArray(report.missingCommissionExecIds) || report.missingCommissionExecIds.length || !object(report.economicEvidence)) throw Error("OUTCOME_COMPLETION_UNAVAILABLE");
        const evidence = await this.readEconomicEvidence(db, Number(proposal.id));
        if (canonicalJson(evidence) !== canonicalJson(report.economicEvidence)) return hold("OUTCOME_EVIDENCE_CHANGED");
        const fills = evidence.fills as Row[];
        const currency = object(report.grossPnl) ? report.grossPnl.currency : null;
        const net = currency === "PLN" ? report.netPnlPLN : currency === "USD" ? report.netPnlUSD : null;
        if (!finite(net) || !fills.length || fills.some(f => !finite(f.quantity) || f.quantity <= 0 || !finite(f.price) || f.price <= 0 || !finite(f.commission) || f.commissionCurrency !== currency || f.currency !== currency || f.secTypeConflict === true || (f.secType !== null && f.secType !== "STK"))) throw Error("OUTCOME_ACCOUNTING_UNAVAILABLE");
        const gross = fills.reduce((sum,f) => sum + (f.side === "SELL" ? 1 : -1) * Number(f.quantity) * Number(f.price),0);
        const fees = fills.reduce((sum,f) => sum + Number(f.commission),0);
        if (!object(report.grossPnl) || report.grossPnl.amount !== gross || Math.abs(net-(gross-fees)) > 1e-9) return hold("OUTCOME_EVIDENCE_CHANGED");
        const exits = fills.filter(f => f.side === "SELL");
        if (!exits.length) throw Error("OUTCOME_EXIT_UNAVAILABLE");
        outcomes.push({proposal,report,evidence,net,currency:String(currency),finalExitAt:exits.map(f=>String(f.executedAt)).sort().at(-1)!});
      }
      outcomes.sort((a,b)=>a.finalExitAt.localeCompare(b.finalExitAt) || Number(a.proposal.id)-Number(b.proposal.id));
      for (const outcome of outcomes) {
        const id=Number(outcome.proposal.id), stamp=Date.parse(outcome.finalExitAt);
        if (row.last_exit_at && (stamp < new Date(row.last_exit_at).getTime() || (stamp === new Date(row.last_exit_at).getTime() && id <= Number(row.last_proposal_id)))) return hold("OUTCOME_ORDER_CONFLICT");
        if (!row.permanently_disabled) {
          if (outcome.net < 0) row.consecutive_loss_count++;
          else if (outcome.net > 0) row.consecutive_loss_count=0;
          if (row.consecutive_loss_count >= 3) {
            if (row.cooldown_count >= 1) { row.enabled=false; row.permanently_disabled=true; row.cooldown_until=null; }
            else { row.cooldown_count++; row.cooldown_until=new Date(new Date(row.now).getTime()+this.options.cooldownMs); }
            row.consecutive_loss_count=0;
          }
        }
        await db.query(`INSERT INTO strategy_binding_outcomes(original_proposal_id,account_id,broker,conid,implementation_id,final_exit_at,net_amount,currency,economic_fingerprint,economic_evidence,completion_report)
          VALUES($1,$2,'ibkr',$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,[id,...args,outcome.finalExitAt,outcome.net,outcome.currency,fingerprint(outcome.evidence),JSON.stringify(outcome.evidence),JSON.stringify(outcome.report)]);
        row.last_exit_at=outcome.finalExitAt; row.last_proposal_id=id;
      }
      await db.query(`UPDATE strategy_binding_state SET enabled=$4,permanently_disabled=$5,cooldown_until=$6,consecutive_loss_count=$7,cooldown_count=$8,last_exit_at=$9,last_proposal_id=$10,updated_at=clock_timestamp()
        WHERE account_id=$1 AND broker='ibkr' AND conid=$2 AND implementation_id=$3`,[...args,row.enabled,row.permanently_disabled,row.cooldown_until,row.consecutive_loss_count,row.cooldown_count,row.last_exit_at,row.last_proposal_id]);
      await db.query("COMMIT"); return expose();
    } catch(error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  private async readEconomicEvidence(db:PoolClient, proposalId:number):Promise<Row> {
    const closeRows=(await db.query(`SELECT state,account_id,conid,original_hash,close_proposal_id FROM lifecycle_close_operations WHERE original_proposal_id=$1 FOR SHARE`,[proposalId])).rows;
    if(closeRows.length>1) throw Error("OUTCOME_CLOSE_AMBIGUOUS");
    const close=closeRows[0];
    const ids=close?.close_proposal_id ? [proposalId,Number(close.close_proposal_id)] : [proposalId];
    const links=(await db.query(`SELECT * FROM broker_order_links WHERE proposed_order_id=ANY($1::bigint[]) ORDER BY proposed_order_id,role,broker_order_id,order_ref FOR SHARE`,[ids])).rows;
    const fills=(await db.query(`SELECT f.* FROM broker_execution_fills f WHERE f.proposed_order_id=ANY($1::bigint[]) OR EXISTS(
      SELECT 1 FROM broker_order_links l WHERE l.proposed_order_id=ANY($1::bigint[]) AND l.account_id=f.account_id AND l.broker_order_id=f.broker_order_id)
      ORDER BY exec_id FOR SHARE OF f`,[ids])).rows;
    return buildStrategyEconomicEvidence({ fills:fills.map(f=>({execId:f.exec_id,accountId:f.account_id,conid:f.conid,proposedOrderId:f.proposed_order_id === null ? null : Number(f.proposed_order_id),brokerOrderId:f.broker_order_id,
      side:["BOT","BUY"].includes(f.side)?"BUY":["SLD","SELL"].includes(f.side)?"SELL":f.side,quantity:f.shares,price:f.price,currency:f.currency,secType:f.sec_type,secTypeConflict:f.sec_type_conflict,executedAt:iso(f.executed_at),commission:f.commission,commissionCurrency:f.commission_currency})),
      links:links.map(l=>({proposedOrderId:Number(l.proposed_order_id),accountId:l.account_id,role:l.role,brokerOrderId:l.broker_order_id,orderRef:l.order_ref})),
      close:close ? {state:close.state,accountId:close.account_id,conid:close.conid,originalHash:close.original_hash,closeProposalId:close.close_proposal_id === null ? null : Number(close.close_proposal_id)} : null }) as unknown as Row;
  }
}
