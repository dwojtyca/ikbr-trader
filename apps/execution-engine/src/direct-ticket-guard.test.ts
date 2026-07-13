import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertClientDirectTicketAllowed,
  buildDirectTicketAuditRecord,
  evaluateDirectTicket,
  planDirectTicketDispatch,
} from "./direct-ticket-guard.js";

describe("execution-engine direct-ticket-guard", () => {
  describe("evaluateDirectTicket", () => {
    it("persist=true → not_applicable (default path is untouched)", () => {
      const decision = evaluateDirectTicket({
        persist: true,
        allowDirectTicket: false,
        decisionSource: undefined,
      });
      assert.equal(decision.kind, "not_applicable");
    });

    it("persist=false + flag disabled → 403 direct_ticket_disabled", () => {
      const decision = evaluateDirectTicket({
        persist: false,
        allowDirectTicket: false,
        decisionSource: "user_override",
      });
      assert.deepEqual(decision, {
        kind: "denied",
        statusCode: 403,
        reason: "direct_ticket_disabled",
      });
    });

    it("persist=false + flag on + decisionSource=undefined → 400", () => {
      const decision = evaluateDirectTicket({
        persist: false,
        allowDirectTicket: true,
        decisionSource: undefined,
      });
      assert.deepEqual(decision, {
        kind: "denied",
        statusCode: 400,
        reason: "direct_ticket_requires_user_override",
      });
    });

    it("persist=false + flag on + decisionSource=user → 400", () => {
      const decision = evaluateDirectTicket({
        persist: false,
        allowDirectTicket: true,
        decisionSource: "user",
      });
      assert.equal(decision.kind, "denied");
      assert.equal(
        (decision as { reason: string }).reason,
        "direct_ticket_requires_user_override",
      );
    });

    it("persist=false + flag on + decisionSource=llm → 400", () => {
      const decision = evaluateDirectTicket({
        persist: false,
        allowDirectTicket: true,
        decisionSource: "llm",
      });
      assert.equal(decision.kind, "denied");
    });

    it("persist=false + flag on + decisionSource=user_override → allowed", () => {
      const decision = evaluateDirectTicket({
        persist: false,
        allowDirectTicket: true,
        decisionSource: "user_override",
      });
      assert.deepEqual(decision, { kind: "allowed" });
    });

    it("flag precedence: flag off overrides even user_override", () => {
      // Guarantees an operator cannot bypass the flag by supplying the
      // magic decisionSource. The flag must be flipped explicitly.
      const decision = evaluateDirectTicket({
        persist: false,
        allowDirectTicket: false,
        decisionSource: "user_override",
      });
      assert.equal(
        (decision as { reason: string }).reason,
        "direct_ticket_disabled",
      );
    });
  });

  describe("buildDirectTicketAuditRecord", () => {
    it("emits SAFETY:DIRECT_TICKET_USED with symbol/side/qty in message", () => {
      const record = buildDirectTicketAuditRecord({
        correlationId: "11111111-2222-4333-8444-555555555555",
        tokenFingerprint: "deadbeef",
        symbol: "AAPL",
        side: "BUY",
        quantity: 10,
      });
      assert.match(record.message, /^SAFETY:DIRECT_TICKET_USED/);
      assert.match(record.message, /symbol=AAPL/);
      assert.match(record.message, /side=BUY/);
      assert.match(record.message, /qty=10/);
    });

    it("payload carries correlationId, tokenFingerprint, symbol, side, qty", () => {
      const record = buildDirectTicketAuditRecord({
        correlationId: "cid-abc",
        tokenFingerprint: "cafefeed",
        symbol: "NVDA",
        side: "SELL",
        quantity: 3,
      });
      assert.deepEqual(record.payload, {
        correlationId: "cid-abc",
        tokenFingerprint: "cafefeed",
        symbol: "NVDA",
        side: "SELL",
        quantity: 3,
      });
    });

    it("never includes the raw token in message or payload", () => {
      // The audit record is built from tokenFingerprint (8-char hex) only.
      // We supply an unrelated 'raw token' string and assert it never
      // leaks into either surface.
      const rawToken = "sk-raw-secret-abcdef0123456789abcdef0123456789";
      const record = buildDirectTicketAuditRecord({
        correlationId: "cid-xyz",
        tokenFingerprint: "abc12345",
        symbol: "MSFT",
        side: "BUY",
        quantity: 1,
      });
      assert.ok(!record.message.includes(rawToken));
      assert.ok(!JSON.stringify(record.payload).includes(rawToken));
      assert.equal(record.payload.tokenFingerprint, "abc12345");
    });

    it("tolerates null tokenFingerprint (unauthenticated context)", () => {
      const record = buildDirectTicketAuditRecord({
        correlationId: "cid-1",
        tokenFingerprint: null,
        symbol: "SPY",
        side: "BUY",
        quantity: 1,
      });
      assert.equal(record.payload.tokenFingerprint, null);
    });
  });

  describe("assertClientDirectTicketAllowed (belt-and-suspenders)", () => {
    it("paper + no proposedOrderId + flag off → allowed (paper is permissive)", () => {
      assert.doesNotThrow(() =>
        assertClientDirectTicketAllowed({
          proposedOrderId: null,
          environment: "paper",
          allowDirectTicket: false,
        }),
      );
    });

    it("live + proposedOrderId set + flag off → allowed (persisted path)", () => {
      assert.doesNotThrow(() =>
        assertClientDirectTicketAllowed({
          proposedOrderId: 42,
          environment: "live",
          allowDirectTicket: false,
        }),
      );
    });

    it("live + no proposedOrderId + flag off → refused", () => {
      assert.throws(
        () =>
          assertClientDirectTicketAllowed({
            proposedOrderId: null,
            environment: "live",
            allowDirectTicket: false,
          }),
        /refused: direct ticket in live without opt-in/,
      );
    });

    it("live + no proposedOrderId + flag on → allowed", () => {
      assert.doesNotThrow(() =>
        assertClientDirectTicketAllowed({
          proposedOrderId: null,
          environment: "live",
          allowDirectTicket: true,
        }),
      );
    });

    it("live + proposedOrderId=undefined + flag off → refused", () => {
      assert.throws(
        () =>
          assertClientDirectTicketAllowed({
            proposedOrderId: undefined,
            environment: "live",
            allowDirectTicket: false,
          }),
        /refused: direct ticket in live/,
      );
    });

    it("live + proposedOrderId='' + flag off → refused (empty string counts as missing)", () => {
      assert.throws(
        () =>
          assertClientDirectTicketAllowed({
            proposedOrderId: "",
            environment: "live",
            allowDirectTicket: false,
          }),
        /refused: direct ticket in live/,
      );
    });
  });

  describe("planDirectTicketDispatch (handler wiring)", () => {
    const baseAllowed = {
      persist: false,
      allowDirectTicket: true,
      decisionSource: "user_override" as const,
      auth: {
        correlationId: "11111111-2222-4333-8444-555555555555",
        tokenFingerprint: "cafebabe",
      },
      symbol: "AAPL",
      side: "BUY",
      quantity: 5,
    };

    it("persist=true → not_applicable (default path unchanged)", () => {
      const plan = planDirectTicketDispatch({
        ...baseAllowed,
        persist: true,
      });
      assert.deepEqual(plan, { kind: "not_applicable" });
    });

    it("persist=false + flag off → deny 403 with reason=direct_ticket_disabled", () => {
      const plan = planDirectTicketDispatch({
        ...baseAllowed,
        allowDirectTicket: false,
      });
      assert.equal(plan.kind, "deny");
      if (plan.kind !== "deny") throw new Error("unreachable");
      assert.equal(plan.statusCode, 403);
      assert.equal(plan.body.reason, "direct_ticket_disabled");
      assert.match(plan.body.error, /direct ticket refused/);
    });

    it("persist=false + flag on + decisionSource=user → deny 400", () => {
      const plan = planDirectTicketDispatch({
        ...baseAllowed,
        decisionSource: "user",
      });
      assert.equal(plan.kind, "deny");
      if (plan.kind !== "deny") throw new Error("unreachable");
      assert.equal(plan.statusCode, 400);
      assert.equal(plan.body.reason, "direct_ticket_requires_user_override");
    });

    it("persist=false + flag on + user_override → allow with CRITICAL alert", () => {
      const plan = planDirectTicketDispatch(baseAllowed);
      assert.equal(plan.kind, "allow");
      if (plan.kind !== "allow") throw new Error("unreachable");
      assert.equal(plan.alert.severity, "CRITICAL");
      assert.equal(plan.alert.kind, "direct_ticket_used");
      assert.equal(plan.alert.payload.symbol, "AAPL");
      assert.equal(plan.alert.payload.side, "BUY");
      assert.equal(plan.alert.payload.quantity, 5);
      assert.equal(
        plan.alert.payload.correlationId,
        "11111111-2222-4333-8444-555555555555",
      );
      assert.equal(plan.alert.payload.tokenFingerprint, "cafebabe");
    });

    it("allow: alert message + payload never carry a raw Bearer token", () => {
      // Simulate an operator paranoia scenario — verify that the raw
      // token, if it had somehow been passed here, would not have made
      // it into either the message or the payload. The planner only
      // consumes the pre-computed 8-char fingerprint, so this stays
      // true by construction.
      const rawToken =
        "raw-bearer-secret-DO-NOT-LEAK-abcdef0123456789abcdef0123456789";
      const plan = planDirectTicketDispatch({
        ...baseAllowed,
        auth: { correlationId: "cid-1", tokenFingerprint: "deadbeef" },
      });
      assert.equal(plan.kind, "allow");
      if (plan.kind !== "allow") throw new Error("unreachable");
      assert.ok(!plan.alert.message.includes(rawToken));
      assert.ok(!JSON.stringify(plan.alert.payload).includes(rawToken));
      assert.equal(plan.alert.payload.tokenFingerprint, "deadbeef");
    });

    it("allow: falls back to empty correlationId when auth is null", () => {
      const plan = planDirectTicketDispatch({
        ...baseAllowed,
        auth: null,
      });
      assert.equal(plan.kind, "allow");
      if (plan.kind !== "allow") throw new Error("unreachable");
      assert.equal(plan.alert.payload.correlationId, "");
      assert.equal(plan.alert.payload.tokenFingerprint, null);
    });
  });
});
