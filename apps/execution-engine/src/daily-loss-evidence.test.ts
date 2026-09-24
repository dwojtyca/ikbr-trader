import { test } from "node:test";
import assert from "node:assert/strict";
import { validateZeroDay } from "./daily-loss-evidence.js";
import { zeroDayFixture } from "./daily-loss-test-fixture.js";
for (const mode of ["valid", "no_run", "local_fill", "wrong_account", "wrong_session", "stale", "next_day", "window_short", "nonzero_pnl", "missing_usd", "base_only", "partial", "generation", "reconnect", "fill_race", "completed_fill", "bad_counts", "unknown_pnl", "future"] as const) test(`zero-day consumption evidence: ${mode}`, () => {
  const f = zeroDayFixture();
  if (mode === "no_run") f.rows.run = null as unknown as typeof f.run;
  if (mode === "local_fill") f.rows.local_count = 1;
  if (mode === "wrong_account") f.ctx.accountId = "OTHER";
  if (mode === "wrong_session") f.ctx.sessionId = "other";
  if (mode === "stale") f.ctx.now += 61000;
  if (mode === "next_day") f.ctx.now += 86400000;
  if (mode === "window_short") f.coverage.executions.window.from = new Date(f.ctx.now - 1000).toISOString();
  if (mode === "nonzero_pnl") f.accountSnapshot.riskEvidence!.realizedPnlByCurrency = { USD: -1 };
  if (mode === "missing_usd") f.accountSnapshot.riskEvidence!.realizedPnlByCurrency = {};
  if (mode === "base_only") f.accountSnapshot.riskEvidence!.realizedPnlByCurrency = { BASE: 0 };
  if (mode === "unknown_pnl") f.accountSnapshot.riskEvidence!.realizedPnlByCurrency = { USD: NaN };
  if (mode === "partial") f.coverage.positions.available = false;
  if (mode === "generation") f.sync.generation = "2";
  if (mode === "reconnect") f.ctx.connectionGeneration = 2;
  if (mode === "fill_race") f.ctx.lastBrokerFillObservedAt = f.ctx.now;
  if (mode === "completed_fill") { (f.snapshot.completedOrders as unknown[]).push({ filled: 1 }); f.coverage.completedOrders.count = 1; }
  if (mode === "bad_counts") f.coverage.executions.count = 1;
  if (mode === "future") f.accountSnapshot.riskEvidence!.completedAt = new Date(f.ctx.now + 10000).toISOString();
  assert.equal(validateZeroDay(f.rows, f.ctx).ok, mode === "valid");
});

import { evaluateZeroDay } from "./daily-loss-evidence.js";
for (const mode of ["success", "null", "failure", "fill", "reconnect", "account", "expiry", "nonempty", "still_mismatch"] as const) test(`production zero-day gate refresh and revalidation: ${mode}`, async () => {
  const f = zeroDayFixture(); f.sync.generation = "2"; let triggers = 0;
  if (mode === "nonempty") f.rows.local_count = 1;
  const result = await evaluateZeroDay({ context: () => f.ctx, read: async () => f.rows, refresh: async () => {
    triggers++;
    if (mode === "null") return false;
    if (mode === "failure") throw new Error("broker unavailable");
    if (mode !== "still_mismatch") f.run.position_generation = "2";
    if (mode === "fill") f.ctx.lastBrokerFillObservedAt = f.ctx.now;
    if (mode === "reconnect") f.ctx.connectionGeneration++;
    if (mode === "account") f.ctx.accountId = "OTHER";
    if (mode === "expiry") f.ctx.now += 61000;
    return true;
  } });
  assert.equal(result.ok, mode === "success"); assert.equal(triggers, mode === "nonempty" ? 0 : 1);
});
