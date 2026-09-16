import { createHash } from "node:crypto";
import { z } from "zod";
import { IBKR_ES_BAR_REQUEST, IBKR_ES_BAR_SOURCE_VERSION } from "@ikbr/shared";
import { chicagoWallToUtc } from "./cme-session-calendar.js";

export const IBKR_ES_ACQUISITION_SPEC_VERSION = "pr15.5c.1-ibkr-es-acquisition-v2";
export const IBKR_ES_ROLL_POLICY_VERSION = "ibkr-es-volume-crossover-next-session-v2";
export const IBKR_ES_CALENDAR_VERSION = "cme-equity-index-2024-2026-v1";
export const IBKR_ES_TARGET_FROM = "2025-06-22T22:00:00.000Z";
export const IBKR_ES_TARGET_TO = "2026-08-31T20:59:00.000Z";
export const IBKR_ES_LOCAL_SYMBOLS = Object.freeze([
  "ESU5", "ESZ5", "ESH6", "ESM6", "ESU6",
] as const);

const utc = z.string().datetime({ offset: false });
const contractSchema = z.object({
  conId: z.number().int().positive(),
  localSymbol: z.enum(IBKR_ES_LOCAL_SYMBOLS),
  symbol: z.literal("ES"),
  secType: z.literal("FUT"),
  tradingClass: z.literal("ES"),
  exchange: z.literal("CME"),
  currency: z.literal("USD"),
  multiplier: z.literal("50"),
  minTick: z.literal(0.25),
  lastTradeDateOrContractMonth: z.string().regex(/^\d{6}(?:\d{2})?$/),
  expiryDate: z.string().regex(/^\d{8}$/),
  expiryDateSource: z.literal("ibkr-summary-expiry"),
  lastTradeRuleVersion: z.literal("cme-es-quarterly-termination-0830-ct-v1"),
  lastTradeAt: utc,
  fetchFrom: utc,
  fetchTo: utc,
}).strict();

const requestSchema = z.object({
  provider: z.literal(IBKR_ES_BAR_REQUEST.provider),
  secType: z.literal("FUT"), symbol: z.literal("ES"), tradingClass: z.literal("ES"),
  exchange: z.literal("CME"), currency: z.literal("USD"), multiplier: z.literal("50"),
  includeExpired: z.literal(true), barSize: z.literal("1 min"),
  whatToShow: z.literal("TRADES"), useRTH: z.literal(0), formatDate: z.literal(2),
  keepUpToDate: z.literal(false),
}).strict();

export const ibkrEsAcquisitionSpecSchema = z.object({
  schemaVersion: z.literal(IBKR_ES_ACQUISITION_SPEC_VERSION),
  sourceVersion: z.literal(IBKR_ES_BAR_SOURCE_VERSION),
  createdAt: utc,
  target: z.object({ dateFrom: z.literal(IBKR_ES_TARGET_FROM), dateTo: z.literal(IBKR_ES_TARGET_TO) }).strict(),
  request: requestSchema,
  rollPolicyVersion: z.literal(IBKR_ES_ROLL_POLICY_VERSION),
  calendarVersion: z.literal(IBKR_ES_CALENDAR_VERSION),
  pacing: z.object({ requestsPer10Minutes: z.number().int().min(1).max(50), maxConcurrency: z.number().int().min(1).max(2) }).strict(),
  contracts: z.array(contractSchema).length(IBKR_ES_LOCAL_SYMBOLS.length),
  estimatedHistoricalRequests: z.number().int().positive(),
  ibApiServerVersion: z.number().int().positive(),
}).strict().superRefine((spec, ctx) => {
  const symbols = spec.contracts.map((contract) => contract.localSymbol);
  if (symbols.some((symbol, index) => symbol !== IBKR_ES_LOCAL_SYMBOLS[index]))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contracts"], message: "contracts must use the exact ordered ES quarterly universe" });
  if (new Set(spec.contracts.map((contract) => contract.conId)).size !== spec.contracts.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contracts"], message: "contract conIds must be unique" });
  for (const [index, contract] of spec.contracts.entries()) {
    const expectedMonth = ["202509", "202512", "202603", "202606", "202609"][index];
    if (!contract.lastTradeDateOrContractMonth.startsWith(expectedMonth) || !contract.expiryDate.startsWith(expectedMonth))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contracts", index], message: "contract expiry does not match localSymbol month" });
    const expiryDateId = `${contract.expiryDate.slice(0, 4)}-${contract.expiryDate.slice(4, 6)}-${contract.expiryDate.slice(6, 8)}`;
    const expectedLastTradeAt = chicagoWallToUtc(expiryDateId, "08:30").toISOString();
    if (contract.lastTradeAt !== expectedLastTradeAt)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contracts", index, "lastTradeAt"], message: "lastTradeAt must equal 08:30 America/Chicago on expiryDate" });
    if (contract.fetchTo < contract.fetchFrom)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contracts", index], message: "fetchTo precedes fetchFrom" });
    if (contract.fetchFrom < spec.target.dateFrom || contract.fetchTo > spec.target.dateTo)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contracts", index], message: "fetch window exceeds target" });
    if (contract.fetchTo > contract.lastTradeAt)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contracts", index], message: "fetch window exceeds last trade" });
    const expectedFrom = index === 0
      ? spec.target.dateFrom
      : new Date(Math.max(
          new Date(spec.target.dateFrom).getTime(),
          new Date(spec.contracts[index - 1].lastTradeAt).getTime() - 15 * 86_400_000,
        )).toISOString();
    const expectedTo = new Date(Math.min(
      new Date(spec.target.dateTo).getTime(), new Date(contract.lastTradeAt).getTime(),
    )).toISOString();
    if (contract.fetchFrom !== expectedFrom || contract.fetchTo !== expectedTo)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contracts", index], message: "fetch window is not deterministically derived" });
  }
  if (spec.estimatedHistoricalRequests !== estimateHistoricalRequests(spec.contracts))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["estimatedHistoricalRequests"], message: "estimated request count is not derived from fetch windows" });
});

export type IbkrEsAcquisitionSpec = z.infer<typeof ibkrEsAcquisitionSpecSchema>;
export type IbkrEsAcquisitionContract = IbkrEsAcquisitionSpec["contracts"][number];

export function parseIbkrEsAcquisitionSpec(input: unknown): IbkrEsAcquisitionSpec {
  return ibkrEsAcquisitionSpecSchema.parse(input);
}

export function canonicalAcquisitionSpec(spec: IbkrEsAcquisitionSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

export function acquisitionSpecSha256(spec: IbkrEsAcquisitionSpec): string {
  return createHash("sha256").update(canonicalAcquisitionSpec(spec)).digest("hex");
}

export function estimateHistoricalRequests(
  contracts: readonly Pick<IbkrEsAcquisitionContract, "fetchFrom" | "fetchTo">[],
  chunkDays = 5,
): number {
  if (!Number.isInteger(chunkDays) || chunkDays <= 0) throw new Error("chunkDays must be a positive integer");
  const chunkMs = chunkDays * 86_400_000;
  return contracts.reduce((sum, contract) => {
    const span = new Date(contract.fetchTo).getTime() - new Date(contract.fetchFrom).getTime() + 60_000;
    return sum + Math.ceil(span / chunkMs);
  }, 0);
}
