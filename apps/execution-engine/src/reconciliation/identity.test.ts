/**
 * PR15 — canonical identity tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canonicaliseIdentity,
  IDENTITY_AMBIGUOUS_KEY,
} from "./identity.js";

describe("canonicaliseIdentity", () => {
  it("uses the conid path when both sides expose conId + accountId", () => {
    const id = canonicaliseIdentity({
      accountId: "DU-1",
      conId: "123",
      symbol: "AAPL",
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
    });
    assert.equal(id.identityKey, "conid:DU-1|123");
    assert.equal(id.ambiguous, false);
  });

  it("falls back to full symbol+secType+exchange+currency tuple when conId is missing", () => {
    const id = canonicaliseIdentity({
      accountId: "DU-1",
      symbol: "AAPL",
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
    });
    assert.equal(id.identityKey, "sym:DU-1|aapl|stk|smart|usd");
  });

  it("two identical-symbol futures on different exchanges have DIFFERENT keys (no conId path)", () => {
    const a = canonicaliseIdentity({
      accountId: "DU-1",
      symbol: "ES",
      secType: "FUT",
      exchange: "CME",
      currency: "USD",
    });
    const b = canonicaliseIdentity({
      accountId: "DU-1",
      symbol: "ES",
      secType: "FUT",
      exchange: "EUREX",
      currency: "USD",
    });
    assert.notEqual(a.identityKey, b.identityKey);
  });

  it("two identical-symbol futures with DIFFERENT conIds have different keys", () => {
    const front = canonicaliseIdentity({
      accountId: "DU-1",
      conId: "111",
      symbol: "ES",
    });
    const back = canonicaliseIdentity({
      accountId: "DU-1",
      conId: "222",
      symbol: "ES",
    });
    assert.notEqual(front.identityKey, back.identityKey);
  });

  it("missing accountId classifies as ambiguous — never aggregated across accounts", () => {
    const id = canonicaliseIdentity({
      accountId: undefined,
      symbol: "AAPL",
      conId: "123",
    });
    assert.equal(id.ambiguous, true);
    assert.equal(id.identityKey, IDENTITY_AMBIGUOUS_KEY);
  });

  it("normalises symbol/secType/exchange/currency to lowercase and trims", () => {
    const id = canonicaliseIdentity({
      accountId: "DU-1",
      symbol: "  aapl  ",
      secType: " stk ",
      exchange: " SMART ",
      currency: " usd ",
    });
    assert.equal(id.identityKey, "sym:DU-1|aapl|stk|smart|usd");
  });
});
