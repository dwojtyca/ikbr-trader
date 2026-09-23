import { isWseBound, validateWseOrder } from "../wse-market-rules.js";
import type { SignalTicket, BoundInstrument } from "@ikbr/shared";
import type { CloseContext, ClosePrepared, CloseRisk } from "./close-types.js";
import type { PreparedBrokerOrder } from "../tws-execution-client.js";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { deriveParentOrderRef } from "../reconciliation/order-ref.js";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function assessCloseRisk(order: SignalTicket, bound: BoundInstrument | null, context: CloseContext, watchlist: unknown, wseMetadata?: unknown): CloseRisk {
  const fail = (reason: string): CloseRisk => ({ ok: false, reasons: [reason], evidence: null, expiresAt: "" });
  const policy = bound?.instrument.executionPolicy;
  if (!bound || !policy || !bound.instrument.trading.executionEnabled || bound.instrument.assetClass !== "stock" ||
    !((bound.currency === "USD" && bound.instrument.currency === "USD") ||
      (bound.currency === "PLN" && bound.instrument.currency === "PLN" &&
        bound.exchange === "WSE" && bound.instrument.exchange === "WSE")) || order.instrumentId !== bound.instrumentId ||
    order.conid !== String(bound.conId) || order.instrument !== bound.brokerSymbol)
    return fail("close_risk_binding_mismatch");
  if (order.side !== "SELL" || order.positionEffect !== "CLOSE_OR_REDUCE" || order.quantity !== 1 || order.orderType !== "LMT" ||
    order.stop !== undefined || order.takeProfit !== undefined || (order.partialTakeProfits?.length ?? 0) !== 0 ||
    order.trailingStopPct !== undefined || order.trailingStopActivationR !== undefined || !positive(order.entry))
    return fail("close_risk_shape_invalid");
  if (policy.expectedDirection !== "LONG" || policy.quantityUnit !== "shares" || bound.instrument.risk.quantityUnit !== "shares" ||
    !policy.allowedOrderTypes.includes("LMT") || policy.timeInForce !== "DAY" || policy.outsideRth !== false || policy.transmit !== true ||
    !positive(policy.maxQuantity) || policy.maxQuantity < 1 || !positive(bound.instrument.risk.maxQuantity) || bound.instrument.risk.maxQuantity < 1)
    return fail("close_risk_policy_mismatch");
  const tick = policy.priceTickSize;
  if (!isWseBound(bound) && (!positive(tick) || !positive(bound.minTick) || Math.abs(tick - bound.minTick) > 1e-10 ||
    Math.abs(order.entry / tick - Math.round(order.entry / tick)) > 1e-7)) return fail("close_risk_tick_invalid");
  if (!context.accountId || !context.sessionId || !Number.isFinite(context.nowMs)) return fail("close_risk_context_invalid");
  const body = record(watchlist);
  if (body?.connected !== true || !Array.isArray(body.watchlist)) return fail("close_risk_market_disconnected");
  const matches = body.watchlist.map(record).filter(row => row?.instrumentId === bound.instrumentId);
  if (matches.length !== 1) return fail("close_risk_quote_missing");
  const row = matches[0]!;
  const quote = record(row.marketState);
  if (row.conid !== order.conid || row.subscribed !== true || !quote || quote.conid !== order.conid || quote.marketDataType !== 1)
    return fail("close_risk_quote_identity_invalid");
  const fresh = (value: unknown) => {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(ms) && ms <= context.nowMs && context.nowMs - ms < 10_000 ? ms : NaN;
  };
  const bidTime = fresh(quote.bidObservedAt), askTime = fresh(quote.askObservedAt);
  if (!Number.isFinite(bidTime) || !Number.isFinite(askTime)) return fail("close_risk_quote_stale");
  const { bid, ask } = quote;
  if (!positive(bid) || !positive(ask) || ask < bid) return fail("close_risk_quote_invalid");
  if (!nonnegative(bound.instrument.risk.maxSpread) || !nonnegative(bound.instrument.risk.maxSlippage) ||
    ask - bid > bound.instrument.risk.maxSpread || Math.abs(order.entry - bid) > bound.instrument.risk.maxSlippage)
    return fail("close_risk_spread_or_slippage");
  const wse = isWseBound(bound) ? validateWseOrder(wseMetadata, bound, context.accountId, order, context.nowMs) : undefined;
  if (wse && !wse.ok) return fail(wse.reason);
  const expiresAt = new Date(Math.min(Math.min(bidTime, askTime) + 10_000,
    wse?.ok ? wse.expiresAtMs : Infinity)).toISOString();
  return { ok: true, reasons: [], expiresAt, evidence: { accountId: context.accountId, sessionId: context.sessionId,
    ...(wse?.ok ? { wseMetadata: wse.metadata } : {}),
    clientId: context.clientId, generation: context.generation, instrumentId: bound.instrumentId, conid: order.conid,
    orderHash: computeClientOrderHash(order), quoteCurrency: bound.currency, bid, ask, bidObservedAt: quote.bidObservedAt, askObservedAt: quote.askObservedAt,
    assessedAt: new Date(context.nowMs).toISOString(), expiresAt } };
}

export function validatePreparedClose(prepared: PreparedBrokerOrder, order: SignalTicket, accountId: string,
  clientOrderId: string, bound: BoundInstrument): string | null {
  if (computeClientOrderHash(prepared.normalizedTicket) !== computeClientOrderHash(order) ||
    prepared.normalizedTicket.instrumentId !== order.instrumentId) return "close_prepared_ticket_changed";
  if (!bound.instrument.trading.executionEnabled || bound.instrument.assetClass !== "stock" ||
    !((bound.currency === "USD" && bound.instrument.currency === "USD") ||
      (bound.currency === "PLN" && bound.instrument.currency === "PLN" &&
        bound.exchange === "WSE" && bound.instrument.exchange === "WSE"))) return "close_prepared_binding_unsupported";
  const contract = prepared.contract;
  if (contract.conId !== bound.conId || contract.symbol !== bound.brokerSymbol || contract.secType !== "STK" ||
    contract.currency !== bound.currency || contract.exchange !== bound.exchange) return "close_prepared_contract_changed";
  const { plan, legs } = prepared;
  if (legs.length !== 1 || plan.orders.length !== 1 || plan.bracket || (plan.bracketLegs?.length ?? 0) !== 0 ||
    plan.relatedOrderIds.size !== 1 || !plan.relatedOrderIds.has(plan.parentOrderId)) return "close_prepared_extra_orders";
  const leg = legs[0], planned = plan.orders[0];
  const ref = deriveParentOrderRef(clientOrderId);
  if (leg.role !== "PARENT" || leg.roleOrdinal !== 0 || !Number.isSafeInteger(plan.parentOrderId) || plan.parentOrderId < 1 ||
    String(plan.parentOrderId) !== leg.brokerOrderId || planned.orderId !== plan.parentOrderId || leg.orderRef !== ref)
    return "close_prepared_identity_changed";
  const wire = planned.order as Record<string, unknown>;
  const allowedFields = new Set(["action", "totalQuantity", "orderType", "tif", "account", "transmit", "lmtPrice", "orderRef"]);
  if (Object.keys(wire).some(key => !allowedFields.has(key))) return "close_prepared_unsupported_wire_field";
  if (wire.orderRef !== ref || wire.account !== accountId || wire.action !== "SELL" || wire.totalQuantity !== 1 ||
    wire.orderType !== "LMT" || wire.lmtPrice !== order.entry || wire.tif !== "DAY" || wire.transmit !== true ||
    (wire.outsideRth !== undefined && wire.outsideRth !== false) || (wire.parentId !== undefined && wire.parentId !== 0) ||
    (wire.ocaGroup !== undefined && wire.ocaGroup !== "") || (wire.ocaType !== undefined && wire.ocaType !== 0))
    return "close_prepared_wire_changed";
  return null;
}

export function validatePersistedClosePrepared(prepared: ClosePrepared, ticket: SignalTicket, context: CloseContext): string | null {
  if (!context.bound) return "close_prepared_binding_missing";
  const payload = prepared.payload as PreparedBrokerOrder;
  const failure = validatePreparedClose(payload, ticket, context.accountId, prepared.persistence.clientOrderId, context.bound);
  if (failure) return failure;
  if (JSON.stringify(payload.legs) !== JSON.stringify(prepared.persistence.legs) ||
    computeClientOrderHash(payload.normalizedTicket) !== computeClientOrderHash(prepared.normalizedTicket) ||
    payload.normalizedTicket.instrumentId !== prepared.normalizedTicket.instrumentId)
    return "close_persisted_plan_changed";
  return null;
}
