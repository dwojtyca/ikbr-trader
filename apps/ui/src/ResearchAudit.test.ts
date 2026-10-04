import test from "node:test";
import assert from "node:assert/strict";
import { safeAuditUrl } from "./ResearchAudit.js";

test("research source links require plain public HTTPS URLs", () => {
  assert.equal(safeAuditUrl("https://www.sec.gov/filing"), "https://www.sec.gov/filing");
  for (const value of ["javascript:alert(1)", "http://www.sec.gov/filing", "https://user@www.sec.gov/filing", "https://www.sec.gov/filing#anchor", "https://127.0.0.1/private", "https://service.local/private"]) assert.equal(safeAuditUrl(value), null, value);
});
