import { z } from "zod";

export const FUTURES_EXECUTION_MODEL_VERSION = "pr15.5b-v1";

export interface FuturesContractSpec {
  tradingClass: string;
  secType: "FUT";
  currency: string;
  multiplier: number;
  tickSize: number;
  commissionPerContractPerSide: number;
  slippageTicks: number;
  sessionTemplate: "cme_equity_index";
  timezone: "America/Chicago";
  calendarVersion: string;
}

export interface FuturesContractMetadata {
  conid: string;
  symbol: string;
  localSymbol: string;
  tradingClass: string;
  lastTradeAt: Date;
}

const specSchema = z.object({
  tradingClass: z.string().trim().min(1),
  secType: z.literal("FUT"),
  currency: z.string().trim().length(3),
  multiplier: z.number().positive(),
  tickSize: z.number().positive(),
  commissionPerContractPerSide: z.number().nonnegative(),
  slippageTicks: z.number().int().nonnegative(),
  sessionTemplate: z.literal("cme_equity_index"),
  timezone: z.literal("America/Chicago"),
  calendarVersion: z.string().trim().min(1),
});

export function validateFuturesContractSpec(
  value: unknown,
): FuturesContractSpec {
  const spec = specSchema.parse(value);
  const normalized = {
    ...spec,
    tradingClass: spec.tradingClass.toUpperCase(),
    currency: spec.currency.toUpperCase(),
  };
  if (normalized.tradingClass === "ES") {
    if (normalized.multiplier !== 50)
      throw new Error("ES futures multiplier must be 50");
    if (normalized.tickSize !== 0.25)
      throw new Error("ES futures tick size must be 0.25");
  }
  return normalized;
}

export function parseFuturesSpecsJson(
  raw: string,
): ReadonlyMap<string, FuturesContractSpec> {
  if (!raw.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BACKTEST_FUTURES_SPECS_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("BACKTEST_FUTURES_SPECS_JSON must be an object");
  const specs = new Map<string, FuturesContractSpec>();
  for (const [key, value] of Object.entries(parsed)) {
    const spec = validateFuturesContractSpec(value);
    if (key.trim().toUpperCase() !== spec.tradingClass)
      throw new Error(`Futures spec key ${key} must match tradingClass ${spec.tradingClass}`);
    if (specs.has(spec.tradingClass))
      throw new Error(`Duplicate futures spec for ${spec.tradingClass}`);
    specs.set(spec.tradingClass, Object.freeze(spec));
  }
  return specs;
}

export function requireFuturesSpec(
  specs: ReadonlyMap<string, FuturesContractSpec>,
  tradingClass: string | undefined,
): FuturesContractSpec {
  const key = tradingClass?.trim().toUpperCase();
  const spec = key ? specs.get(key) : undefined;
  if (!spec) throw new Error(`Missing futures specification for ${key || "unknown trading class"}`);
  return spec;
}

export function assertWholeContracts(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0)
    throw new Error("Futures quantity must be a positive whole number of contracts");
}

export function validateFuturesContractMetadata(
  value: FuturesContractMetadata,
): FuturesContractMetadata {
  if (!value.conid.trim() || !value.symbol.trim() || !value.localSymbol.trim())
    throw new Error("Futures contract identity requires conid, symbol, and localSymbol");
  if (!value.tradingClass.trim()) throw new Error("Futures contract tradingClass is required");
  if (!(value.lastTradeAt instanceof Date) || Number.isNaN(value.lastTradeAt.getTime()))
    throw new Error("Futures contract lastTradeAt is required");
  return { ...value, symbol: value.symbol.toUpperCase(), tradingClass: value.tradingClass.toUpperCase() };
}

