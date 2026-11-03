import assert from "node:assert/strict";
import { test } from "node:test";
import { researchUrlRejection, safeResearchUrl, type ResearchUrlRejection } from "./validation.js";

test("URL diagnostics preserve the existing acceptance and first failing predicate", () => {
  const cases: [unknown, ResearchUrlRejection | null][] = [
    [null, "string"], [123, "string"], [{ toString: () => { throw new Error("must not coerce"); } }, "string"],
    ["x".repeat(2001), "max_length"], ["https://sec.gov/" + "x".repeat(1984), null],
    ["https://sec.gov/" + "x".repeat(1985), "max_length"], ["not a URL", "parse"], ["https://[", "parse"],
    ["http://user:password@127.0.0.1:8080/#secret", "https"], ["file:///private", "https"],
    ["https://user@sec.gov/#secret", "credentials"], ["https://:password@sec.gov/", "credentials"],
    ["https://sec.gov:8443/#secret", "fragment"], ["https://127.0.0.1:8443/", "port"],
    ["https://127.0.0.1/", "ip_host"], ["https://[::1]/", "ip_host"], ["https://2130706433/", "ip_host"],
    ["https://0x7f000001/", "ip_host"], ["https://localhost/", "domain_syntax"],
    ["https://sec.gov./", "domain_syntax"], ["https://host.xn--p1ai/", "domain_syntax"],
    ["https://a_b.gov/", "domain_syntax"], ["https://host.localhost/", "reserved_host"],
    ...["local", "internal", "test", "invalid", "example"].map(tld => [`https://host.${tld}/`, "reserved_host"] as [string, ResearchUrlRejection]),
    ["https://sec.gov/", null], ["HTTPS://SEC.GOV:443/a", null], ["https://sec.gov/#", null],
    [" https://sec.gov/\n", null], ["https://séc.gov/", null], ["https://sec.gov/?api_token=synthetic-secret", null],
    ["https://sec..gov/", null], ["https://sec.gov/path\tpart", null],
  ];
  for (const [value, reason] of cases) {
    assert.equal(researchUrlRejection(value), reason);
    assert.equal(safeResearchUrl(value), reason === null);
  }
});
