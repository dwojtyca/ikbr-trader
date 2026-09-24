import type { StrategyContext } from "./strategy.types.js";

export function isWithinStrategySession(context: StrategyContext, startHour: number, endHour: number): boolean {
  const ts = new Date(context.latestCandle.ts).getTime();
  const session = context.verifiedSession;
  if (!session) {
    const hour = new Date(ts).getUTCHours();
    return hour >= startHour && hour <= endHour;
  }
  const start = Date.parse(session.start), end = Date.parse(session.end);
  return session.identity.symbol === context.symbol && String(session.identity.conId) === context.conid
    && session.identity.secType === context.secType && Number.isSafeInteger(session.generation) && session.generation > 0
    && Number.isFinite(start) && Number.isFinite(end) && start <= ts && ts + 60_000 <= end;
}

export function hasUnknownStrategyVolume(context: StrategyContext): boolean {
  return context.latestCandle.volume < 0 || Object.values(context.candlesByTimeframe).some(rows => rows?.some(c => c.volume < 0));
}
