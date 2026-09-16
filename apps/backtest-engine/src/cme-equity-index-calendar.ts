import type { CmeCalendarDefinition } from "./cme-session-calendar.js";
import { CME_EQUITY_INDEX_CALENDAR_V1 } from "@ikbr/shared";

export const CME_EQUITY_INDEX_2024_2026: CmeCalendarDefinition = Object.freeze({
  ...CME_EQUITY_INDEX_CALENDAR_V1,
});

export function withBuiltInResearchCalendar(
  configured: ReadonlyMap<string, CmeCalendarDefinition>,
): ReadonlyMap<string, CmeCalendarDefinition> {
  const existing = configured.get(CME_EQUITY_INDEX_2024_2026.version);
  if (existing && JSON.stringify(existing) !== JSON.stringify(CME_EQUITY_INDEX_2024_2026))
    throw new Error(`Configured calendar may not override ${CME_EQUITY_INDEX_2024_2026.version}`);
  return new Map([[CME_EQUITY_INDEX_2024_2026.version, CME_EQUITY_INDEX_2024_2026], ...configured]);
}
