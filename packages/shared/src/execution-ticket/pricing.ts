import type {
  ExecutionTicketPolicy,
  OrderSide,
  PriceRoundingMode,
  SupportedOrderType,
  TicketBlocker,
  TicketWarning,
} from "./types.js";
import type { PriceSectionData } from "../market-context/types.js";

/**
 * Deterministic tick rounding. `tickSize` must be `> 0` — the caller
 * is expected to have run `validatePolicy` first. Returns a finite
 * number rounded to the nearest multiple of `tickSize` under `mode`:
 *
 *   - `nearest` — JavaScript `Math.round` semantics (round-half-up
 *     for positive values, round-half-toward-`+Infinity`). This is
 *     NOT bankers' rounding; the difference is only observable on
 *     exact half-tick values.
 *   - `up`      — always ceils to the next tick.
 *   - `down`    — always floors to the previous tick.
 *
 * Uses integer arithmetic on a scaled representation to sidestep
 * classic FP artefacts (`0.1 + 0.2` etc.). If the caller has passed
 * a non-finite price we return `Number.NaN` — validation upstream
 * will convert that into a blocker.
 */
export function roundToTick(
  price: number,
  tickSize: number,
  mode: PriceRoundingMode,
): number {
  if (!Number.isFinite(price)) return Number.NaN;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return Number.NaN;

  const scale = deriveScale(tickSize);
  const scaledPrice = Math.round(price * scale);
  const scaledTick = Math.round(tickSize * scale);
  const ticks = scaledPrice / scaledTick;

  let picked: number;
  switch (mode) {
    case "up":
      picked = Math.ceil(ticks);
      break;
    case "down":
      picked = Math.floor(ticks);
      break;
    case "nearest":
    default:
      picked = Math.round(ticks);
      break;
  }
  return (picked * scaledTick) / scale;
}

function deriveScale(tickSize: number): number {
  // Enough decimal precision for typical broker ticks (0.25, 0.01,
  // 0.0001) without pathological blow-up on odd fractions.
  const digits = Math.max(0, Math.min(10, decimalDigits(tickSize)));
  return Math.pow(10, digits);
}

function decimalDigits(value: number): number {
  const str = value.toString();
  const dot = str.indexOf(".");
  if (dot === -1) return 0;
  const frac = str.slice(dot + 1);
  const e = frac.toLowerCase().indexOf("e");
  return e === -1 ? frac.length : Number.parseInt(frac.slice(e + 1), 10) || 0;
}

/**
 * Base price the entry limit is built from. BUY prefers `ask` and
 * falls back to `last`; SELL prefers `bid` and falls back to
 * `last`. A fallback emits a `PRICE_SOURCE_FALLBACK` warning so
 * operators can see the ticket was not priced off the top-of-book.
 */
export function pickBasePrice(
  side: OrderSide,
  price: PriceSectionData,
): {
  readonly base: number | null;
  readonly source: "ask" | "bid" | "last";
  readonly fellBack: boolean;
} {
  if (side === "BUY") {
    if (isPositiveFinite(price.ask)) {
      return { base: price.ask, source: "ask", fellBack: false };
    }
    return {
      base: isPositiveFinite(price.last) ? price.last : null,
      source: "last",
      fellBack: true,
    };
  }
  if (isPositiveFinite(price.bid)) {
    return { base: price.bid, source: "bid", fellBack: false };
  }
  return {
    base: isPositiveFinite(price.last) ? price.last : null,
    source: "last",
    fellBack: true,
  };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export interface EntryPriceResult {
  readonly entry: number | null;
  readonly warnings: readonly TicketWarning[];
  readonly blockers: readonly TicketBlocker[];
}

/**
 * Compute the rounded entry price. Delegates to `pickBasePrice`
 * then applies `entryOffset` (BUY: `+`; SELL: `-`) and the
 * policy's rounding mode.
 */
export function computeEntryPrice(
  side: OrderSide,
  price: PriceSectionData,
  policy: ExecutionTicketPolicy,
): EntryPriceResult {
  const warnings: TicketWarning[] = [];
  const picked = pickBasePrice(side, price);
  if (picked.base === null) {
    return {
      entry: null,
      warnings,
      blockers: [
        {
          code: "PRICE_MISSING",
          message: `no usable ${side === "BUY" ? "ask/last" : "bid/last"} on snapshot`,
          source: "snapshot",
        },
      ],
    };
  }
  if (picked.fellBack) {
    warnings.push({
      code: "PRICE_SOURCE_FALLBACK",
      message: `no ${side === "BUY" ? "ask" : "bid"} on snapshot; using last`,
      source: "pricing",
    });
  }
  const offset = policy.entryOffset ?? 0;
  const raw = side === "BUY" ? picked.base + offset : picked.base - offset;
  const rounded = roundToTick(raw, policy.priceTickSize, policy.priceRoundingMode);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    return {
      entry: null,
      warnings,
      blockers: [
        {
          code: "INVALID_ORDER_CONFIGURATION",
          message: `computed entry price ${rounded} is not a positive finite number`,
          source: "pricing",
        },
      ],
    };
  }
  return { entry: rounded, warnings, blockers: [] };
}

export interface ProtectionResult {
  readonly stopLoss?: number;
  readonly takeProfit?: number;
  readonly trailingStop?: number;
  readonly warnings: readonly TicketWarning[];
  readonly blockers: readonly TicketBlocker[];
}

/**
 * Compute protection legs from the rounded entry. Distances are
 * absolute and always non-negative; a negative distance is a
 * blocker rather than being silently absolutized.
 *
 * Direction convention:
 *   BUY  → stopLoss  = entry - stopLossDistance
 *          takeProfit = entry + takeProfitDistance
 *   SELL → stopLoss  = entry + stopLossDistance
 *          takeProfit = entry - takeProfitDistance
 *
 * `trailingStopDistance` is carried as-is onto `protection.trailingStop`
 * (broker-relative distance, not a computed price).
 */
export function computeProtection(
  side: OrderSide,
  entry: number,
  policy: ExecutionTicketPolicy,
): ProtectionResult {
  const warnings: TicketWarning[] = [];
  const blockers: TicketBlocker[] = [];

  const {
    stopLossDistance,
    takeProfitDistance,
    trailingStopDistance,
    priceTickSize,
    priceRoundingMode,
  } = policy;

  if (stopLossDistance !== undefined) {
    if (!Number.isFinite(stopLossDistance) || stopLossDistance <= 0) {
      blockers.push({
        code: "INVALID_PROTECTION_LEVELS",
        message: `stopLossDistance ${stopLossDistance} must be a positive finite number`,
        source: "policy",
      });
    }
  }
  if (takeProfitDistance !== undefined) {
    if (!Number.isFinite(takeProfitDistance) || takeProfitDistance <= 0) {
      blockers.push({
        code: "INVALID_PROTECTION_LEVELS",
        message: `takeProfitDistance ${takeProfitDistance} must be a positive finite number`,
        source: "policy",
      });
    }
  }
  if (trailingStopDistance !== undefined) {
    if (!Number.isFinite(trailingStopDistance) || trailingStopDistance <= 0) {
      blockers.push({
        code: "INVALID_PROTECTION_LEVELS",
        message: `trailingStopDistance ${trailingStopDistance} must be a positive finite number`,
        source: "policy",
      });
    }
  }
  if (blockers.length > 0) {
    return { warnings, blockers };
  }

  const rawStopLoss =
    stopLossDistance === undefined
      ? undefined
      : side === "BUY"
        ? entry - stopLossDistance
        : entry + stopLossDistance;
  const rawTakeProfit =
    takeProfitDistance === undefined
      ? undefined
      : side === "BUY"
        ? entry + takeProfitDistance
        : entry - takeProfitDistance;

  const stopLoss =
    rawStopLoss === undefined
      ? undefined
      : roundToTick(rawStopLoss, priceTickSize, priceRoundingMode);
  const takeProfit =
    rawTakeProfit === undefined
      ? undefined
      : roundToTick(rawTakeProfit, priceTickSize, priceRoundingMode);
  const trailingStop =
    trailingStopDistance === undefined
      ? undefined
      : roundToTick(trailingStopDistance, priceTickSize, priceRoundingMode);

  // Enforce correct side after rounding — the rounding can, in
  // pathological cases (tiny distance vs. large tick), push the
  // stop or take-profit onto or across the entry.
  if (stopLoss !== undefined) {
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
      blockers.push({
        code: "INVALID_PROTECTION_LEVELS",
        message: `rounded stopLoss ${stopLoss} is not a positive finite number`,
        source: "pricing",
      });
    } else if (side === "BUY" && stopLoss >= entry) {
      blockers.push({
        code: "INVALID_PROTECTION_LEVELS",
        message: `BUY stopLoss ${stopLoss} must be strictly below entry ${entry}`,
        source: "pricing",
      });
    } else if (side === "SELL" && stopLoss <= entry) {
      blockers.push({
        code: "INVALID_PROTECTION_LEVELS",
        message: `SELL stopLoss ${stopLoss} must be strictly above entry ${entry}`,
        source: "pricing",
      });
    }
  }
  if (takeProfit !== undefined) {
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
      blockers.push({
        code: "INVALID_PROTECTION_LEVELS",
        message: `rounded takeProfit ${takeProfit} is not a positive finite number`,
        source: "pricing",
      });
    } else if (side === "BUY" && takeProfit <= entry) {
      blockers.push({
        code: "INVALID_PROTECTION_LEVELS",
        message: `BUY takeProfit ${takeProfit} must be strictly above entry ${entry}`,
        source: "pricing",
      });
    } else if (side === "SELL" && takeProfit >= entry) {
      blockers.push({
        code: "INVALID_PROTECTION_LEVELS",
        message: `SELL takeProfit ${takeProfit} must be strictly below entry ${entry}`,
        source: "pricing",
      });
    }
  }
  if (trailingStop !== undefined && (!Number.isFinite(trailingStop) || trailingStop <= 0)) {
    blockers.push({
      code: "INVALID_PROTECTION_LEVELS",
      message: `rounded trailingStop ${trailingStop} is not a positive finite number`,
      source: "pricing",
    });
  }

  if (blockers.length > 0) {
    return { warnings, blockers };
  }

  // Signal that rounding changed a value so operators can spot it in
  // audit logs.
  if (
    (rawStopLoss !== undefined && rawStopLoss !== stopLoss) ||
    (rawTakeProfit !== undefined && rawTakeProfit !== takeProfit) ||
    (trailingStopDistance !== undefined && trailingStopDistance !== trailingStop)
  ) {
    warnings.push({
      code: "PROTECTION_ROUNDED",
      message: "protection levels adjusted to tick size",
      source: "pricing",
    });
  }

  return {
    stopLoss,
    takeProfit,
    trailingStop,
    warnings,
    blockers,
  };
}

/**
 * Cross-check the price envelope required by each supported order
 * type. `entry` here is the already-rounded limit candidate.
 */
export function resolveOrderPrices(
  orderType: SupportedOrderType,
  entry: number,
): {
  readonly limitPrice?: number;
  readonly stopPrice?: number;
  readonly blockers: readonly TicketBlocker[];
} {
  const blockers: TicketBlocker[] = [];
  switch (orderType) {
    case "LMT":
      return { limitPrice: entry, blockers };
    case "STP":
      // STP takes the entry as the stop trigger price.
      return { stopPrice: entry, blockers };
    case "STP_LMT":
      // For STP_LMT we use the same rounded entry price as both
      // trigger and limit — a conservative default; strategies that
      // need a wider limit gap can extend the policy in a later PR.
      return { stopPrice: entry, limitPrice: entry, blockers };
    default: {
      const exhaustive: never = orderType;
      blockers.push({
        code: "UNSUPPORTED_ORDER_TYPE",
        message: `unsupported orderType ${String(exhaustive)}`,
        source: "policy",
      });
      return { blockers };
    }
  }
}
