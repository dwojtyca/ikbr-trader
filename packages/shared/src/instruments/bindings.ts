/**
 * PR15.2 — Authoritative instrument binding.
 *
 * The `InstrumentRegistry` describes logical instruments
 * (`es_front`, `gc_front`, ...). A `BoundInstrument` pins ONE
 * logical instrument to the exact broker-side contract the
 * operator has chosen for this deployment — the IBKR `conId`
 * plus the disambiguating fields (`localSymbol`, `tradingClass`,
 * `exchange`, `currency`).
 *
 * This module is intentionally pure:
 *   - No `process.env` reads.
 *   - No I/O (Postgres / Redis / IBKR).
 *   - No cross-mutation of `InstrumentRegistry`.
 *   - `parseInstrumentBindings` accepts a JSON text (or an
 *     already-parsed value) plus a registry and returns either
 *     a validated snapshot or a list of validation errors.
 *
 * Consumers (ingestion, signal-engine, execution-engine) each
 * construct their OWN `InstrumentBindingAuthority` from the SAME
 * shared configuration input (`INSTRUMENT_BINDINGS_JSON`) so no
 * component trusts a claim propagated by another service.
 */

import type { InstrumentRegistry } from "./registry.js";
import type { Broker, Instrument } from "./types.js";

/**
 * Raw operator-supplied binding — one entry in the configured
 * `INSTRUMENT_BINDINGS_JSON` array. Every field except
 * `instrumentId`, `conId`, and `minTick` is required as a
 * canonical string; empty / whitespace values are rejected by
 * the parser.
 */
export interface InstrumentBinding {
  readonly instrumentId: string;
  readonly conId: number;
  readonly localSymbol: string;
  readonly tradingClass: string;
  readonly exchange: string;
  readonly currency: string;
  /**
   * PR15.2 hostile-review fix — broker-verified minimum tick
   * size. Positive finite. Ingestion cross-checks it against
   * the value returned by `reqContractDetails`; execution-engine
   * cross-checks it against `Instrument.executionPolicy.priceTickSize`.
   * Kept out of the expiring seed catalogue on purpose — it
   * belongs to the exact dated contract, not the logical
   * instrument.
   */
  readonly minTick: number;
  /**
   * Optional broker qualifier so heterogeneous catalogues remain
   * possible in a future PR. Currently defaults to the logical
   * instrument's `broker` — a mismatch is a startup error.
   */
  readonly broker?: Broker;
}

/**
 * View exposed to runtime consumers. Combines the frozen logical
 * `Instrument` with the exact broker contract identity chosen by
 * the operator. Deep-frozen at authority-construction time.
 */
export interface BoundInstrument {
  readonly instrumentId: string;
  readonly instrument: Instrument;
  readonly broker: Broker;
  readonly brokerSymbol: string;
  readonly conId: number;
  readonly localSymbol: string;
  readonly tradingClass: string;
  readonly exchange: string;
  readonly currency: string;
  /** PR15.2 hostile-review — see `InstrumentBinding.minTick`. */
  readonly minTick: number;
}

/**
 * PR15.2 hostile-review fix — floating-point tolerance used when
 * comparing a broker-returned `minTick` (or a policy tick) with
 * the bound value. Intentionally tight (~1e-9): this is a
 * representation-only tolerance, not a "business" tolerance —
 * two ticks that differ beyond this are DIFFERENT ticks.
 */
export const MIN_TICK_EPSILON = 1e-9;

export function tickSizesEqual(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= MIN_TICK_EPSILON;
}

/**
 * PR15.2 hostile-review round-3 fix — trusted mapping from the
 * shared `AssetClass` union to IBKR's `secType`. Deliberately
 * exhaustive: every asset class returns a definite string so
 * ingestion never falls back to the runtime `STK` default when
 * requesting `contractDetails` for a bound futures / index /
 * forex / options / crypto instrument.
 *
 * NEVER inferred from symbol, exchange, currency, or any
 * operator-supplied untrusted field — the source of truth is
 * `Instrument.assetClass` which comes from the frozen shared
 * registry.
 *
 * If a new asset class is added to `AssetClass`, TypeScript's
 * exhaustiveness check forces this switch to grow with it.
 */
export function mapAssetClassToIbkrSecType(
  assetClass: import("./types.js").AssetClass,
): "FUT" | "STK" | "IND" | "CASH" | "OPT" | "CRYPTO" {
  switch (assetClass) {
    case "future":
      return "FUT";
    case "stock":
      return "STK";
    case "etf":
      return "STK";
    case "index":
      return "IND";
    case "forex":
      return "CASH";
    case "option":
      return "OPT";
    case "crypto":
      return "CRYPTO";
  }
}

export interface InstrumentBindingParseError {
  readonly index: number;
  readonly instrumentId: string | null;
  readonly message: string;
}

export type InstrumentBindingParseResult =
  | { readonly ok: true; readonly bindings: readonly InstrumentBinding[] }
  | { readonly ok: false; readonly errors: readonly InstrumentBindingParseError[] };

const MAX_SAFE_CON_ID = Number.MAX_SAFE_INTEGER;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse and validate the raw `INSTRUMENT_BINDINGS_JSON` payload
 * (a JSON string OR a pre-decoded value). Returns a discriminated
 * result — the caller decides whether to throw or degrade.
 *
 * Validation rules:
 *   - Input must decode to an array (an empty array is valid).
 *   - Every element must be an object.
 *   - `instrumentId` must exist in the registry.
 *   - `conId` must be a positive safe integer.
 *   - `localSymbol`, `tradingClass`, `exchange`, `currency` must
 *     be non-empty strings.
 *   - `exchange`, `currency`, `tradingClass`, `broker` must agree
 *     with the logical registry definition.
 *   - Duplicate `instrumentId` across bindings is rejected.
 *   - Duplicate `conId` across bindings is rejected.
 *
 * Rejection does NOT leak the raw JSON payload — only the entry
 * index, the offending `instrumentId` (when parseable), and the
 * short reason are surfaced.
 */
export function parseInstrumentBindings(
  input: unknown,
  registry: InstrumentRegistry,
): InstrumentBindingParseResult {
  let decoded: unknown = input;
  if (typeof input === "string") {
    if (input.trim() === "") {
      return { ok: true, bindings: [] };
    }
    try {
      decoded = JSON.parse(input);
    } catch (err) {
      return {
        ok: false,
        errors: [
          {
            index: -1,
            instrumentId: null,
            message: `malformed JSON: ${(err as Error).message}`,
          },
        ],
      };
    }
  }
  if (decoded === undefined || decoded === null) {
    return { ok: true, bindings: [] };
  }
  if (!Array.isArray(decoded)) {
    return {
      ok: false,
      errors: [
        {
          index: -1,
          instrumentId: null,
          message: "INSTRUMENT_BINDINGS_JSON must decode to an array",
        },
      ],
    };
  }

  const errors: InstrumentBindingParseError[] = [];
  const bindings: InstrumentBinding[] = [];
  const seenIds = new Set<string>();
  const seenConIds = new Set<number>();

  for (let index = 0; index < decoded.length; index += 1) {
    const entry = decoded[index];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push({
        index,
        instrumentId: null,
        message: "entry must be an object",
      });
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const instrumentIdRaw = raw.instrumentId;
    const instrumentId = isNonEmptyString(instrumentIdRaw)
      ? instrumentIdRaw.trim()
      : null;
    if (instrumentId === null) {
      errors.push({
        index,
        instrumentId: null,
        message: "instrumentId must be a non-empty string",
      });
      continue;
    }
    const instrument = registry.getInstrument(instrumentId);
    if (!instrument) {
      errors.push({
        index,
        instrumentId,
        message: `instrumentId "${instrumentId}" is not registered`,
      });
      continue;
    }

    const conIdRaw = raw.conId;
    if (
      typeof conIdRaw !== "number" ||
      !Number.isFinite(conIdRaw) ||
      !Number.isInteger(conIdRaw) ||
      conIdRaw <= 0 ||
      conIdRaw > MAX_SAFE_CON_ID
    ) {
      errors.push({
        index,
        instrumentId,
        message: "conId must be a positive safe integer",
      });
      continue;
    }
    const conId = conIdRaw;

    const localSymbolRaw = raw.localSymbol;
    const tradingClassRaw = raw.tradingClass;
    const exchangeRaw = raw.exchange;
    const currencyRaw = raw.currency;
    const brokerRaw = raw.broker;
    const minTickRaw = raw.minTick;

    if (
      typeof minTickRaw !== "number" ||
      !Number.isFinite(minTickRaw) ||
      minTickRaw <= 0
    ) {
      errors.push({
        index,
        instrumentId,
        message: "minTick must be a positive finite number",
      });
      continue;
    }
    const minTick = minTickRaw;

    if (!isNonEmptyString(localSymbolRaw)) {
      errors.push({
        index,
        instrumentId,
        message: "localSymbol must be a non-empty string",
      });
      continue;
    }
    if (!isNonEmptyString(tradingClassRaw)) {
      errors.push({
        index,
        instrumentId,
        message: "tradingClass must be a non-empty string",
      });
      continue;
    }
    if (!isNonEmptyString(exchangeRaw)) {
      errors.push({
        index,
        instrumentId,
        message: "exchange must be a non-empty string",
      });
      continue;
    }
    if (!isNonEmptyString(currencyRaw)) {
      errors.push({
        index,
        instrumentId,
        message: "currency must be a non-empty string",
      });
      continue;
    }
    if (brokerRaw !== undefined && !isNonEmptyString(brokerRaw)) {
      errors.push({
        index,
        instrumentId,
        message: "broker (when present) must be a non-empty string",
      });
      continue;
    }
    const localSymbol = localSymbolRaw.trim();
    const tradingClass = tradingClassRaw.trim();
    const exchange = exchangeRaw.trim();
    const currency = currencyRaw.trim().toUpperCase();
    const broker = brokerRaw === undefined ? instrument.broker : (brokerRaw as string).trim();

    if (broker !== instrument.broker) {
      errors.push({
        index,
        instrumentId,
        message: `broker "${broker}" does not match registry broker "${instrument.broker}"`,
      });
      continue;
    }
    if (exchange !== instrument.exchange) {
      errors.push({
        index,
        instrumentId,
        message: `exchange "${exchange}" does not match registry exchange "${instrument.exchange}"`,
      });
      continue;
    }
    if (currency !== instrument.currency.toUpperCase()) {
      errors.push({
        index,
        instrumentId,
        message: `currency "${currency}" does not match registry currency "${instrument.currency}"`,
      });
      continue;
    }
    if (
      instrument.tradingClass !== undefined &&
      tradingClass !== instrument.tradingClass
    ) {
      errors.push({
        index,
        instrumentId,
        message: `tradingClass "${tradingClass}" does not match registry tradingClass "${instrument.tradingClass}"`,
      });
      continue;
    }

    if (instrument.conId !== undefined && conId !== instrument.conId) {
      errors.push({ index, instrumentId, message: "conId does not match pinned registry conId" });
      continue;
    }
    if (instrument.localSymbol !== undefined && localSymbol !== instrument.localSymbol) {
      errors.push({ index, instrumentId, message: "localSymbol does not match pinned registry localSymbol" });
      continue;
    }

    if (seenIds.has(instrumentId)) {
      errors.push({
        index,
        instrumentId,
        message: `duplicate instrumentId "${instrumentId}"`,
      });
      continue;
    }
    if (seenConIds.has(conId)) {
      errors.push({
        index,
        instrumentId,
        message: `duplicate conId ${conId}`,
      });
      continue;
    }
    seenIds.add(instrumentId);
    seenConIds.add(conId);

    bindings.push({
      instrumentId,
      conId,
      localSymbol,
      tradingClass,
      exchange,
      currency,
      minTick,
      broker: broker as Broker,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, bindings };
}

/**
 * Pure authority object. Constructed from an `InstrumentRegistry`
 * plus already-validated bindings.
 *
 * PR15.2 hostile-review fix — the constructor performs the SAME
 * shape / identity / duplicate validation as the parser so class
 * safety does NOT depend on going through the parser. A caller
 * that hand-crafts an `InstrumentBinding[]` (tests, adapters, a
 * future config source) gets the same fail-closed guarantees.
 */
export class InstrumentBindingAuthority {
  readonly #byInstrumentId: ReadonlyMap<string, BoundInstrument>;
  readonly #byConId: ReadonlyMap<number, BoundInstrument>;
  readonly #boundIds: readonly string[];

  constructor(
    registry: InstrumentRegistry,
    bindings: readonly InstrumentBinding[],
  ) {
    if (!Array.isArray(bindings)) {
      throw new Error("InstrumentBindingAuthority: bindings must be an array");
    }
    const byId = new Map<string, BoundInstrument>();
    const byConId = new Map<number, BoundInstrument>();
    for (const binding of bindings) {
      if (typeof binding !== "object" || binding === null) {
        throw new Error(
          "InstrumentBindingAuthority: every binding must be an object",
        );
      }
      // ---- identity + registry lookup ----
      if (
        typeof binding.instrumentId !== "string" ||
        binding.instrumentId.trim().length === 0
      ) {
        throw new Error(
          "InstrumentBindingAuthority: instrumentId must be a non-empty string",
        );
      }
      const instrument = registry.getInstrument(binding.instrumentId);
      if (!instrument) {
        throw new Error(
          `InstrumentBindingAuthority: instrumentId "${binding.instrumentId}" is not registered`,
        );
      }
      // ---- conId shape ----
      if (
        typeof binding.conId !== "number" ||
        !Number.isFinite(binding.conId) ||
        !Number.isInteger(binding.conId) ||
        binding.conId <= 0 ||
        binding.conId > Number.MAX_SAFE_INTEGER
      ) {
        throw new Error(
          `InstrumentBindingAuthority: conId for "${binding.instrumentId}" must be a positive safe integer`,
        );
      }
      // ---- minTick shape ----
      if (
        typeof binding.minTick !== "number" ||
        !Number.isFinite(binding.minTick) ||
        binding.minTick <= 0
      ) {
        throw new Error(
          `InstrumentBindingAuthority: minTick for "${binding.instrumentId}" must be a positive finite number`,
        );
      }
      // ---- canonical string fields ----
      if (
        typeof binding.localSymbol !== "string" ||
        binding.localSymbol.trim().length === 0
      ) {
        throw new Error(
          `InstrumentBindingAuthority: localSymbol for "${binding.instrumentId}" must be a non-empty string`,
        );
      }
      if (
        typeof binding.tradingClass !== "string" ||
        binding.tradingClass.trim().length === 0
      ) {
        throw new Error(
          `InstrumentBindingAuthority: tradingClass for "${binding.instrumentId}" must be a non-empty string`,
        );
      }
      if (
        typeof binding.exchange !== "string" ||
        binding.exchange.trim().length === 0
      ) {
        throw new Error(
          `InstrumentBindingAuthority: exchange for "${binding.instrumentId}" must be a non-empty string`,
        );
      }
      if (
        typeof binding.currency !== "string" ||
        binding.currency.trim().length === 0
      ) {
        throw new Error(
          `InstrumentBindingAuthority: currency for "${binding.instrumentId}" must be a non-empty string`,
        );
      }
      const localSymbol = binding.localSymbol.trim();
      const tradingClass = binding.tradingClass.trim();
      const exchange = binding.exchange.trim();
      const currency = binding.currency.trim().toUpperCase();
      const broker = binding.broker ?? instrument.broker;
      // ---- registry-tuple checks ----
      if (broker !== instrument.broker) {
        throw new Error(
          `InstrumentBindingAuthority: broker "${broker}" for "${binding.instrumentId}" does not match registry broker "${instrument.broker}"`,
        );
      }
      if (exchange !== instrument.exchange) {
        throw new Error(
          `InstrumentBindingAuthority: exchange "${exchange}" for "${binding.instrumentId}" does not match registry exchange "${instrument.exchange}"`,
        );
      }
      if (currency !== instrument.currency.toUpperCase()) {
        throw new Error(
          `InstrumentBindingAuthority: currency "${currency}" for "${binding.instrumentId}" does not match registry currency "${instrument.currency}"`,
        );
      }
      if (
        instrument.tradingClass !== undefined &&
        tradingClass !== instrument.tradingClass
      ) {
        throw new Error(
          `InstrumentBindingAuthority: tradingClass "${tradingClass}" for "${binding.instrumentId}" does not match registry tradingClass "${instrument.tradingClass}"`,
        );
      }
      if (instrument.conId !== undefined && binding.conId !== instrument.conId) {
        throw new Error("InstrumentBindingAuthority: conId does not match pinned registry conId");
      }
      if (instrument.localSymbol !== undefined && localSymbol !== instrument.localSymbol) {
        throw new Error("InstrumentBindingAuthority: localSymbol does not match pinned registry localSymbol");
      }
      // ---- duplicate id / conId ----
      if (byId.has(binding.instrumentId)) {
        throw new Error(
          `InstrumentBindingAuthority: duplicate instrumentId "${binding.instrumentId}"`,
        );
      }
      if (byConId.has(binding.conId)) {
        throw new Error(
          `InstrumentBindingAuthority: duplicate conId ${binding.conId}`,
        );
      }
      const bound: BoundInstrument = Object.freeze({
        instrumentId: binding.instrumentId,
        instrument,
        broker,
        brokerSymbol: instrument.brokerSymbol,
        conId: binding.conId,
        localSymbol,
        tradingClass,
        exchange,
        currency,
        minTick: binding.minTick,
      });
      byId.set(binding.instrumentId, bound);
      byConId.set(binding.conId, bound);
    }
    this.#byInstrumentId = byId;
    this.#byConId = byConId;
    this.#boundIds = Object.freeze(Array.from(byId.keys()));
  }

  /**
   * Return the bound instrument for a logical `instrumentId`.
   * `undefined` when the instrument is not bound. Callers MUST
   * NOT fall back to a symbol-based lookup on undefined.
   */
  getBoundInstrument(instrumentId: string): BoundInstrument | undefined {
    return this.#byInstrumentId.get(instrumentId);
  }

  /**
   * Return the bound instrument for a specific broker `conId`, or
   * `undefined` when no binding matches. Used by ingestion to
   * verify that a returned contract-details `conId` belongs to a
   * configured binding.
   */
  getBoundInstrumentByConId(conId: number): BoundInstrument | undefined {
    return this.#byConId.get(conId);
  }

  hasBinding(instrumentId: string): boolean {
    return this.#byInstrumentId.has(instrumentId);
  }

  /** Sorted, immutable snapshot of every bound `instrumentId`. */
  listBoundInstrumentIds(): readonly string[] {
    return this.#boundIds;
  }

  /** Frozen snapshot of every bound instrument (iteration order = config order). */
  listBoundInstruments(): readonly BoundInstrument[] {
    return Object.freeze(Array.from(this.#byInstrumentId.values()));
  }

  /**
   * Safe diagnostics — for logging / `/watchlist`. Never expose
   * the raw configuration payload; only the bound identifiers and
   * a redacted summary of the resolved contract identity.
   */
  toDiagnostics(): {
    readonly boundCount: number;
    readonly ids: readonly string[];
  } {
    return Object.freeze({
      boundCount: this.#byInstrumentId.size,
      ids: this.#boundIds,
    });
  }
}

/**
 * Convenience factory that combines parsing and authority
 * construction. Returns a discriminated result mirroring
 * `parseInstrumentBindings` so bootstrap code can present a
 * single error surface.
 */
export function buildInstrumentBindingAuthority(
  input: unknown,
  registry: InstrumentRegistry,
):
  | { readonly ok: true; readonly authority: InstrumentBindingAuthority }
  | { readonly ok: false; readonly errors: readonly InstrumentBindingParseError[] } {
  const parsed = parseInstrumentBindings(input, registry);
  if (!parsed.ok) return parsed;
  try {
    const authority = new InstrumentBindingAuthority(registry, parsed.bindings);
    return { ok: true, authority };
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          index: -1,
          instrumentId: null,
          message: (err as Error).message,
        },
      ],
    };
  }
}
