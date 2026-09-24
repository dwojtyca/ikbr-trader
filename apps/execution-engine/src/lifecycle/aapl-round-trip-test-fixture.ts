import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { roundTrip } from "./round-trip-test-fixture.js";

export function aaplRoundTrip() {
  const f = roundTrip();
  const bound = f.context.bound!;
  Object.assign(bound, { instrumentId: "aapl_nasdaq", brokerSymbol: "AAPL", conId: 265598,
    localSymbol: "AAPL", tradingClass: "AAPL", currency: "USD", exchange: "SMART" });
  Object.assign(bound.instrument, { id: "aapl_nasdaq", brokerSymbol: "AAPL", conId: 265598, currency: "USD", exchange: "SMART" });
  Object.assign(f.order, { instrumentId: "aapl_nasdaq", instrument: "AAPL", conid: "265598" });
  const hash = computeClientOrderHash(f.order);
  Object.assign(f.review, { instrument_id: "aapl_nasdaq", conid: "265598", client_order_hash: hash });
  f.evidence.lifecycle.clientOrderHash = hash;
  Object.assign((f.review as unknown as { risk_evidence: object }).risk_evidence,
    { instrumentId: "aapl_nasdaq", conid: "265598", quoteCurrency: "USD" });
  for (const fill of f.snapshot.executions) fill.conId = "265598";
  for (const fill of f.evidence.fills) Object.assign(fill, { conid: "265598", currency: "USD", commission_currency: "USD" });
  return f;
}
