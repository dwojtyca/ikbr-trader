import type { Side } from "@ikbr/shared";
import type { FuturesContractSpec } from "./futures-model.js";

export type GridInstruction = "limit" | "stop";
export type FuturesExitReason =
  | "stop"
  | "take_profit"
  | "partial_take_profit"
  | "contract_roll"
  | "expiry"
  | "dataset_end"
  | "managed_exit"
  | "opposite_signal";

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return (text.split(".")[1] ?? "").length;
}

export function priceToTicks(price: number, tickSize: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0)
    throw new Error("Price and tick size must be finite and tick size positive");
  const scale = 10 ** Math.max(decimalPlaces(price), decimalPlaces(tickSize));
  const scaledPrice = Math.round(price * scale);
  const scaledTick = Math.round(tickSize * scale);
  if (scaledTick <= 0) throw new Error("Tick size is below supported precision");
  return scaledPrice / scaledTick;
}

export function ticksToPrice(ticks: number, tickSize: number): number {
  const precision = decimalPlaces(tickSize);
  return Number((ticks * tickSize).toFixed(precision));
}

export function normalizeInstructionPrice(
  price: number,
  tickSize: number,
  side: Exclude<Side, "HOLD">,
  instruction: GridInstruction,
): number {
  const ticks = priceToTicks(price, tickSize);
  const rounded = instruction === "limit"
    ? side === "BUY" ? Math.floor(ticks) : Math.ceil(ticks)
    : side === "BUY" ? Math.ceil(ticks) : Math.floor(ticks);
  return ticksToPrice(rounded, tickSize);
}

export function applyAdverseSlippage(
  referencePrice: number,
  side: Exclude<Side, "HOLD">,
  spec: FuturesContractSpec,
): number {
  const referenceTicks = priceToTicks(referencePrice, spec.tickSize);
  if (!Number.isInteger(referenceTicks))
    throw new Error(`Reference price ${referencePrice} is not on the futures tick grid`);
  const direction = side === "BUY" ? 1 : -1;
  return ticksToPrice(referenceTicks + direction * spec.slippageTicks, spec.tickSize);
}

export function stopExitReference(
  sideToClose: "BUY" | "SELL",
  stopPrice: number,
  barOpen: number,
  tickSize: number,
): number {
  const normalizedStop = normalizeInstructionPrice(stopPrice, tickSize, sideToClose, "stop");
  return sideToClose === "SELL"
    ? Math.min(normalizedStop, barOpen)
    : Math.max(normalizedStop, barOpen);
}

export function futuresRoundTripPnl(input: {
  direction: 1 | -1;
  quantity: number;
  entryFillPrice: number;
  exitFillPrice: number;
  fxRate: number;
  spec: FuturesContractSpec;
}): { grossPnl: number; commission: number; netPnl: number } {
  const grossPnl = input.direction *
    (input.exitFillPrice - input.entryFillPrice) *
    input.quantity * input.spec.multiplier * input.fxRate;
  const commission = input.quantity * input.spec.commissionPerContractPerSide * 2;
  return { grossPnl, commission, netPnl: grossPnl - commission };
}

