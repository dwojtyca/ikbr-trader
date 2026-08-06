/**
 * PR15.3 r3 (hostile-review Finding 1) — pure predicate tests for
 * the write-guard exemption list. These tests do NOT need Fastify;
 * they lock the closed exemption list against regressions before
 * we exercise the HTTP-level integration.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WRITE_GUARD_EXEMPT_ROUTES,
  isWriteGuardExempt,
} from "./write-guard-exemptions.js";

describe("isWriteGuardExempt — closed exemption list", () => {
  it("cancel-proposed/:id → exempt (risk-reducing broker cancel)", () => {
    assert.equal(
      isWriteGuardExempt("POST", "/execution/cancel-proposed/:id"),
      true,
    );
  });

  it("execute-ticket → NOT exempt (creates a new broker submission)", () => {
    assert.equal(
      isWriteGuardExempt("POST", "/execution/execute-ticket"),
      false,
    );
  });

  it("execute-proposed/:id → NOT exempt (creates a new broker submission)", () => {
    assert.equal(
      isWriteGuardExempt("POST", "/execution/execute-proposed/:id"),
      false,
    );
  });

  it("reject-proposed/:id → NOT exempt (does not reduce broker exposure)", () => {
    assert.equal(
      isWriteGuardExempt("POST", "/execution/reject-proposed/:id"),
      false,
    );
  });

  it("bootstrap → NOT exempt (opens a broker session)", () => {
    assert.equal(
      isWriteGuardExempt("POST", "/execution/bootstrap"),
      false,
    );
  });

  it("refresh-position-snapshot → NOT exempt (admin path stays guarded)", () => {
    assert.equal(
      isWriteGuardExempt("POST", "/execution/refresh-position-snapshot"),
      false,
    );
  });

  it("alerts/test → NOT exempt", () => {
    assert.equal(
      isWriteGuardExempt("POST", "/execution/alerts/test"),
      false,
    );
  });

  it("legacy POST /execution/reconciliation (no trailing slash) → NOT exempt", () => {
    // Historic top-level endpoint; only the *new* reconciliation
    // operator surface (`/execution/reconciliation/run` etc.) is
    // exempted.
    assert.equal(
      isWriteGuardExempt("POST", "/execution/reconciliation"),
      false,
    );
  });

  it("reconciliation/run → exempt (operator diagnostic path)", () => {
    assert.equal(
      isWriteGuardExempt("POST", "/execution/reconciliation/run"),
      true,
    );
  });

  it("reconciliation/holds/:id/acknowledge → exempt", () => {
    assert.equal(
      isWriteGuardExempt(
        "POST",
        "/execution/reconciliation/holds/:id/acknowledge",
      ),
      true,
    );
  });

  it("reconciliation/holds/:id/resolve → exempt (gated by secondary token)", () => {
    assert.equal(
      isWriteGuardExempt(
        "POST",
        "/execution/reconciliation/holds/:id/resolve",
      ),
      true,
    );
  });

  it("query string is stripped defensively before matching", () => {
    assert.equal(
      isWriteGuardExempt(
        "POST",
        "/execution/cancel-proposed/:id?trace=1",
      ),
      true,
    );
    // A distinct route that only differs by query MUST still not be
    // exempted.
    assert.equal(
      isWriteGuardExempt("POST", "/execution/execute-ticket?trace=1"),
      false,
    );
  });

  it("method matching is case-insensitive (Fastify normalises to upper)", () => {
    assert.equal(
      isWriteGuardExempt("post", "/execution/cancel-proposed/:id"),
      true,
    );
  });

  it("GET is never exempt via this path — read endpoints go through their own routing", () => {
    assert.equal(
      isWriteGuardExempt("GET", "/execution/cancel-proposed/:id"),
      false,
    );
  });

  it("missing route path (Fastify 404) → NOT exempt (fail-closed)", () => {
    assert.equal(isWriteGuardExempt("POST", undefined), false);
    assert.equal(isWriteGuardExempt("POST", ""), false);
  });

  it("no accidental prefix wildcards — a fabricated sub-path under an exempt prefix stays guarded", () => {
    // Regression against re-introducing the broad
    // `startsWith("/execution/reconciliation/")` exemption.
    assert.equal(
      isWriteGuardExempt("POST", "/execution/reconciliation/holds/:id/close"),
      false,
    );
    assert.equal(
      isWriteGuardExempt("POST", "/execution/reconciliation/anything-else"),
      false,
    );
  });

  it("closed list has exactly the four documented entries", () => {
    // Any addition here is a policy change; this test forces the
    // reviewer to update it together with the exemption list.
    assert.deepEqual(
      WRITE_GUARD_EXEMPT_ROUTES.map((e) => `${e.method} ${e.routePath}`).sort(),
      [
        "POST /execution/cancel-proposed/:id",
        "POST /execution/reconciliation/holds/:id/acknowledge",
        "POST /execution/reconciliation/holds/:id/resolve",
        "POST /execution/reconciliation/run",
      ],
    );
  });
});
