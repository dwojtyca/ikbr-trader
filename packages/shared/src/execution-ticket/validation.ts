import type {
  ExecutionTicketBuildInput,
  ExecutionTicketPolicy,
  OrderSide,
  SupportedOrderType,
  TicketBlocker,
} from "./types.js";
import type { DecisionAction } from "../decision-engine/types.js";

const SUPPORTED_ORDER_TYPES: readonly SupportedOrderType[] = [
  "LMT",
  "STP",
  "STP_LMT",
];

/**
 * Pre-computation guardrails that only look at the caller-supplied
 * signal, instrument and snapshot. Returns every blocker it can
 * observe in one pass so a caller aborting on the first stage still
 * sees every reason at once.
 */
export function validateSignalAndContext(
  input: ExecutionTicketBuildInput,
): readonly TicketBlocker[] {
  const blockers: TicketBlocker[] = [];
  const { signal, snapshot, instrument } = input;

  if (signal.status !== "GENERATED") {
    blockers.push({
      code: "SIGNAL_NOT_GENERATED",
      message: `signal status ${signal.status} is not GENERATED`,
      source: "signal",
    });
  }
  if (!signal.decision) {
    blockers.push({
      code: "DECISION_MISSING",
      message: "signal.decision is null",
      source: "signal",
    });
  }
  if (!signal.risk) {
    blockers.push({
      code: "RISK_MISSING",
      message: "signal.risk is null",
      source: "signal",
    });
  }
  if (signal.risk && !signal.risk.approved) {
    blockers.push({
      code: "RISK_NOT_APPROVED",
      message: "signal.risk.approved is false",
      source: "signal",
    });
  }
  if (signal.decision && !isDirectional(signal.decision.action)) {
    blockers.push({
      code: "NON_DIRECTIONAL_DECISION",
      message: `decision.action ${signal.decision.action} is not LONG or SHORT`,
      source: "signal",
    });
  }

  if (
    signal.instrumentId !== snapshot.instrumentId ||
    signal.instrumentId !== instrument.id
  ) {
    blockers.push({
      code: "INSTRUMENT_MISMATCH",
      message: `signal ${signal.instrumentId} / snapshot ${snapshot.instrumentId} / instrument ${instrument.id} disagree`,
      source: "signal",
    });
  }
  if (!instrument.trading.executionEnabled) {
    blockers.push({
      code: "INSTRUMENT_DISABLED",
      message: `instrument ${instrument.id} has executionEnabled=false`,
      source: "instrument",
    });
  }

  const priceSection = snapshot.sections.price;
  if (!priceSection.data) {
    blockers.push({
      code: "PRICE_MISSING",
      message: "snapshot.sections.price.data is null",
      source: "snapshot",
    });
  } else if (priceSection.status !== "fresh") {
    blockers.push({
      code: "PRICE_NOT_FRESH",
      message: `snapshot.sections.price.status is ${priceSection.status}, expected fresh`,
      source: "snapshot",
    });
  }

  return blockers;
}

/**
 * Policy-only guardrails. Kept separate so that a broken policy
 * short-circuits before pricing math runs.
 */
export function validatePolicy(
  policy: ExecutionTicketPolicy,
  instrumentMaxQuantity: number,
): readonly TicketBlocker[] {
  const blockers: TicketBlocker[] = [];

  if (!SUPPORTED_ORDER_TYPES.includes(policy.orderType)) {
    blockers.push({
      code: "UNSUPPORTED_ORDER_TYPE",
      message: `orderType ${policy.orderType} is not supported (allowed: ${SUPPORTED_ORDER_TYPES.join(", ")})`,
      source: "policy",
    });
  }

  if (
    !Number.isFinite(policy.quantity) ||
    !Number.isInteger(policy.quantity) ||
    policy.quantity <= 0
  ) {
    blockers.push({
      code: "INVALID_QUANTITY",
      message: `quantity ${policy.quantity} must be a positive integer`,
      source: "policy",
    });
  } else if (policy.quantity > instrumentMaxQuantity) {
    blockers.push({
      code: "QUANTITY_LIMIT_EXCEEDED",
      message: `quantity ${policy.quantity} exceeds instrument.risk.maxQuantity ${instrumentMaxQuantity}`,
      source: "policy",
    });
  }

  if (!Number.isFinite(policy.priceTickSize) || policy.priceTickSize <= 0) {
    blockers.push({
      code: "INVALID_TICK_SIZE",
      message: `priceTickSize ${policy.priceTickSize} must be a positive finite number`,
      source: "policy",
    });
  }

  return blockers;
}

/**
 * Post-pricing envelope guardrails. Every supported order type has
 * a distinct required-price set (see `resolveOrderPrices`); this
 * checker mirrors that contract so an incomplete envelope fails
 * fast with a structured blocker rather than being submitted with a
 * `undefined` price.
 */
export function validateOrderEnvelope(
  orderType: SupportedOrderType,
  prices: { readonly limitPrice?: number; readonly stopPrice?: number },
): readonly TicketBlocker[] {
  const blockers: TicketBlocker[] = [];
  switch (orderType) {
    case "LMT":
      if (prices.limitPrice === undefined) {
        blockers.push({
          code: "INVALID_ORDER_CONFIGURATION",
          message: "LMT requires limitPrice",
          source: "pricing",
        });
      }
      break;
    case "STP":
      if (prices.stopPrice === undefined) {
        blockers.push({
          code: "INVALID_ORDER_CONFIGURATION",
          message: "STP requires stopPrice",
          source: "pricing",
        });
      }
      break;
    case "STP_LMT":
      if (prices.stopPrice === undefined || prices.limitPrice === undefined) {
        blockers.push({
          code: "INVALID_ORDER_CONFIGURATION",
          message: "STP_LMT requires both stopPrice and limitPrice",
          source: "pricing",
        });
      }
      break;
  }
  return blockers;
}

export function directionToSide(action: DecisionAction): OrderSide {
  // Caller must have run `validateSignalAndContext` first so we can
  // assume `action` is directional here. `HOLD` should never reach
  // this function — the `default` branch enforces exhaustiveness at
  // compile time and fails loudly at runtime if a new
  // `DecisionAction` variant is ever added without updating this
  // mapping.
  switch (action) {
    case "LONG":
      return "BUY";
    case "SHORT":
      return "SELL";
    case "HOLD":
      throw new Error(
        "directionToSide: HOLD is non-directional and must be filtered upstream",
      );
    default:
      return assertNeverAction(action);
  }
}

function assertNeverAction(action: never): never {
  throw new Error(
    `directionToSide: unhandled DecisionAction ${String(action)}`,
  );
}

function isDirectional(action: DecisionAction): boolean {
  return action === "LONG" || action === "SHORT";
}
