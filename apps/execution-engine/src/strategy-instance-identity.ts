import { parseStrategyAttribution, parseStrategyTrigger, strategyTriggerId, type SignalTicket } from "@ikbr/shared";
import { getClientOrderHashVersion } from "@ikbr/shared/client-order-hash";
import { readStrategyAttributionSnapshot, type TradingConfigurationDb } from "@ikbr/shared/trading-config";

export interface StrategyInstancePreflight {
  readonly effectiveConfigHash: string;
  readonly observedAt: string;
}

export async function validateStrategyInstanceEntry(db: TradingConfigurationDb, ticket: SignalTicket, strategy: string,
  clientOrderId: string | undefined, trusted: StrategyInstancePreflight | undefined): Promise<void> {
  const version = getClientOrderHashVersion(ticket);
  const state = await db.query(`SELECT clock_timestamp() AS now, (SELECT v2_not_before_bucket_ms
    FROM strategy_runtime_conversion WHERE singleton=TRUE) AS cutoff`);
  const row = state.rows[0];
  if (version === 1) {
    if (row?.cutoff !== null && row?.cutoff !== undefined) throw new Error("LEGACY_ENTRY_AFTER_STRATEGY_CONVERSION");
    return;
  }
  if (!trusted) throw new Error("STRATEGY_PREFLIGHT_UNAVAILABLE");
  const attribution = parseStrategyAttribution(ticket.strategyAttribution), trigger = parseStrategyTrigger(ticket.strategyTrigger);
  if (trusted.effectiveConfigHash !== attribution.effectiveConfigHash || ticket.instrumentId !== attribution.instrumentId || strategy !== attribution.implementationId)
    throw new Error("STRATEGY_ENTRY_IDENTITY_MISMATCH");
  const snapshot = await readStrategyAttributionSnapshot(db, attribution);
  if (String(snapshot.instrument.contract.conId) !== ticket.conid || snapshot.instrument.contract.symbol !== ticket.instrument ||
      ticket.side !== "BUY" || ticket.positionEffect === "CLOSE_OR_REDUCE") throw new Error("STRATEGY_CONTRACT_MISMATCH");
  const now = row?.now instanceof Date ? row.now.getTime() : Date.parse(String(row?.now));
  const observed = Date.parse(trigger.observedAt), current = Date.parse(trusted.observedAt), cutoff = Number(row?.cutoff);
  if (!Number.isFinite(now) || row?.cutoff == null || !Number.isSafeInteger(cutoff) || trigger.bucketStartMs < cutoff ||
      observed > now || now - observed >= 90_000 || !Number.isFinite(current) || new Date(current).toISOString() !== trusted.observedAt ||
      current > now || now - current >= 90_000 || observed > current || Math.floor(current / 60_000) * 60_000 !== trigger.bucketStartMs)
    throw new Error("STRATEGY_TRIGGER_NOT_CURRENT");
  if (clientOrderId !== `loop:v4:${attribution.instrumentId}:${attribution.implementationId}:${strategyTriggerId(trigger)}`)
    throw new Error("STRATEGY_TRIGGER_KEY_MISMATCH");
}
