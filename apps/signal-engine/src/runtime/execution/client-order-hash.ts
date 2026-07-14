/**
 * Execution Runtime — canonical `clientOrderHash` derivation.
 *
 * The hash fingerprints the ORDER-CRITICAL fields of a ticket so
 * that a repeated submission with the same `idempotencyKey` can be
 * classified as:
 *
 *   - matching hash    → duplicate replay (200, no broker call)
 *   - mismatched hash  → idempotency conflict (409, no submission)
 *
 * Design choices:
 *   - Deterministic across process restarts.
 *   - Sensitive to any field that could produce a different broker
 *     order (side, quantity, prices, order type, TIF, instrument
 *     identity).
 *   - INSENSITIVE to non-order metadata like the derived signalId /
 *     decisionId (they change every dry-run even when the resulting
 *     ticket is functionally identical) and to floating-point noise
 *     — every numeric value is normalised via `Number.toString()`.
 *   - Versioned. The canonical form starts with `v<N>|` so any
 *     change to the fingerprint layout produces an entirely
 *     different digest for the same ticket. That is by design:
 *     if PR14+ adds a field to the canonical form, an in-flight
 *     `idempotencyKey` reused across the format bump will
 *     correctly surface as a conflict rather than silently
 *     replay under the wrong hash. Bumping the version therefore
 *     invalidates every persisted `client_order_hash` written
 *     under the previous version — this is the safe direction.
 */

import { createHash } from "node:crypto";

import type { ExecutionTicket } from "@ikbr/shared";

/**
 * Canonical-form version. Increment on any change to the field
 * list, ordering, or scalar serialisation in `canonicaliseTicket`.
 */
export const CLIENT_ORDER_HASH_VERSION = "v1";

/**
 * Compute the canonical hash for a ticket. Uses SHA-256 → hex so
 * the result is safe to store in a TEXT column and compare byte-wise.
 */
export function computeClientOrderHash(ticket: ExecutionTicket): string {
  const canonical = canonicaliseTicket(ticket);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Extract the order-critical fields into a stable, ordered form.
 * Exported for testability — every canonical form MUST start with
 * `${CLIENT_ORDER_HASH_VERSION}|` so a format bump is unambiguous.
 */
export function canonicaliseTicket(ticket: ExecutionTicket): string {
  const fields: readonly [string, string][] = [
    ["instrumentId", str(ticket.instrumentId)],
    ["broker", str(ticket.broker)],
    ["brokerSymbol", str(ticket.brokerSymbol)],
    ["exchange", str(ticket.exchange)],
    ["currency", str(ticket.currency)],
    ["conId", ticket.conId === undefined ? "" : num(ticket.conId)],
    ["localSymbol", ticket.localSymbol ?? ""],
    ["tradingClass", ticket.tradingClass ?? ""],
    ["side", str(ticket.order.side)],
    ["quantity", num(ticket.order.quantity)],
    ["quantityUnit", str(ticket.order.quantityUnit)],
    ["orderType", str(ticket.order.orderType)],
    ["limitPrice", optionalNum(ticket.order.limitPrice)],
    ["stopPrice", optionalNum(ticket.order.stopPrice)],
    ["timeInForce", str(ticket.order.timeInForce)],
    ["outsideRth", ticket.order.outsideRth ? "1" : "0"],
    ["transmit", ticket.order.transmit ? "1" : "0"],
    ["protection.stopLoss", optionalNum(ticket.protection.stopLoss)],
    ["protection.takeProfit", optionalNum(ticket.protection.takeProfit)],
    ["protection.trailingStop", optionalNum(ticket.protection.trailingStop)],
    [
      "protection.bracketEnabled",
      ticket.protection.bracketEnabled ? "1" : "0",
    ],
  ];
  return `${CLIENT_ORDER_HASH_VERSION}|${fields.map(([k, v]) => `${k}=${v}`).join("|")}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(
      `computeClientOrderHash: numeric field must be finite, got ${String(value)}`,
    );
  }
  return value.toString();
}

function optionalNum(value: number | undefined): string {
  return value === undefined ? "" : num(value);
}
