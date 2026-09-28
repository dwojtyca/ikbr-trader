import type { FastifyInstance } from "fastify";
import type { SessionScheduleEvidence, TradingInstrumentV1 } from "@ikbr/shared";
import {
  evaluateTradingConfigurationBrokerEvidence,
  type TradingConfigurationBrokerEvidence,
  type TradingConfigurationBrokerObservation,
} from "@ikbr/shared/trading-config";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function configurationQuoteFromWatchlist(instrument: TradingInstrumentV1, payload: unknown): unknown {
  const body = record(payload);
  if (body?.connected !== true || !Array.isArray(body.watchlist)) return undefined;
  const matching = body.watchlist.map(record).filter(row => row?.instrumentId === instrument.id);
  if (matching.length !== 1) return undefined;
  const row = matching[0]!, quote = record(row.marketState), conid = String(instrument.contract.conId);
  if (row.subscribed !== true || row.symbol !== instrument.contract.symbol || row.conid !== conid || quote?.conid !== conid) return undefined;
  return Object.freeze({ instrumentId: instrument.id, conId: instrument.contract.conId, source: "ibkr",
    marketDataType: quote.marketDataType, bid: quote.bid, ask: quote.ask,
    bidObservedAt: quote.bidObservedAt, askObservedAt: quote.askObservedAt });
}

export function registerConfigurationMetadataRoutes(app: FastifyInstance, deps: {
  instruments(): readonly TradingInstrumentV1[];
  currentAccountId(): string | null;
  assertAccountAllowed(accountId: string): void;
  loadMetadata(instrument: TradingInstrumentV1, accountId: string): Promise<TradingConfigurationBrokerObservation>;
  readSessionEvidence(instrument: TradingInstrumentV1): Promise<SessionScheduleEvidence | null>;
  readWatchlist(): Promise<unknown>;
  now?: () => number;
}): { evidence(): ReadonlyMap<string, TradingConfigurationBrokerEvidence> } {
  const cache = new Map<string, { accountId: string; observation: TradingConfigurationBrokerObservation }>();
  const now = deps.now ?? Date.now;
  app.get("/execution/configuration/instruments/:instrumentId/broker-evidence", async (request, reply) => {
    const id = (request.params as { instrumentId: string }).instrumentId;
    const instrument = deps.instruments().find(item => item.id === id);
    if (!instrument) return reply.code(404).send({ error: "CONFIGURATION_INSTRUMENT_UNAVAILABLE" });
    const accountId = deps.currentAccountId();
    if (!accountId) return reply.code(503).send({ error: "ACTIVE_ACCOUNT_UNAVAILABLE" });
    try { deps.assertAccountAllowed(accountId); }
    catch { return reply.code(503).send({ error: "CONFIGURATION_ACCOUNT_UNAVAILABLE" }); }
    // Callers cannot provide observations or query overrides. Only these server-owned readers attest evidence.
    const [metadata, session, watchlist] = await Promise.allSettled([
      deps.loadMetadata(instrument, accountId), deps.readSessionEvidence(instrument), deps.readWatchlist(),
    ]);
    if (deps.currentAccountId() !== accountId) {
      cache.delete(id);
      return reply.code(503).send({ error: "CONFIGURATION_ACCOUNT_CHANGED" });
    }
    if (metadata.status !== "fulfilled") {
      cache.delete(id);
      return reply.code(503).send({ error: "BROKER_METADATA_UNAVAILABLE" });
    }
    const observation = Object.freeze({ ...metadata.value,
      sessionEvidence: session.status === "fulfilled" ? session.value : null,
      quote: watchlist.status === "fulfilled" ? configurationQuoteFromWatchlist(instrument, watchlist.value) : undefined });
    cache.set(id, { accountId, observation });
    return { instrumentId: id, evidence: evaluateTradingConfigurationBrokerEvidence(instrument, observation, now()) };
  });
  return { evidence: () => new Map(deps.instruments().map(instrument => {
    const cached = cache.get(instrument.id);
    if (cached && cached.accountId !== deps.currentAccountId()) cache.delete(instrument.id);
    return [instrument.id, evaluateTradingConfigurationBrokerEvidence(instrument, cache.get(instrument.id)?.observation, now())];
  })) };
}
