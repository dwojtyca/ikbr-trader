import type { Pool } from "pg";
import type { BrokerExecutionFill } from "./tws-execution-client.js";

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function side(value: unknown): "BUY" | "SELL" | null {
  if (value === "BUY" || value === "BOT") return "BUY";
  if (value === "SELL" || value === "SLD") return "SELL";
  return null;
}

/**
 * Historical execDetails replays do not change exposure when the exact fill is already durable.
 * Execution time is validated by snapshot ownership; it does not alter this exposure identity.
 */
export async function shouldInvalidateExecutionFill(
  pool: Pick<Pool, "query">,
  fill: BrokerExecutionFill,
): Promise<boolean> {
  if (!nonempty(fill.execId) || !nonempty(fill.accountId) || !nonempty(fill.conid) ||
      !nonempty(fill.symbol) || !Number.isSafeInteger(fill.orderId) || (fill.orderId ?? 0) <= 0 ||
      positiveNumber(fill.shares) === null || positiveNumber(fill.price) === null || side(fill.side) === null) return true;

  const result = await pool.query(
    `SELECT exec_id, account_id, conid, broker_order_id, symbol, side, shares, price
     FROM broker_execution_fills WHERE exec_id = $1`,
    [fill.execId],
  ).catch(() => null);
  if (!result || result.rows.length !== 1) return true;
  const row = result.rows[0] as Record<string, unknown>;
  return row.exec_id !== fill.execId || !nonempty(row.account_id) || row.account_id !== fill.accountId ||
    !nonempty(row.conid) || row.conid !== fill.conid ||
    !nonempty(row.broker_order_id) || row.broker_order_id !== String(fill.orderId) ||
    !nonempty(row.symbol) || row.symbol !== fill.symbol || side(row.side) !== side(fill.side) ||
    positiveNumber(row.shares) !== fill.shares || positiveNumber(row.price) !== fill.price;
}
