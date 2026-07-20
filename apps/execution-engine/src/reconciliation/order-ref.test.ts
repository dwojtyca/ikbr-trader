/**
 * PR15 — order-ref derivation tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveChildOrderRef,
  deriveOrderRefForLeg,
  deriveParentOrderRef,
  ORDER_REF_MAX_LEN,
  ORDER_REF_PREFIX,
} from "./order-ref.js";

describe("orderRef derivation", () => {
  it("parent ref is deterministic, starts with 'co-', and is ≤ 20 chars", () => {
    const cid = "7c3d2e78-2b41-4c99-a3e0-88ea6f7c1234";
    const a = deriveParentOrderRef(cid);
    const b = deriveParentOrderRef(cid);
    assert.equal(a, b);
    assert.ok(a.startsWith(ORDER_REF_PREFIX));
    assert.ok(a.length <= ORDER_REF_MAX_LEN);
    assert.equal(a.length, 3 + 12);
  });

  it("parent ref NEVER contains the raw clientOrderId", () => {
    const cid = "raw-secret-uuid-please-do-not-leak-abcdef";
    const ref = deriveParentOrderRef(cid);
    assert.ok(!ref.includes("raw"));
    assert.ok(!ref.includes("secret"));
    assert.ok(!ref.includes(cid));
  });

  it("different clientOrderIds produce different refs", () => {
    const a = deriveParentOrderRef("client-a");
    const b = deriveParentOrderRef("client-b");
    assert.notEqual(a, b);
  });

  it("child refs carry role suffix and stay ≤ 20 chars", () => {
    const cid = "7c3d2e78-2b41-4c99-a3e0-88ea6f7c1234";
    const tp1 = deriveChildOrderRef(cid, { role: "TP", ordinal: 1 });
    const sl = deriveChildOrderRef(cid, { role: "SL", ordinal: 0 });
    const tp2 = deriveChildOrderRef(cid, { role: "TP", ordinal: 2 });
    for (const ref of [tp1, sl, tp2]) {
      assert.ok(ref.startsWith(ORDER_REF_PREFIX));
      assert.ok(ref.length <= ORDER_REF_MAX_LEN);
    }
    assert.ok(tp1.endsWith("-tp1"));
    assert.ok(sl.endsWith("-sl0"));
    assert.ok(tp2.endsWith("-tp2"));
    assert.notEqual(tp1, tp2);
    assert.notEqual(tp1, sl);
  });

  it("child ref shares the parent's leading hash prefix (child = 10 chars, parent = 12 chars, first 10 identical)", () => {
    const cid = "same-hash-basis-uuid";
    const parent = deriveParentOrderRef(cid); // "co-" + 12
    const child = deriveChildOrderRef(cid, { role: "TP", ordinal: 1 }); // "co-" + 10 + "-tp1"
    const parentBody = parent.slice(3);
    const childBody = child.slice(3, 3 + 10);
    assert.equal(parentBody.slice(0, 10), childBody);
  });

  it("deriveOrderRefForLeg dispatches to parent/child", () => {
    const cid = "any";
    assert.equal(
      deriveOrderRefForLeg(cid, { role: "PARENT", ordinal: 0 }),
      deriveParentOrderRef(cid),
    );
    assert.equal(
      deriveOrderRefForLeg(cid, { role: "TP", ordinal: 3 }),
      deriveChildOrderRef(cid, { role: "TP", ordinal: 3 }),
    );
  });

  it("empty clientOrderId is rejected", () => {
    assert.throws(() => deriveParentOrderRef(""));
    // @ts-expect-error — runtime guard
    assert.throws(() => deriveParentOrderRef(null));
  });
});
