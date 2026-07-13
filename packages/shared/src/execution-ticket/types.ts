/**
 * Execution Ticket — type definitions.
 *
 * The Execution Ticket Builder turns a `SignalEvaluation` with
 * `status === "GENERATED"` into an immutable `ExecutionTicket`.
 * The ticket is a broker-ready **intent**: it fully describes an
 * order (side, quantity, prices, protection legs) but is NOT itself
 * sent to any broker. Downstream services (`execution-engine`) are
 * responsible for translation into a specific broker's contract /
 * order objects.
 *
 * Boundaries:
 *   - Pure, synchronous, deterministic. No I/O, no randomness (id
 *     factories are injected), no HTTP, no persistence.
 *   - `MKT` is intentionally NOT in `SupportedOrderType` — the
 *     roadmap requires an explicit price envelope for every order.
 *   - The builder never throws for bad domain data. Every failure
 *     surfaces as a `TicketBlocker` in the discriminated result.
 */

import type { DecisionResult } from "../decision-engine/types.js";
import type { Instrument, QuantityUnit } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import type { RiskEvaluation } from "../risk-engine/types.js";
import type { SignalEvaluation } from "../signal-engine/types.js";

export type OrderSide = "BUY" | "SELL";

/** Order types this PR supports. `MKT` is intentionally excluded. */
export type SupportedOrderType = "LMT" | "STP" | "STP_LMT";

export type TimeInForce = "DAY" | "GTC";

/**
 * Rounding mode for tick alignment. Applied uniformly to every
 * computed price on the ticket (entry, stopLoss, takeProfit,
 * stopPrice, limitPrice).
 *
 * - `nearest` — bankers' rounding to the closest tick.
 * - `up`      — always rounds up to the next tick.
 * - `down`    — always rounds down to the previous tick.
 */
export type PriceRoundingMode = "nearest" | "up" | "down";

/**
 * Every enumerated failure the builder can raise. Any blocker (any
 * code, any count) turns the result into `{ ok: false }`. `UNKNOWN`
 * is a catch-all for unexpected error paths and is not currently
 * emitted by the builder — reserved for future rules.
 */
export type TicketBlockerCode =
  | "SIGNAL_NOT_GENERATED"
  | "DECISION_MISSING"
  | "RISK_MISSING"
  | "RISK_NOT_APPROVED"
  | "NON_DIRECTIONAL_DECISION"
  | "INSTRUMENT_MISMATCH"
  | "INSTRUMENT_DISABLED"
  | "PRICE_MISSING"
  | "PRICE_NOT_FRESH"
  | "INVALID_QUANTITY"
  | "QUANTITY_LIMIT_EXCEEDED"
  | "INVALID_TICK_SIZE"
  | "INVALID_ORDER_CONFIGURATION"
  | "INVALID_PROTECTION_LEVELS"
  | "UNSUPPORTED_ORDER_TYPE"
  | "UNKNOWN";

export type TicketWarningCode =
  | "PRICE_SOURCE_FALLBACK"
  | "PROTECTION_ROUNDED";

export type TicketDiagnosticSource =
  | "signal"
  | "instrument"
  | "snapshot"
  | "policy"
  | "pricing"
  | "builder";

export interface TicketBlocker {
  readonly code: TicketBlockerCode;
  readonly message: string;
  readonly source: TicketDiagnosticSource;
}

export interface TicketWarning {
  readonly code: TicketWarningCode | string;
  readonly message: string;
  readonly source: TicketDiagnosticSource;
}

/**
 * Order envelope. Every price already respects the policy's tick
 * size and rounding mode. Fields that a given `orderType` does not
 * use are `undefined`, not zero.
 */
export interface ExecutionTicketOrder {
  readonly side: OrderSide;
  readonly quantity: number;
  readonly quantityUnit: QuantityUnit;
  readonly orderType: SupportedOrderType;
  readonly limitPrice?: number;
  readonly stopPrice?: number;
  readonly timeInForce: TimeInForce;
  readonly outsideRth: boolean;
  readonly transmit: boolean;
}

/**
 * Protection legs. `bracketEnabled` is `true` iff at least one of
 * `stopLoss` / `takeProfit` is present — a trailing stop alone does
 * not constitute a bracket in this PR.
 */
export interface ExecutionTicketProtection {
  readonly stopLoss?: number;
  readonly takeProfit?: number;
  readonly trailingStop?: number;
  readonly bracketEnabled: boolean;
}

export interface ExecutionTicketMetadata {
  readonly signalEngineVersion: string;
  readonly decisionEngineVersion: string;
  readonly riskEngineVersion: string;
  readonly builderVersion: string;
  readonly correlationId: string;
}

/**
 * Immutable, broker-agnostic execution intent. Deep-frozen by the
 * builder before being returned. Neither the builder nor this type
 * commits to a specific broker API — that translation lives in
 * `execution-engine`.
 */
export interface ExecutionTicket {
  readonly ticketId: string;
  readonly createdAt: Date;
  readonly signalId: string;
  readonly decisionId: string;
  readonly instrumentId: string;
  readonly broker: Instrument["broker"];
  readonly brokerSymbol: string;
  readonly exchange: string;
  readonly currency: string;
  readonly conId?: number;
  readonly localSymbol?: string;
  readonly tradingClass?: string;
  readonly order: ExecutionTicketOrder;
  readonly protection: ExecutionTicketProtection;
  readonly metadata: ExecutionTicketMetadata;
}

/**
 * Policy carries every tunable the builder needs. Kept as a plain
 * value object so callers (signal-engine app, backtest-engine,
 * tests) can supply it per-strategy without a global config
 * dependency. The shared package MUST NOT read `process.env`.
 */
export interface ExecutionTicketPolicy {
  readonly quantity: number;
  readonly orderType: SupportedOrderType;
  readonly timeInForce: TimeInForce;
  readonly outsideRth: boolean;
  readonly transmit: boolean;
  /**
   * Absolute price offset applied to the raw base price
   * (ask for BUY, bid for SELL, or `last` on fallback) to shape the
   * entry limit price. Positive values push the limit further into
   * the book (more aggressive): BUY → `base + offset`, SELL →
   * `base - offset`. `undefined` is treated as `0`.
   */
  readonly entryOffset?: number;
  /** Non-negative distance from entry to stop-loss. `undefined` = no stop-loss. */
  readonly stopLossDistance?: number;
  /** Non-negative distance from entry to take-profit. `undefined` = no take-profit. */
  readonly takeProfitDistance?: number;
  /** Non-negative trailing distance carried onto `protection.trailingStop`. */
  readonly trailingStopDistance?: number;
  /** Broker minimum tick. Must be > 0. */
  readonly priceTickSize: number;
  readonly priceRoundingMode: PriceRoundingMode;
}

export interface ExecutionTicketBuildInput {
  readonly signal: SignalEvaluation;
  readonly snapshot: MarketContextSnapshot;
  readonly instrument: Instrument;
  readonly policy: ExecutionTicketPolicy;
}

export type ExecutionTicketBuildResult =
  | {
      readonly ok: true;
      readonly ticket: ExecutionTicket;
      readonly warnings: readonly TicketWarning[];
    }
  | {
      readonly ok: false;
      readonly ticket: null;
      readonly blockers: readonly TicketBlocker[];
      readonly warnings: readonly TicketWarning[];
    };
