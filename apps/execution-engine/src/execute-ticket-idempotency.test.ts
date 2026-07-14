import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideIdempotency,
  type IdempotencyExistingRecord,
} from "./execute-ticket-idempotency.js";

function existing(
  overrides: Partial<IdempotencyExistingRecord> = {},
): IdempotencyExistingRecord {
  return {
    clientOrderHash: "abc",
    status: "PROPOSED",
    executionAttemptedAt: undefined,
    brokerOrderId: undefined,
    ...overrides,
  };
}

describe("decideIdempotency — no existing row", () => {
  it("no existing row → insert (fresh order path)", () => {
    const decision = decideIdempotency({
      existing: null,
      incomingHash: "abc",
    });
    assert.equal(decision.kind, "insert");
  });
});

describe("decideIdempotency — hash mismatch or missing", () => {
  it("mismatched hash → conflict, regardless of status", () => {
    for (const status of [
      "PROPOSED",
      "SUBMITTED",
      "FILLED",
      "REJECTED",
      "CANCELLED",
      "SUPERSEDED",
      "EXPIRED",
    ] as const) {
      const decision = decideIdempotency({
        existing: existing({ status, clientOrderHash: "abc" }),
        incomingHash: "xyz",
      });
      assert.equal(
        decision.kind,
        "conflict",
        `status=${status} mismatch must be conflict`,
      );
    }
  });

  it("stored hash NULL (pre-PR13 legacy row) → conflict — never blind-replay", () => {
    const decision = decideIdempotency({
      existing: existing({ clientOrderHash: null, status: "SUBMITTED" }),
      incomingHash: "abc",
    });
    assert.equal(decision.kind, "conflict");
  });
});

describe("decideIdempotency — matching hash, terminal-with-broker", () => {
  it("SUBMITTED → duplicate_replay (broker already got the order)", () => {
    const decision = decideIdempotency({
      existing: existing({ status: "SUBMITTED", brokerOrderId: "b-1" }),
      incomingHash: "abc",
    });
    assert.equal(decision.kind, "duplicate_replay");
  });

  it("FILLED → duplicate_replay", () => {
    const decision = decideIdempotency({
      existing: existing({ status: "FILLED", brokerOrderId: "b-1" }),
      incomingHash: "abc",
    });
    assert.equal(decision.kind, "duplicate_replay");
  });
});

describe("decideIdempotency — matching hash, terminal-without-submit", () => {
  for (const status of [
    "REJECTED",
    "CANCELLED",
    "SUPERSEDED",
    "EXPIRED",
  ] as const) {
    it(`${status} → duplicate_terminal (never re-submit under the same clientOrderId)`, () => {
      const decision = decideIdempotency({
        existing: existing({ status }),
        incomingHash: "abc",
      });
      assert.equal(decision.kind, "duplicate_terminal");
    });
  }
});

describe("decideIdempotency — matching hash, PROPOSED variants", () => {
  it("PROPOSED with executionAttemptedAt → duplicate_replay (ambiguous — do not resume)", () => {
    const decision = decideIdempotency({
      existing: existing({
        status: "PROPOSED",
        executionAttemptedAt: new Date("2026-07-14T12:00:00Z"),
      }),
      incomingHash: "abc",
    });
    assert.equal(decision.kind, "duplicate_replay");
  });

  it("PROPOSED with brokerOrderId (attempt reached broker in a prior process) → duplicate_replay", () => {
    const decision = decideIdempotency({
      existing: existing({
        status: "PROPOSED",
        brokerOrderId: "b-orphan",
      }),
      incomingHash: "abc",
    });
    assert.equal(decision.kind, "duplicate_replay");
  });

  it("PROPOSED, no executionAttemptedAt, no brokerOrderId → resume (safe re-drive)", () => {
    // This is the orphan-crash case: INSERT succeeded and the
    // process crashed before markExecutionAttempt. Retry MUST
    // re-run executePersistedOrder on the same row so the broker
    // actually receives the order exactly once.
    const decision = decideIdempotency({
      existing: existing({
        status: "PROPOSED",
        executionAttemptedAt: undefined,
        brokerOrderId: undefined,
      }),
      incomingHash: "abc",
    });
    assert.equal(decision.kind, "resume");
  });
});
