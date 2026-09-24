import type { ExternalOrderApproval } from "./external-orders.js";
import type { BrokerOrderRow } from "./broker-adapter.js";
export function externalFixture(now = Date.now()) {
  const approval: ExternalOrderApproval = { accountId: "DU-EXTERNAL", permId: "987", conId: "123", symbol: "EXT", secType: "STK", currency: "USD", exchange: "SMART",
    action: "SELL", totalQuantity: 10, validFrom: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), note: "owner confirmed manual order" };
  const row: BrokerOrderRow = { ...approval, brokerOrderId: "0", clientId: 0, orderRef: null, filled: 0, remaining: 10, status: "PreSubmitted", observedAt: new Date(now) };
  return { approval, row, position: { accountId: approval.accountId, conId: approval.conId, symbol: approval.symbol, secType: "STK", currency: "USD", exchange: "SMART", position: 10 } };
}
