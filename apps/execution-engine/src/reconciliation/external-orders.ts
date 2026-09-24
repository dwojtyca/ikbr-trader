import { z } from "zod";
import type { BrokerOrderRow, BrokerReconciliationSnapshot } from "./broker-adapter.js";
const id = z.string().regex(/^[1-9]\d*$/).refine(v => Number.isSafeInteger(Number(v)));
const entry = z.object({
  accountId: z.string().trim().min(1), permId: id, conId: id, symbol: z.string().trim().min(1),
  secType: z.literal("STK"), currency: z.string().regex(/^[A-Z]{3}$/), exchange: z.string().trim().min(1),
  action: z.literal("SELL"), totalQuantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  validFrom: z.string().datetime(), expiresAt: z.string().datetime(), note: z.string().trim().min(1).max(500),
}).strict().refine(v => Date.parse(v.expiresAt) > Date.parse(v.validFrom) && Date.parse(v.expiresAt) - Date.parse(v.validFrom) <= 86400000);
export type ExternalOrderApproval = z.infer<typeof entry>;
export function parseExternalOrders(raw: string): readonly ExternalOrderApproval[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("external_orders_invalid_json"); }
  const result = z.array(entry).max(20).safeParse(value);
  if (!result.success) throw new Error("external_orders_invalid");
  if (new Set(result.data.map(v => v.permId)).size !== result.data.length) throw new Error("external_orders_duplicate");
  return result.data;
}
export interface ExternalOrderPolicy {
  approvals: readonly ExternalOrderApproval[];
  protectedConIds: readonly string[];
}
const positiveId = (s: unknown): s is string => typeof s === "string" && /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s));
export function recognizeExternalOrders(snapshot: BrokerReconciliationSnapshot, unowned: readonly BrokerOrderRow[],
  policy: ExternalOrderPolicy, collidedPermIds: ReadonlySet<string>, now: number): Map<BrokerOrderRow, ExternalOrderApproval> {
  const approved = new Map<BrokerOrderRow, ExternalOrderApproval>();
  if (!snapshot.exposureComplete || !snapshot.recoveryComplete || now < snapshot.capturedAt.getTime() || now - snapshot.capturedAt.getTime() > 60000) return approved;
  for (const row of unowned) {
    const approval = policy.approvals.find(a => a.accountId === snapshot.accountId && a.permId === row.permId);
    if (!approval || now < Date.parse(approval.validFrom) || now >= Date.parse(approval.expiresAt)
      || policy.protectedConIds.includes(approval.conId) || collidedPermIds.has(approval.permId)
      || !positiveId(row.permId) || snapshot.openOrders.filter(x => x.permId === row.permId).length !== 1
      || row.clientId !== 0 || (row.orderRef != null && row.orderRef !== "")
      || !["Submitted", "PreSubmitted"].includes(row.status)
      || !["accountId", "conId", "symbol", "secType", "currency", "exchange", "action"].every(k => row[k as keyof BrokerOrderRow] === approval[k as keyof ExternalOrderApproval])
      || !Number.isSafeInteger(row.filled) || !Number.isSafeInteger(row.remaining) || row.filled! < 0 || row.remaining! <= 0
      || row.filled! + row.remaining! !== approval.totalQuantity) continue;
    const positions = snapshot.positions.filter(p => p.accountId === snapshot.accountId && p.conId === row.conId);
    if (positions.length !== 1 || positions[0].symbol !== row.symbol || positions[0].currency !== row.currency || positions[0].secType !== row.secType
      || !Number.isSafeInteger(positions[0].position) || positions[0].position <= 0) continue;
    approved.set(row, approval);
  }
  for (const row of [...approved.keys()]) {
    const same = unowned.filter(x => x.conId === row.conId && (x.accountId === snapshot.accountId || !x.accountId));
    const position = snapshot.positions.find(p => p.accountId === snapshot.accountId && p.conId === row.conId)!;
    if (snapshot.openOrders.filter(x => x.accountId === snapshot.accountId && x.conId === row.conId).length !== same.length
      || same.some(x => !approved.has(x)) || same.reduce((n, x) => n + x.remaining!, 0) > position.position) {
      for (const x of same) approved.delete(x);
    }
  }
  return approved;
}
