import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIbExecutionTime } from "./execution-time.js";
import { buildExecutionConfig } from "./config.js";

for (const [raw, expected] of [
  ["20260924  15:30:21", "2026-09-24T13:30:21.000Z"],
  ["20260115 15:30:21", "2026-01-15T14:30:21.000Z"],
  ["20240229 12:00:00", "2024-02-29T11:00:00.000Z"],
  ["20260329 01:59:59", "2026-03-29T00:59:59.000Z"],
  ["20260329 03:00:00", "2026-03-29T01:00:00.000Z"],
  ["20261025 01:59:59", "2026-10-24T23:59:59.000Z"],
  ["20261025 03:00:00", "2026-10-25T02:00:00.000Z"],
  ["20000101 00:00:00", "1999-12-31T23:00:00.000Z"],
  ["21001231 23:59:59", "2100-12-31T22:59:59.000Z"],
]) test(`Warsaw execution time ${raw}`, () => {
  assert.equal(parseIbExecutionTime(raw, "Europe/Warsaw")?.toISOString(), expected);
  assert.equal(parseIbExecutionTime(raw), null);
});
for (const raw of ["", "bad", "20260230 12:00:00", "20260924 24:00:00", "20260924 12:60:00",
  "20260924 12:00:60", "20260001 12:00:00", "19991231 12:00:00", "21010101 12:00:00",
  "20260329 02:30:00", "20261025 02:30:00", "20260924 12:00:00 Europe/Warsaw",
  "20260924 12:00:00 US/Eastern", "20260924 12:00:00 UTC trailing", "20260924\t12:00:00"])
  test(`refuse invalid/ambiguous time ${raw}`, () => assert.equal(parseIbExecutionTime(raw, "Europe/Warsaw"), null));
for (const suffix of ["UTC", "GMT"]) test(`explicit ${suffix} overrides configuration`, () => {
  assert.equal(parseIbExecutionTime(`20261025  02:30:00 ${suffix}`, "Europe/Warsaw")?.toISOString(), "2026-10-25T02:30:00.000Z");
});
test("UTC bare behavior remains explicit", () => {
  assert.equal(parseIbExecutionTime("20260924  15:30:21", "UTC")?.toISOString(), "2026-09-24T15:30:21.000Z");
});
test("timezone config allows only explicit supported values", () => {
  for (const value of [undefined, "", "UTC", "Europe/Warsaw"]) assert.equal(buildExecutionConfig({EXECUTION_BROKER_TIME_ZONE:value}).EXECUTION_BROKER_TIME_ZONE, value || undefined);
  for (const value of ["Europe/London", "Poland", "CET", "utc", " "]) assert.throws(() => buildExecutionConfig({EXECUTION_BROKER_TIME_ZONE:value}));
});
