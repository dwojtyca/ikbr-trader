/**
 * PR14 round-7 blocker — public wire schema for
 * `POST /execution/execute-ticket` extracted from `index.ts` so
 * schema-only tests can exercise it without booting the whole
 * execution-engine (Fastify + TWS connection).
 *
 * The schema DOES NOT expose `allowCrossContractExposure` — the
 * value is server-side-only, hardcoded via
 * `SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE`. Reintroducing it here
 * would allow any authenticated caller to weaken the
 * authoritative position guard.
 */

import { z } from "zod";

const ticketSchema = z.object({
  instrument: z.string().min(1),
  conid: z.string().optional(),
  /**
   * PR15.2 — logical registry `instrumentId` (e.g. `es_front`).
   * Optional at the schema level so backward-compatible callers
   * (llm-agent EXECUTE gate, legacy proposal-flow, back-tests)
   * still parse. The handler for the Phase 2 write endpoint
   * REQUIRES it — a missing / unbound / unknown / disabled /
   * mismatched id is rejected before repository mutation and
   * broker dispatch. Server-side binding resolution is the ONLY
   * authoritative identity check; the payload's own `instrument`
   * / `conid` fields are compared against the resolved binding.
   */
  instrumentId: z.string().min(1).optional(),
  side: z.enum(["BUY", "SELL", "HOLD"]),
  positionEffect: z.enum(["OPEN_OR_ADD", "CLOSE_OR_REDUCE"]).optional(),
  // PR15 r6 §6 — no default. `MKT` must be explicitly requested
  // AND authorised by trusted server-side policy
  // (`SERVER_ALLOW_MARKET_ORDER`) before dispatch.
  orderType: z.enum(["MKT", "LMT", "STP"]),
  quantity: z.coerce.number().positive(),
  entry: z.coerce.number().optional(),
  stop: z.coerce.number().optional(),
  takeProfit: z.coerce.number().optional(),
  reason: z.string().default("manual execution ticket"),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
  timestamp: z.string().default(() => new Date().toISOString()),
  riskCheckStatus: z.enum(["PASS", "REJECT"]).default("PASS"),
});

export const executeTicketBodySchema = z.object({
  ticket: ticketSchema,
  persist: z.boolean().default(true),
  strategy: z.string().default("manual_ticket"),
  decisionSource: z.enum(["signal", "llm", "user", "user_override"]).optional(),
  // PR15 r6 §1 — `clientOrderId` + `clientOrderHash` are MANDATORY
  // when a request can reach broker dispatch. The route handler
  // enforces "both-or-neither" AND rejects any submission-capable
  // request that omits either. Zod keeps them optional so preview /
  // dry-run callers still parse; the handler is the enforcement.
  clientOrderId: z.string().min(1).optional(),
  clientOrderHash: z.string().min(1).optional(),
});

/**
 * Server-side, non-configurable authoritative default for the
 * cross-contract exposure policy. PR14 hardcodes `false`
 * (no pyramiding). A future PR that legitimately needs `true`
 * must resolve it from a trusted server-side instrument-registry
 * policy — never from the request body.
 */
export const SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE = false;

/**
 * PR15 r6 §6 — hardcoded server-side policy: MKT orders are NOT
 * accepted in the current phase. Callers must specify `LMT` or
 * `STP` and provide the corresponding price fields. A future PR
 * that legitimately needs `MKT` must gate it on a trusted policy
 * source (instrument registry / kill-switch / operator token) —
 * never on the request body.
 */
export const SERVER_ALLOW_MARKET_ORDER: boolean = false;
