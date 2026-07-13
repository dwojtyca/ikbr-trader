// Direct-ticket (persist=false) guard. See ADR-001 §3.5.
//
// The direct-ticket path bypasses the PROPOSED→SUBMITTED lifecycle and
// places an order at the broker without any signal-engine / risk-engine
// review. It is retained for operator hot-fix scenarios but must be:
//   1. opt-in via EXECUTION_ALLOW_DIRECT_TICKET=true,
//   2. tagged decisionSource=user_override so the caller cannot deny
//      intent,
//   3. audited as a CRITICAL system alert on every use.
//
// The pure decision function here is unit-tested in isolation. The HTTP
// handler in index.ts and the belt-and-suspenders check in
// tws-execution-client.ts consume it identically.

export type DirectTicketDenyReason =
  | "direct_ticket_disabled"
  | "direct_ticket_requires_user_override";

export interface DirectTicketDecisionInputs {
  persist: boolean;
  allowDirectTicket: boolean;
  decisionSource: string | null | undefined;
}

export type DirectTicketDecision =
  | { kind: "not_applicable" }
  | { kind: "allowed" }
  | {
      kind: "denied";
      statusCode: 403 | 400;
      reason: DirectTicketDenyReason;
    };

export function evaluateDirectTicket(
  input: DirectTicketDecisionInputs,
): DirectTicketDecision {
  if (input.persist) return { kind: "not_applicable" };
  if (!input.allowDirectTicket) {
    return {
      kind: "denied",
      statusCode: 403,
      reason: "direct_ticket_disabled",
    };
  }
  if (input.decisionSource !== "user_override") {
    return {
      kind: "denied",
      statusCode: 400,
      reason: "direct_ticket_requires_user_override",
    };
  }
  return { kind: "allowed" };
}

export interface DirectTicketAuditPayload {
  correlationId: string;
  tokenFingerprint: string | null;
  symbol: string;
  side: string;
  quantity: number;
}

export interface DirectTicketAuditRecord {
  message: string;
  payload: DirectTicketAuditPayload;
}

export function buildDirectTicketAuditRecord(
  payload: DirectTicketAuditPayload,
): DirectTicketAuditRecord {
  return {
    message:
      `SAFETY:DIRECT_TICKET_USED — direct broker ticket bypassed PROPOSED flow ` +
      `(symbol=${payload.symbol} side=${payload.side} qty=${payload.quantity})`,
    payload,
  };
}

export interface DirectTicketAlertInput {
  severity: "CRITICAL";
  kind: "direct_ticket_used";
  message: string;
  payload: DirectTicketAuditPayload;
}

export type DirectTicketDispatch =
  | { kind: "not_applicable" }
  | {
      kind: "deny";
      statusCode: 403 | 400;
      body: { error: string; reason: DirectTicketDenyReason };
    }
  | { kind: "allow"; alert: DirectTicketAlertInput };

export interface DirectTicketDispatchInputs {
  persist: boolean;
  allowDirectTicket: boolean;
  decisionSource: string | null | undefined;
  auth: { correlationId: string; tokenFingerprint: string | null } | null;
  symbol: string;
  side: string;
  quantity: number;
}

/**
 * End-to-end dispatch planner for POST /execution/execute-ticket. The
 * caller executes the returned outcome verbatim — no policy decisions
 * remain inside the HTTP handler, so behaviour is fully covered by the
 * unit tests of this function.
 */
export function planDirectTicketDispatch(
  input: DirectTicketDispatchInputs,
): DirectTicketDispatch {
  const decision = evaluateDirectTicket({
    persist: input.persist,
    allowDirectTicket: input.allowDirectTicket,
    decisionSource: input.decisionSource,
  });
  if (decision.kind === "not_applicable") return { kind: "not_applicable" };
  if (decision.kind === "denied") {
    return {
      kind: "deny",
      statusCode: decision.statusCode,
      body: {
        error: `direct ticket refused: ${decision.reason}`,
        reason: decision.reason,
      },
    };
  }
  const audit = buildDirectTicketAuditRecord({
    correlationId: input.auth?.correlationId ?? "",
    tokenFingerprint: input.auth?.tokenFingerprint ?? null,
    symbol: input.symbol,
    side: input.side,
    quantity: input.quantity,
  });
  return {
    kind: "allow",
    alert: {
      severity: "CRITICAL",
      kind: "direct_ticket_used",
      message: audit.message,
      payload: audit.payload,
    },
  };
}

export interface ClientDirectTicketGuardInputs {
  proposedOrderId: number | string | null | undefined;
  environment: "paper" | "live";
  allowDirectTicket: boolean;
}

/**
 * Belt-and-suspenders guard executed inside the broker client just
 * before the socket write. A caller that skips the HTTP handler
 * (e.g. an internal service that composed a `SignalTicket` and reached
 * for `placeSignalOrder` directly) will still be refused in live
 * without the explicit opt-in.
 */
export function assertClientDirectTicketAllowed(
  input: ClientDirectTicketGuardInputs,
): void {
  const missingProposedId =
    input.proposedOrderId === null ||
    input.proposedOrderId === undefined ||
    input.proposedOrderId === "";
  if (
    missingProposedId &&
    input.environment === "live" &&
    input.allowDirectTicket !== true
  ) {
    throw new Error(
      "refused: direct ticket in live without opt-in (EXECUTION_ALLOW_DIRECT_TICKET=false)",
    );
  }
}
