import test from "node:test";
import assert from "node:assert/strict";
import { buildExecutionConfig } from "./config.js";

test("configuration metadata socket defaults to a distinct client id", () => {
  assert.equal(buildExecutionConfig({}).IB_CONFIG_METADATA_CLIENT_ID, 155);
});
test("configuration metadata socket rejects every existing broker client collision", () => {
  for (const [key, value] of Object.entries({ EXECUTION_CLIENT_ID: 102, INGESTION_CLIENT_ID: 101,
    BACKTEST_INGESTION_CLIENT_ID: 104, IBKR_ES_ACQUISITION_CLIENT_ID: 91551, IB_METADATA_CLIENT_ID: 119,
    IB_COMPLETED_ORDERS_CLIENT_ID: 120, SESSION_SCHEDULE_CLIENT_ID: 154 })) {
    assert.throws(() => buildExecutionConfig({ [key]: String(value), IB_CONFIG_METADATA_CLIENT_ID: String(value) }), /IB_CONFIG_METADATA_CLIENT_ID must differ/);
  }
  assert.throws(() => buildExecutionConfig({ IB_CONFIG_METADATA_CLIENT_ID: "91551" }), /IB_CONFIG_METADATA_CLIENT_ID must differ/);
});
