/**
 * PR14 round-7 blocker — `allowCrossContractExposure` is NOT
 * caller-controlled. The public request body schema for
 * `POST /execution/execute-ticket` must NOT expose it, and the
 * server-side default constant MUST remain `false` for PR14.
 *
 * This is a regression test: any future PR that reintroduces
 * `allowCrossContractExposure` on the wire without a trusted
 * server-side policy resolver would allow any authenticated
 * caller to weaken the authoritative position guard.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE,
  executeTicketBodySchema,
} from "./execute-ticket-schema.js";

const validTicket = {
  ticket: {
    instrument: "AAPL",
    side: "BUY" as const,
    orderType: "LMT" as const,
    quantity: 10,
    entry: 100.5,
    reason: "test",
    confidence: 1,
    timestamp: "2026-07-14T12:00:00.000Z",
    riskCheckStatus: "PASS" as const,
  },
  clientOrderId: "idem-1",
  clientOrderHash: "abc",
};

describe("execute-ticket body schema — allowCrossContractExposure is not caller-controlled (round-7)", () => {
  it("SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE is hardcoded false", () => {
    assert.equal(SERVER_ALLOW_CROSS_CONTRACT_EXPOSURE, false);
  });

  it("body with allowCrossContractExposure=true is silently STRIPPED — the parsed shape has no such field", () => {
    const parsed = executeTicketBodySchema.parse({
      ...validTicket,
      // Malicious / stale client attempt to weaken the guard.
      allowCrossContractExposure: true,
    } as unknown);
    // Zod's default `strip` behavior removes unknown keys.
    assert.equal(
      (parsed as Record<string, unknown>).allowCrossContractExposure,
      undefined,
      "parsed body must not carry allowCrossContractExposure",
    );
  });

  it("body without the field parses normally (default request shape)", () => {
    const parsed = executeTicketBodySchema.parse(validTicket);
    assert.equal(
      (parsed as Record<string, unknown>).allowCrossContractExposure,
      undefined,
    );
  });

  it("the parsed body TYPE has no allowCrossContractExposure property (compile-time)", () => {
    type Body = ReturnType<typeof executeTicketBodySchema.parse>;
    // @ts-expect-error — the field MUST NOT exist on the
    // parsed body type. If a future PR reintroduces it, this
    // directive becomes unused and the test fails.
    const _forbidden: Body["allowCrossContractExposure"] = true;
    void _forbidden;
    assert.ok(true);
  });
});

describe("execute-ticket body schema — PR15.2 instrumentId propagation", () => {
  it("accepts a body carrying `instrumentId` on the ticket", () => {
    const parsed = executeTicketBodySchema.parse({
      ...validTicket,
      ticket: { ...validTicket.ticket, instrumentId: "es_front" },
    });
    assert.equal(parsed.ticket.instrumentId, "es_front");
  });

  it("keeps parsing when `instrumentId` is absent (legacy compat)", () => {
    const parsed = executeTicketBodySchema.parse(validTicket);
    assert.equal(parsed.ticket.instrumentId, undefined);
  });

  it("stripping `allowCrossContractExposure` still holds even when instrumentId is set", () => {
    const parsed = executeTicketBodySchema.parse({
      ...validTicket,
      ticket: { ...validTicket.ticket, instrumentId: "es_front" },
      allowCrossContractExposure: true,
    } as unknown);
    assert.equal(
      (parsed as Record<string, unknown>).allowCrossContractExposure,
      undefined,
    );
    assert.equal(
      (parsed.ticket as Record<string, unknown>).allowCrossContractExposure,
      undefined,
      "ticket-level allowCrossContractExposure must also be stripped",
    );
  });

  it("rejects empty `instrumentId` strings", () => {
    assert.throws(() =>
      executeTicketBodySchema.parse({
        ...validTicket,
        ticket: { ...validTicket.ticket, instrumentId: "" },
      }),
    );
  });
});
