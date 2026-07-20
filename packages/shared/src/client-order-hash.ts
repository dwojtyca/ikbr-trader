/**
 * PR15 r6 §5 — canonical client-order hash keyed on `SignalTicket`.
 *
 * The execution-engine wire body carries a `SignalTicket` — the
 * hash MUST be derivable from the exact ticket that will be
 * dispatched. Both signal-engine (caller) and execution-engine
 * (server) compute this hash from the same wire representation so
 * server-side verification is meaningful.
 *
 * Layout starts with `${CLIENT_ORDER_HASH_VERSION}|` so any change
 * to the canonical form produces an entirely different digest for
 * the same ticket — bumping the version invalidates every stored
 * hash under the previous format, which is the safe direction.
 */

import { createHash } from "node:crypto";

import type { SignalTicket } from "./index.js";

export const CLIENT_ORDER_HASH_VERSION = "v1";

export function computeClientOrderHash(ticket: SignalTicket): string {
  const canonical = canonicaliseSignalTicket(ticket);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function canonicaliseSignalTicket(ticket: SignalTicket): string {
  const fields: readonly [string, string][] = [
    ["instrument", str(ticket.instrument)],
    ["conid", ticket.conid ?? ""],
    ["side", str(ticket.side)],
    ["positionEffect", ticket.positionEffect ?? ""],
    ["orderType", str(ticket.orderType)],
    ["quantity", num(ticket.quantity)],
    ["entry", optionalNum(ticket.entry)],
    ["stop", optionalNum(ticket.stop)],
    ["takeProfit", optionalNum(ticket.takeProfit)],
    ["trailingStopPct", optionalNum(ticket.trailingStopPct)],
    ["trailingStopActivationR", optionalNum(ticket.trailingStopActivationR)],
    [
      "partialTakeProfits",
      (ticket.partialTakeProfits ?? [])
        .map((p) => `${num(p.price)}@${num(p.fraction)}`)
        .join(","),
    ],
    ["riskCheckStatus", str(ticket.riskCheckStatus)],
  ];
  return `${CLIENT_ORDER_HASH_VERSION}|${fields
    .map(([k, v]) => `${k}=${v}`)
    .join("|")}`;
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
function optionalNum(value: number | undefined | null): string {
  return value === undefined || value === null ? "" : num(value);
}
