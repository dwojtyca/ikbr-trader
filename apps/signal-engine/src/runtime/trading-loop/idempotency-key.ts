/**
 * Trading Loop — deterministic idempotency-key builder (v4).
 *
 * The `clientOrderId` identifies the TRADE TRIGGER; a separate
 * `clientOrderHash` identifies the trade PAYLOAD. Splitting them
 * is what lets execution-engine surface a legitimate CONFLICT
 * when the same trigger is re-evaluated with a changed ticket —
 * if the payload were baked into the client order id, the
 * changed payload would slip in under a fresh id and bypass
 * `duplicate_terminal` / conflict handling.
 *
 * ## Format
 *
 *     loop:v4:<instrumentId>:<strategyId>:<triggerId>
 *
 * where `triggerId` is a deterministic label of the underlying
 * trade trigger — see `deriveTriggerIdentity` in
 * `trading-loop-service.ts`. In PR14 the trigger is derived from
 * the strategy's evaluation bucket
 * (`evaluation.<timeframe>.<bucketStartMs>`); once ingestion
 * emits real candle-close events the label will change but the
 * key shape stays the same.
 *
 * ## Guarantees
 *
 *   - same trigger + same ticket        → same `clientOrderId`,
 *     same `clientOrderHash` → `DUPLICATE`
 *   - same trigger + changed ticket     → SAME `clientOrderId`,
 *     different `clientOrderHash` → `CONFLICT` (blocks the
 *     modified attempt exactly as intended)
 *   - new trigger + identical ticket    → NEW `clientOrderId`,
 *     same hash → new submission subject to the exposure /
 *     position guards downstream
 *   - UNKNOWN retry for the same trigger → same `clientOrderId`
 *   - process restart on the same trigger → same `clientOrderId`
 *
 * ## v3 → v4 migration
 *
 * v3 (`loop:v3:<id>:<intentHash>`) collapsed payload into the
 * id — historic FILLED / REJECTED with the same order shape
 * shadowed new triggers. v4 removes the payload from the id
 * entirely; the payload lives exclusively in `clientOrderHash`
 * so the CONFLICT signal remains available.
 */

export interface TradingLoopIdempotencyKeyBuilderOptions {
  /**
   * Format version. A bump invalidates every previously issued
   * key — DUPLICATE / RESUMED lookups for older keys will miss.
   */
  readonly version?: string;
}

export interface TradingLoopIdempotencyKeyInput {
  readonly instrumentId: string;
  readonly strategyId: string;
  readonly triggerId: string;
}

const KEY_FIELD_ALLOWED = /^[A-Za-z0-9._\-]+$/;

export class TradingLoopIdempotencyKeyBuilder {
  readonly #version: string;

  constructor(options: TradingLoopIdempotencyKeyBuilderOptions = {}) {
    this.#version = options.version ?? "v4";
  }

  build(input: TradingLoopIdempotencyKeyInput): string {
    requireField("instrumentId", input.instrumentId);
    requireField("strategyId", input.strategyId);
    requireField("triggerId", input.triggerId);
    return `loop:${this.#version}:${input.instrumentId}:${input.strategyId}:${input.triggerId}`;
  }
}

function requireField(name: string, value: string): void {
  if (!value) {
    throw new Error(
      `TradingLoopIdempotencyKeyBuilder: ${name} must be non-empty`,
    );
  }
  if (!KEY_FIELD_ALLOWED.test(value)) {
    throw new Error(
      `TradingLoopIdempotencyKeyBuilder: ${name} must match ${KEY_FIELD_ALLOWED} (got: ${value})`,
    );
  }
}
