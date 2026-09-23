/**
 * PR15.3 — regression test for llm-agent claim isolation.
 *
 * The Phase 2 trading loop / `POST /execution/execute-ticket`
 * path persists `proposed_orders` rows with
 * `decision_source = 'user'`. The llm-agent EXECUTE/REJECT
 * consumer processes only legacy signal-engine rows
 * (`decision_source = 'signal'`); the two flows must remain
 * strictly isolated. This test verifies the SQL sent by
 * `claimNextProposed` contains the required WHERE clause
 * fragment so a future edit cannot silently regress the
 * filter.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Pool, QueryResult, QueryResultRow } from "pg";

import { LlmAgentRepository } from "./repository.js";

interface CapturedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function makeCapturingPool(): {
  readonly pool: Pool;
  readonly queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const pool = {
    async query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      // Return an empty result — the test only cares about the
      // SQL that was issued.
      return {
        rows: [],
        rowCount: 0,
        command: "SELECT",
        oid: 0,
        fields: [],
      } as unknown as QueryResult<QueryResultRow>;
    },
  } as unknown as Pool;
  return { pool, queries };
}

describe("LlmAgentRepository.claimNextProposed — PR15.3 isolation", () => {
  it("SQL WHERE clause restricts to decision_source = 'signal'", async () => {
    const { pool, queries } = makeCapturingPool();
    const repo = new LlmAgentRepository(pool);
    const claimed = await repo.claimNextProposed("worker-x", 60_000);
    assert.equal(claimed, null, "empty result → no claim returned");
    assert.equal(queries.length, 1);
    const sql = queries[0].text;
    assert.match(
      sql,
      /decision_source\s*=\s*'signal'/,
      "claim query MUST filter decision_source = 'signal' so Phase 2 execute-ticket rows (decision_source='user') stay isolated",
    );
    assert.match(sql, /instrument_id IS NULL/);
    assert.match(sql, /status\s*=\s*'PROPOSED'/);
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.deepEqual(queries[0].values, ["worker-x", 60_000]);
  });
});
