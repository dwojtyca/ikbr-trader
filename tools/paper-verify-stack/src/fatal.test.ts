/**
 * PR15.1 — structural stderr redaction guarantee.
 *
 * The direct-entrypoint rejection handler in `index.ts` must
 * never emit the configured Bearer token or account IDs, even
 * when the rejected error was thrown by a code path that did
 * not go through `renderTable` / `renderJson`. `formatFatalError`
 * encapsulates that guarantee; these tests exercise it in
 * isolation so it survives independently of any live rejection
 * path.
 *
 * We deliberately use a synthetic, non-repository token here.
 * The real `EXECUTION_API_TOKEN` from the operator's `.env` is
 * never referenced.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFatalError } from "./index.js";

const FAKE_TOKEN = "fatal-test-fake-token-abcdef1234567890abcdef1234";
const FAKE_ACCOUNT = "DU9876543";

describe("formatFatalError — structural redaction", () => {
  it("redacts a raw token substring embedded in an unexpected error", () => {
    const err = new Error(
      `unexpected: request failed with authorization=Bearer ${FAKE_TOKEN}`,
    );
    const line = formatFatalError(err, FAKE_TOKEN);
    assert.equal(
      line.includes(FAKE_TOKEN),
      false,
      `token leaked: ${line}`,
    );
    assert.match(line, /\[REDACTED\]/);
    assert.match(line, /^paper-verify-stack: /);
  });

  it("redacts an account-ID substring embedded in an unexpected error", () => {
    const err = new Error(
      `unexpected: response for account ${FAKE_ACCOUNT} was malformed`,
    );
    const line = formatFatalError(err, FAKE_TOKEN);
    assert.equal(
      line.includes(FAKE_ACCOUNT),
      false,
      `account ID leaked: ${line}`,
    );
    assert.match(line, /DU-\*\*\*543/);
  });

  it("handles non-Error rejections without leaking the token", () => {
    // Simulate an unexpected string rejection (e.g. `throw
    // someString`) that still happens to embed the token.
    const line = formatFatalError(
      `raw string carrying ${FAKE_TOKEN} and ${FAKE_ACCOUNT}`,
      FAKE_TOKEN,
    );
    assert.equal(line.includes(FAKE_TOKEN), false);
    assert.equal(line.includes(FAKE_ACCOUNT), false);
    assert.match(line, /\[REDACTED\]/);
    assert.match(line, /DU-\*\*\*543/);
  });

  it("still produces a usable message when no token is configured", () => {
    const err = new Error("boot failed");
    const line = formatFatalError(err, undefined);
    assert.equal(line, "paper-verify-stack: boot failed");
  });

  it("does not accidentally match unrelated tokens as [REDACTED]", () => {
    const err = new Error("innocuous error with no secret");
    const line = formatFatalError(err, FAKE_TOKEN);
    assert.equal(line.includes("[REDACTED]"), false);
    assert.equal(line, "paper-verify-stack: innocuous error with no secret");
  });
});
