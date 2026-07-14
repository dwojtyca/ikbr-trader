/**
 * Execution Runtime — shared `ExecutionTicket` → legacy `SignalTicket` mapper.
 *
 * `execution-engine`'s `POST /execution/execute-ticket` accepts the
 * legacy `SignalTicket` shape (from `packages/shared/src/index.ts`).
 * PR11's `TradingPipeline` returns the newer `ExecutionTicket` shape
 * (from `packages/shared/src/execution-ticket/types.ts`).
 *
 * Rather than teach the endpoint a second schema, this module
 * projects the new ticket into the legacy shape. Only the fields
 * required by `validateExecutableTicket` and `insertProposedFromTicket`
 * are populated — everything else is left `undefined` and the
 * database defaults kick in.
 *
 * Order-type semantics (PR13 blocker fix):
 *
 *   - `LMT`  → `LMT` (`entry` carries the limit price;
 *              bracket protection stopLoss/takeProfit forwarded
 *              via `stop`/`takeProfit` — a bracketed LMT parent
 *              has NO conflict on the legacy `stop` field).
 *   - `STP`  → `STP` (`stop` carries the parent stop trigger).
 *              **BRACKET IS UNSUPPORTED for STP parents on the
 *              write edge** because the legacy `SignalTicket`
 *              has a SINGLE `stop` field — it cannot represent
 *              both a parent STP trigger AND a bracket protective
 *              stop-loss simultaneously. Silently picking one
 *              would place a different order than the pipeline
 *              intended. Any STP ticket with `protection.stopLoss`
 *              or `protection.takeProfit` (or `bracketEnabled`)
 *              is rejected with `UnsupportedOrderCombinationError`.
 *   - `STP_LMT` → REJECTED. The legacy `SignalTicket` wire type
 *              has no STP_LMT variant, and the `execution-engine`
 *              broker adapter has no STP_LMT branch. Silently
 *              coercing to `STP` would DROP the limit price and
 *              place a different order type at the broker.
 *
 * Runtime `routes.ts` already rejects `STP_LMT` at the schema
 * layer with HTTP 400, and the runtime's `execute()` wraps the
 * mapper in a try/catch that translates every thrown error into
 * `NOT_SUBMITTED { reason: "UNSUPPORTED_TICKET_SHAPE" }` — so a
 * bracket-plus-STP ticket never reaches `execution-engine`.
 */

import type { ExecutionTicket, SignalTicket } from "@ikbr/shared";

export class UnsupportedOrderTypeError extends Error {
  readonly orderType: string;
  constructor(orderType: string) {
    super(
      `orderType "${orderType}" is not supported on the write edge — ` +
        `the legacy SignalTicket wire type only accepts LMT | STP | MKT ` +
        `and execution-engine has no STP_LMT broker adapter. Reject at ` +
        `the runtime schema instead of coercing here.`,
    );
    this.name = "UnsupportedOrderTypeError";
    this.orderType = orderType;
  }
}

export class UnsupportedOrderCombinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedOrderCombinationError";
  }
}

export function toLegacySignalTicket(ticket: ExecutionTicket): SignalTicket {
  const order = ticket.order;
  if (order.orderType === "STP_LMT") {
    throw new UnsupportedOrderTypeError(order.orderType);
  }

  // STP parents cannot carry bracket protection through the legacy
  // wire — its single `stop` field would either drop the parent
  // trigger or the bracket protective stop. Fail-closed rather
  // than choose silently.
  if (order.orderType === "STP") {
    const bracketSignals: string[] = [];
    if (ticket.protection.bracketEnabled) bracketSignals.push("bracketEnabled");
    if (ticket.protection.stopLoss !== undefined)
      bracketSignals.push("stopLoss");
    if (ticket.protection.takeProfit !== undefined)
      bracketSignals.push("takeProfit");
    if (ticket.protection.trailingStop !== undefined)
      bracketSignals.push("trailingStop");
    if (bracketSignals.length > 0) {
      throw new UnsupportedOrderCombinationError(
        `STP orders cannot carry bracket protection on the write edge — ` +
          `the legacy SignalTicket has a single \`stop\` field that cannot ` +
          `represent both the parent stop trigger and the bracket ` +
          `protective stop-loss simultaneously. Offending fields: ` +
          `${bracketSignals.join(", ")}.`,
      );
    }
  }

  // Assemble the legacy shape. Field routing (post-guards):
  //   LMT  → entry = limitPrice, stop/takeProfit = bracket protection
  //   STP  → stop  = stopPrice   (bracket rejected above)
  const legacy: SignalTicket = {
    instrument: ticket.brokerSymbol,
    ...(ticket.conId !== undefined ? { conid: String(ticket.conId) } : {}),
    side: order.side,
    orderType: order.orderType,
    quantity: order.quantity,
    ...(order.limitPrice !== undefined ? { entry: order.limitPrice } : {}),
    // The `stop` field carries either the STP parent trigger OR
    // the bracket protective stop, never both — the mutual-
    // exclusion invariant above guarantees the two never collide.
    ...(order.orderType === "STP"
      ? order.stopPrice !== undefined
        ? { stop: order.stopPrice }
        : {}
      : ticket.protection.stopLoss !== undefined
        ? { stop: ticket.protection.stopLoss }
        : {}),
    ...(ticket.protection.takeProfit !== undefined
      ? { takeProfit: ticket.protection.takeProfit }
      : {}),
    reason: `execution-runtime: signalId=${ticket.signalId} decisionId=${ticket.decisionId} ticketId=${ticket.ticketId}`,
    // Confidence is a required column but the shared ExecutionTicket
    // does not carry the raw score. `1.0` communicates "risk-checked
    // ticket accepted by the pipeline". A future PR that surfaces
    // signal confidence on the ticket can replace this constant.
    confidence: 1.0,
    timestamp: ticket.createdAt.toISOString(),
    riskCheckStatus: "PASS",
  };
  return legacy;
}
