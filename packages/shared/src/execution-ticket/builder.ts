import {
  computeEntryPrice,
  computeProtection,
  resolveOrderPrices,
} from "./pricing.js";
import {
  directionToSide,
  validateOrderEnvelope,
  validatePolicy,
  validateSignalAndContext,
} from "./validation.js";
import type {
  ExecutionTicket,
  ExecutionTicketBuildInput,
  ExecutionTicketBuildResult,
  ExecutionTicketMetadata,
  ExecutionTicketOrder,
  ExecutionTicketProtection,
  TicketBlocker,
  TicketWarning,
} from "./types.js";

export const EXECUTION_TICKET_BUILDER_VERSION = "0.1.0";

export interface ExecutionTicketBuilderOptions {
  /**
   * Deterministic ticketId factory. REQUIRED — the shared package
   * does not assume Web Crypto is available on every host. Wire
   * `crypto.randomUUID` (or an equivalent) at the service boundary.
   */
  readonly idFactory: () => string;
  /**
   * Deterministic correlationId factory. REQUIRED — kept separate
   * from `idFactory` so services can distinguish ticket identity
   * from cross-service tracing keys.
   */
  readonly correlationIdFactory: () => string;
  /** Deterministic wall clock. Default `() => new Date()`. */
  readonly now?: () => Date;
  /** Reported in `ExecutionTicketMetadata.builderVersion`. */
  readonly version?: string;
}

/**
 * Deterministic `SignalEvaluation → ExecutionTicket` translator.
 *
 * Pipeline (single `build` call):
 *   1. `validateSignalAndContext(input)` — signal status, direction,
 *      instrument matching, price section presence + freshness.
 *   2. `validatePolicy(policy, instrument.risk.maxQuantity)` —
 *      quantity, tick size, order-type support.
 *   3. If any blockers so far → return `{ ok: false }` (never throws).
 *   4. `computeEntryPrice(side, price, policy)` — base + offset +
 *      tick rounding.
 *   5. `computeProtection(side, entry, policy)` — stop / take-profit
 *      / trailing distances, tick-rounded, side-checked.
 *   6. `resolveOrderPrices(orderType, entry)` → `{ limitPrice?,
 *      stopPrice? }`.
 *   7. `validateOrderEnvelope(orderType, prices)` — ensure the
 *      envelope required by the order type is complete.
 *   8. Assemble `ExecutionTicket`, deep-freeze, return
 *      `{ ok: true }`.
 *
 * The builder throws ONLY for constructor misconfiguration. Every
 * domain-level failure surfaces as a `TicketBlocker`.
 *
 * TODO(architecture): once a second builder / consumer appears,
 * extract the freeze helper into a shared engine utility (mirrors
 * TODOs already recorded on `MarketContextBuilder`, `DecisionEngine`,
 * `RiskEngine`, `SignalEngine`).
 */
export class ExecutionTicketBuilder {
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #correlationIdFactory: () => string;
  readonly #version: string;

  constructor(options: ExecutionTicketBuilderOptions) {
    if (!options || typeof options.idFactory !== "function") {
      throw new Error(
        "ExecutionTicketBuilder: idFactory is required (shared package does not assume Web Crypto)",
      );
    }
    if (typeof options.correlationIdFactory !== "function") {
      throw new Error(
        "ExecutionTicketBuilder: correlationIdFactory is required (shared package does not assume Web Crypto)",
      );
    }
    this.#idFactory = options.idFactory;
    this.#correlationIdFactory = options.correlationIdFactory;
    this.#now = options.now ?? (() => new Date());
    this.#version = options.version ?? EXECUTION_TICKET_BUILDER_VERSION;
  }

  build(input: ExecutionTicketBuildInput): ExecutionTicketBuildResult {
    if (!input || !input.signal || !input.snapshot || !input.instrument || !input.policy) {
      throw new Error(
        "ExecutionTicketBuilder.build: input requires signal, snapshot, instrument and policy",
      );
    }

    const warnings: TicketWarning[] = [];
    const blockers: TicketBlocker[] = [];

    blockers.push(...validateSignalAndContext(input));
    blockers.push(...validatePolicy(input.policy, input.instrument.risk.maxQuantity));

    if (blockers.length > 0) {
      return fail(blockers, warnings);
    }

    // Safe to assume decision + risk + directional action after the
    // guards above.
    const decision = input.signal.decision!;
    const risk = input.signal.risk!;
    const side = directionToSide(decision.action);

    const priceData = input.snapshot.sections.price.data!;
    const explicit = input.policy.strategyPrices;
    const isWse = input.instrument.exchange === "WSE" && input.instrument.currency === "PLN";
    if ((isWse && !explicit) || (explicit && (input.policy.orderType !== "LMT" || side !== "BUY"
      || ![explicit.entry, explicit.stopLoss, explicit.takeProfit].every(p => Number.isFinite(p) && p > 0)
      || explicit.stopLoss >= explicit.entry || explicit.takeProfit <= explicit.entry))) {
      return fail([{ code: "INVALID_PROTECTION_LEVELS", source: "policy", message: "valid explicit long strategy levels required" }], warnings);
    }
    const entryResult = explicit ? { entry: explicit.entry, warnings: [], blockers: [] }
      : computeEntryPrice(side, priceData, input.policy);
    warnings.push(...entryResult.warnings);
    if (entryResult.blockers.length > 0) {
      return fail(entryResult.blockers, warnings);
    }
    const entry = entryResult.entry!;

    const protectionResult = explicit ? { stopLoss: explicit.stopLoss, takeProfit: explicit.takeProfit,
      trailingStop: undefined, warnings: [], blockers: [] } : computeProtection(side, entry, input.policy);
    warnings.push(...protectionResult.warnings);
    if (protectionResult.blockers.length > 0) {
      return fail(protectionResult.blockers, warnings);
    }

    const orderPricesResult = resolveOrderPrices(input.policy.orderType, entry);
    if (orderPricesResult.blockers.length > 0) {
      return fail(orderPricesResult.blockers, warnings);
    }
    const envelopeBlockers = validateOrderEnvelope(
      input.policy.orderType,
      orderPricesResult,
    );
    if (envelopeBlockers.length > 0) {
      return fail(envelopeBlockers, warnings);
    }

    const order: ExecutionTicketOrder = {
      side,
      quantity: input.policy.quantity,
      quantityUnit: input.instrument.risk.quantityUnit,
      orderType: input.policy.orderType,
      ...(orderPricesResult.limitPrice !== undefined
        ? { limitPrice: orderPricesResult.limitPrice }
        : {}),
      ...(orderPricesResult.stopPrice !== undefined
        ? { stopPrice: orderPricesResult.stopPrice }
        : {}),
      timeInForce: input.policy.timeInForce,
      outsideRth: input.policy.outsideRth,
      transmit: input.policy.transmit,
    };

    const bracketEnabled =
      protectionResult.stopLoss !== undefined ||
      protectionResult.takeProfit !== undefined;

    const protection: ExecutionTicketProtection = {
      ...(protectionResult.stopLoss !== undefined
        ? { stopLoss: protectionResult.stopLoss }
        : {}),
      ...(protectionResult.takeProfit !== undefined
        ? { takeProfit: protectionResult.takeProfit }
        : {}),
      ...(protectionResult.trailingStop !== undefined
        ? { trailingStop: protectionResult.trailingStop }
        : {}),
      bracketEnabled,
    };

    const metadata: ExecutionTicketMetadata = {
      signalEngineVersion:
        input.signal.metadata.engineVersions.signal,
      decisionEngineVersion:
        input.signal.metadata.engineVersions.decision ??
        decision.metadata.engineVersion,
      riskEngineVersion:
        input.signal.metadata.engineVersions.risk ??
        risk.metadata.engineVersion,
      builderVersion: this.#version,
      correlationId: this.#correlationIdFactory(),
    };

    const ticket: ExecutionTicket = {
      ticketId: this.#idFactory(),
      createdAt: this.#now(),
      signalId: input.signal.signalId,
      decisionId: decision.decisionId,
      instrumentId: input.instrument.id,
      broker: input.instrument.broker,
      brokerSymbol: input.instrument.brokerSymbol,
      exchange: input.instrument.exchange,
      currency: input.instrument.currency,
      ...(input.instrument.conId !== undefined
        ? { conId: input.instrument.conId }
        : {}),
      ...(input.instrument.localSymbol !== undefined
        ? { localSymbol: input.instrument.localSymbol }
        : {}),
      ...(input.instrument.tradingClass !== undefined
        ? { tradingClass: input.instrument.tradingClass }
        : {}),
      order,
      protection,
      metadata,
    };

    const success: ExecutionTicketBuildResult = {
      ok: true,
      ticket,
      warnings,
    };
    return deepFreezeTicket(success);
  }
}

function fail(
  blockers: readonly TicketBlocker[],
  warnings: readonly TicketWarning[],
): ExecutionTicketBuildResult {
  const failure: ExecutionTicketBuildResult = {
    ok: false,
    ticket: null,
    blockers,
    warnings,
  };
  return deepFreezeTicket(failure);
}

// ---------------------------------------------------------------------------
// Cycle-safe deep freeze
// ---------------------------------------------------------------------------
// Duplicated from `market-context/builder.ts`, `decision-engine/evaluator.ts`,
// `risk-engine/evaluator.ts` and `signal-engine/result.ts` on purpose — see
// architectural TODOs in each of those files for the planned extraction.
function deepFreezeTicket<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node as Record<string, unknown>)) {
      walk(child);
    }
    if (!Object.isFrozen(node)) {
      Object.freeze(node);
    }
  };
  walk(value);
  return value;
}
