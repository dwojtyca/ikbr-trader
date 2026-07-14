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
  side: z.enum(["BUY", "SELL", "HOLD"]),
  positionEffect: z.enum(["OPEN_OR_ADD", "CLOSE_OR_REDUCE"]).optional(),
  orderType: z.enum(["MKT", "LMT", "STP"]).default("MKT"),
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
