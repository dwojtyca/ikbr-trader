import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRedactor, maskAccountId } from "./mask.js";

describe("mask", () => {
  it("masks paper account IDs", () => {
    assert.equal(maskAccountId("DU1234567"), "DU-***567");
  });

  it("masks live account IDs (U prefix)", () => {
    assert.equal(maskAccountId("U12345678"), "U-***678");
  });

  it("leaves unrelated text untouched", () => {
    assert.equal(maskAccountId("hello world"), "hello world");
  });

  it("redacts the bearer token verbatim", () => {
    const r = createRedactor("super-secret-token-value-1234");
    const out = r("token=super-secret-token-value-1234 and DU9876543");
    assert.equal(out.includes("super-secret-token-value-1234"), false);
    assert.match(out, /\[REDACTED\]/);
    assert.match(out, /DU-\*\*\*543/);
  });

  it("no-op redactor when token is undefined", () => {
    const r = createRedactor(undefined);
    assert.equal(r("nothing to redact"), "nothing to redact");
  });
});
